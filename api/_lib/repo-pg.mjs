// Repository บน Neon Postgres (@neondatabase/serverless) — อินเทอร์เฟซเดียวกับ repo-memory.mjs
// ทุกคำสั่งใช้ parameter ($1, $2 …) เท่านั้น; ชื่อคอลัมน์ที่ต่อ string มาจาก whitelist ภายใน

const JOB_COLS = ["status", "artwork_status", "mockup_status", "artwork_storage_key", "mockup_storage_key", "credit_state", "attempts", "error_code", "updated_at"];
const QUOTA_COLS = ["free_credits_total", "free_credits_used", "reserved_credits"];
const ALBUM_COLS = ["title", "description", "cover_image_id", "sort_order", "is_published", "updated_by", "updated_at", "deleted_at"];
const IMAGE_COLS = ["album_id", "title", "alt", "sort_order", "is_published", "public_url", "public_thumb_url", "public_key", "public_thumb_key", "updated_by", "updated_at", "deleted_at"];

function setClause(patch, allowed, startIndex) {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) throw new Error("empty patch");
  return { sql: keys.map((k, i) => `${k} = $${startIndex + i}`).join(", "), values: keys.map((k) => patch[k]) };
}

export function createPgRepo({ Pool, connectionString, uuid }) {
  const pool = new Pool({ connectionString });
  const q = async (sql, params = [], client = pool) => (await client.query(sql, params)).rows;

  const txApi = (c) => ({
    async userExists(userId) { return (await q(`SELECT 1 FROM "user" WHERE "id" = $1`, [userId], c)).length > 0; },
    async findJobByIdem(userId, key) { return (await q(`SELECT * FROM ai_jobs WHERE user_id = $1 AND idempotency_key = $2`, [userId, key], c))[0] || null; },
    async countActiveJobs(userId) { return Number((await q(`SELECT count(*) FROM ai_jobs WHERE user_id = $1 AND status IN ('pending','processing')`, [userId], c))[0].count); },
    async countJobsSince(date) { return Number((await q(`SELECT count(*) FROM ai_jobs WHERE created_at >= $1`, [date], c))[0].count); },
    async getQuotaForUpdate(userId, defaultCredits) {
      await q(`INSERT INTO ai_quota (user_id, free_credits_total) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, defaultCredits], c);
      return (await q(`SELECT * FROM ai_quota WHERE user_id = $1 FOR UPDATE`, [userId], c))[0];
    },
    async updateQuota(userId, patch) {
      const s = setClause(patch, QUOTA_COLS, 2);
      await q(`UPDATE ai_quota SET ${s.sql}, updated_at = now() WHERE user_id = $1`, [userId, ...s.values], c);
    },
    async insertJob(j) {
      await q(`INSERT INTO ai_jobs (job_id, user_id, idempotency_key, status, artwork_status, mockup_status, credit_state, attempts, input, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [j.job_id, j.user_id, j.idempotency_key, j.status, j.artwork_status, j.mockup_status, j.credit_state, j.attempts, JSON.stringify(j.input), j.created_at, j.updated_at], c);
    },
    async getJobForUpdate(jobId) { return (await q(`SELECT * FROM ai_jobs WHERE job_id = $1 FOR UPDATE`, [jobId], c))[0] || null; },
    async updateJob(jobId, patch) {
      const s = setClause(patch, JOB_COLS, 2);
      await q(`UPDATE ai_jobs SET ${s.sql} WHERE job_id = $1`, [jobId, ...s.values], c);
    },
    async audit(actorId, action, target, detail = {}) {
      await q(`INSERT INTO audit_logs (event_id, actor_id, action, target, detail) VALUES ($1,$2,$3,$4,$5)`, [uuid(), actorId, action, target, JSON.stringify(detail)], c);
    },
  });

  const repo = {
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(txApi(client));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    // ---------- users / quota ----------
    async getUser(id) { return (await q(`SELECT "id","name","email","role","accountStatus","createdAt" FROM "user" WHERE "id" = $1`, [id]))[0] || null; },
    async getQuota(userId, defaultCredits) { return repo.tx((t) => t.getQuotaForUpdate(userId, defaultCredits)); },
    async listUsers({ search = "", limit = 20, offset = 0 }) {
      return q(`SELECT u."id", u."name", u."email", u."role", u."accountStatus", u."createdAt",
                       row_to_json(qt) AS quota,
                       COALESCE((SELECT array_agg(a."providerId") FROM "account" a WHERE a."userId" = u."id"), '{}') AS providers
                FROM "user" u LEFT JOIN ai_quota qt ON qt.user_id = u."id"
                WHERE $1 = '' OR u."email" ILIKE '%' || $1 || '%' OR u."name" ILIKE '%' || $1 || '%' OR u."id" = $1
                ORDER BY u."createdAt" DESC LIMIT $2 OFFSET $3`, [search, limit, offset]);
    },
    async getJob(jobId) { return (await q(`SELECT * FROM ai_jobs WHERE job_id = $1`, [jobId]))[0] || null; },
    async listJobsByUser(userId, limit = 20) { return q(`SELECT * FROM ai_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]); },
    async listProblemJobs(staleBefore, limit = 50) {
      return q(`SELECT * FROM ai_jobs WHERE credit_state = 'reserved'
                AND (artwork_status = 'unknown' OR mockup_status = 'unknown' OR (status IN ('pending','processing') AND updated_at < $1))
                ORDER BY updated_at LIMIT $2`, [staleBefore, limit]);
    },
    async listFailedJobs(limit = 50) { return q(`SELECT * FROM ai_jobs WHERE status IN ('failed','partial') ORDER BY updated_at DESC LIMIT $1`, [limit]); },
    async listAudit({ limit = 50, actions = null }) {
      return actions
        ? q(`SELECT * FROM audit_logs WHERE action = ANY($1) ORDER BY created_at DESC LIMIT $2`, [actions, limit])
        : q(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
    },
    async audit(actorId, action, target, detail = {}) { return txApi(pool).audit(actorId, action, target, detail); },

    // ---------- customer uploads ----------
    async createUpload(u) {
      await q(`INSERT INTO customer_uploads (upload_id, user_id, kind, storage_key, mime, size_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.upload_id, u.user_id, u.kind, u.storage_key, u.mime, u.size_bytes, u.created_at, u.expires_at]);
    },
    async getUploads(ids) { return ids.length ? q(`SELECT * FROM customer_uploads WHERE upload_id = ANY($1)`, [ids]) : []; },
    async listExpiredUploads(now, limit = 200) { return q(`SELECT * FROM customer_uploads WHERE expires_at < $1 LIMIT $2`, [now, limit]); },
    async deleteUpload(id) { await q(`DELETE FROM customer_uploads WHERE upload_id = $1`, [id]); },
    async listExpiredJobs(before, limit = 200) {
      return q(`SELECT * FROM ai_jobs WHERE created_at < $1 AND (artwork_storage_key IS NOT NULL OR mockup_storage_key IS NOT NULL) LIMIT $2`, [before, limit]);
    },
    async clearJobFiles(jobId) {
      await q(`UPDATE ai_jobs SET artwork_storage_key = NULL, mockup_storage_key = NULL,
               artwork_status = CASE WHEN artwork_status = 'done' THEN 'failed' ELSE artwork_status END,
               mockup_status = CASE WHEN mockup_status = 'done' THEN 'failed' ELSE mockup_status END,
               error_code = 'expired', updated_at = now() WHERE job_id = $1`, [jobId]);
    },
    async findJobFile(jobId, kind) {
      if (!["artwork", "mockup"].includes(kind)) return null;
      const row = (await q(`SELECT user_id, ${kind}_storage_key AS key FROM ai_jobs WHERE job_id = $1`, [jobId]))[0];
      return row && row.key ? { userId: row.user_id, key: row.key } : null;
    },

    // ---------- gallery ----------
    async listAlbums({ publishedOnly = false, includeDeleted = false } = {}) {
      return q(`SELECT a.*, (SELECT count(*)::int FROM gallery_images i WHERE i.album_id = a.album_id AND i.deleted_at IS NULL AND ($1 = false OR i.is_published)) AS image_count
                FROM gallery_albums a
                WHERE ($2 OR a.deleted_at IS NULL) AND ($1 = false OR a.is_published)
                ORDER BY a.sort_order, a.created_at`, [publishedOnly, includeDeleted]);
    },
    async getAlbum(id) { return (await q(`SELECT * FROM gallery_albums WHERE album_id = $1`, [id]))[0] || null; },
    async insertAlbum(a) {
      await q(`INSERT INTO gallery_albums (album_id, title, description, sort_order, is_published, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [a.album_id, a.title, a.description, a.sort_order, a.is_published, a.created_by]);
    },
    async updateAlbum(id, patch) {
      const s = setClause(patch, ALBUM_COLS, 2);
      await q(`UPDATE gallery_albums SET ${s.sql} WHERE album_id = $1`, [id, ...s.values]);
    },
    async listImages({ albumId = null, search = "", publishedOnly = false, deleted = false, limit = 24, offset = 0 } = {}) {
      const where = `($1::text IS NULL OR i.album_id = $1)
        AND ($2 = '' OR i.title ILIKE '%' || $2 || '%' OR i.alt ILIKE '%' || $2 || '%')
        AND (CASE WHEN $3 THEN i.deleted_at IS NOT NULL ELSE i.deleted_at IS NULL END)
        AND ($4 = false OR (i.is_published AND a.is_published AND a.deleted_at IS NULL))`;
      const params = [albumId, search, deleted, publishedOnly];
      const rows = await q(`SELECT i.* FROM gallery_images i JOIN gallery_albums a ON a.album_id = i.album_id WHERE ${where}
                            ORDER BY i.sort_order, i.created_at LIMIT $5 OFFSET $6`, [...params, limit, offset]);
      const total = Number((await q(`SELECT count(*) FROM gallery_images i JOIN gallery_albums a ON a.album_id = i.album_id WHERE ${where}`, params))[0].count);
      return { rows, total };
    },
    async getImage(id) { return (await q(`SELECT * FROM gallery_images WHERE image_id = $1`, [id]))[0] || null; },
    async getPublishedImages(ids) {
      if (!ids.length) return [];
      return q(`SELECT i.* FROM gallery_images i JOIN gallery_albums a ON a.album_id = i.album_id
                WHERE i.image_id = ANY($1) AND i.deleted_at IS NULL AND i.is_published AND i.public_url IS NOT NULL
                AND a.is_published AND a.deleted_at IS NULL`, [ids]);
    },
    async insertImage(r) {
      await q(`INSERT INTO gallery_images (image_id, album_id, private_key, private_thumb_key, title, alt, width, height, sort_order, is_published, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$10)`,
        [r.image_id, r.album_id, r.private_key, r.private_thumb_key, r.title, r.alt, r.width, r.height, r.sort_order, r.created_by]);
    },
    async updateImage(id, patch) {
      const s = setClause(patch, IMAGE_COLS, 2);
      await q(`UPDATE gallery_images SET ${s.sql} WHERE image_id = $1`, [id, ...s.values]);
    },
    async purgeImage(id) { await q(`DELETE FROM gallery_images WHERE image_id = $1`, [id]); },
    async listTrashBefore(date, limit = 200) { return q(`SELECT * FROM gallery_images WHERE deleted_at IS NOT NULL AND deleted_at < $1 LIMIT $2`, [date, limit]); },
    async setUserRole(id, role) { await q(`UPDATE "user" SET "role" = $2, "updatedAt" = now() WHERE "id" = $1`, [id, role]); },
    async countGallery() {
      const r = (await q(`SELECT
        (SELECT count(*)::int FROM gallery_albums WHERE deleted_at IS NULL) AS albums,
        (SELECT count(*)::int FROM gallery_images WHERE deleted_at IS NULL) AS images,
        (SELECT count(*)::int FROM gallery_images WHERE deleted_at IS NULL AND is_published) AS published,
        (SELECT count(*)::int FROM gallery_images WHERE deleted_at IS NOT NULL) AS trash`))[0];
      return r;
    },

    // ---------- LINE ----------
    async getSetting(key) { return (await q(`SELECT value FROM app_settings WHERE key = $1`, [key]))[0]?.value ?? null; },
    async setSetting(key, value, by = null) {
      await q(`INSERT INTO app_settings (key, value, updated_by) VALUES ($1,$2,$3)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, value, by]);
    },
    async deleteSetting(key) { await q(`DELETE FROM app_settings WHERE key = $1`, [key]); },
    async upsertLineGroup(groupId, status) {
      await q(`INSERT INTO line_groups (group_id, status) VALUES ($1,$2)
               ON CONFLICT (group_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`, [groupId, status]);
    },
    async listLineGroups(limit = 20) { return q(`SELECT * FROM line_groups ORDER BY updated_at DESC LIMIT $1`, [limit]); },
    async insertLineOrder(o) {
      const rows = await q(`INSERT INTO line_orders (order_id, job_id, group_id, retry_key, sent_by) VALUES ($1,$2,$3,$4,$5)
                            ON CONFLICT (retry_key) DO NOTHING RETURNING order_id`, [o.order_id, o.job_id, o.group_id, o.retry_key, o.sent_by]);
      return rows.length > 0;
    },
    async listLineOrders(jobId) { return q(`SELECT * FROM line_orders WHERE job_id = $1 ORDER BY created_at`, [jobId]); },

    // ---------- production orders ----------
    async insertOrder(o) {
      const rows = await q(`INSERT INTO production_orders (order_id, order_no, user_id, job_id, idempotency_key, form, price_estimate, claim_code, created_at, updated_at)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
                            ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
        [o.order_id, o.order_no, o.user_id, o.job_id, o.idempotency_key, JSON.stringify(o.form), o.price_estimate, o.claim_code, o.created_at]);
      if (rows[0]) return { order: rows[0], created: true };
      const existing = (await q(`SELECT * FROM production_orders WHERE user_id = $1 AND idempotency_key = $2`, [o.user_id, o.idempotency_key]))[0];
      return { order: existing, created: false };
    },
    async getOrder(id) { return (await q(`SELECT * FROM production_orders WHERE order_id = $1`, [id]))[0] || null; },
    async listOrdersByUser(userId, limit = 20) { return q(`SELECT * FROM production_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]); },
    async listOrders({ search = "", status = "", limit = 30, offset = 0 } = {}) {
      const where = `($1 = '' OR o.status = $1) AND ($2 = '' OR o.order_no ILIKE '%' || $2 || '%' OR o.form->>'shopName' ILIKE '%' || $2 || '%'
                     OR u."email" ILIKE '%' || $2 || '%' OR u."name" ILIKE '%' || $2 || '%')`;
      const rows = await q(`SELECT o.*, u."name" AS customer_name, u."email" AS customer_email FROM production_orders o JOIN "user" u ON u."id" = o.user_id
                            WHERE ${where} ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`, [status, search, limit, offset]);
      const total = Number((await q(`SELECT count(*) FROM production_orders o JOIN "user" u ON u."id" = o.user_id WHERE ${where}`, [status, search]))[0].count);
      return { rows, total };
    },
    async getOrderByNo(orderNo) { return (await q(`SELECT * FROM production_orders WHERE order_no = $1`, [orderNo]))[0] || null; },
    async getUserLineId(userId) { return (await q(`SELECT "accountId" FROM "account" WHERE "userId" = $1 AND "providerId" = 'line' LIMIT 1`, [userId]))[0]?.accountId ?? null; },
    async findUserIdByLineId(lineUserId) { return (await q(`SELECT "userId" FROM "account" WHERE "providerId" = 'line' AND "accountId" = $1 LIMIT 1`, [lineUserId]))[0]?.userId ?? null; },
    async claimLineDelivery(orderId, lineUserId, channel, staleBefore) {
      return (await q(`UPDATE production_orders SET line_delivery_status = 'sending', line_user_id = COALESCE(line_user_id, $2),
                         line_delivery_channel = $3, line_delivery_attempts = line_delivery_attempts + 1, line_delivery_updated_at = now()
                       WHERE order_id = $1 AND (line_user_id IS NULL OR line_user_id = $2)
                         AND (line_delivery_status IN ('awaiting_customer', 'failed') OR (line_delivery_status = 'sending' AND line_delivery_updated_at < $4))
                       RETURNING *`, [orderId, lineUserId, channel, staleBefore]))[0] || null;
    },
    async finishLineDelivery(orderId, ok, error = null, requestId = null) {
      await q(`UPDATE production_orders SET line_delivery_status = $2, line_delivery_error = $3, line_request_id = $4,
                 line_delivered_at = CASE WHEN $2 = 'sent' THEN now() ELSE line_delivered_at END, line_delivery_updated_at = now()
               WHERE order_id = $1`, [orderId, ok ? "sent" : "failed", ok ? null : error, requestId]);
    },
    async listLineOrdersForUser(lineUserId, userId, limit = 10) {
      return q(`SELECT * FROM production_orders WHERE line_user_id = $1 OR ($2::text IS NOT NULL AND user_id = $2) ORDER BY created_at DESC LIMIT $3`, [lineUserId, userId, limit]);
    },
    async updateOrder(id, patch) {
      const s = setClause(patch, ["status", "staff_note", "updated_by", "updated_at"], 2);
      await q(`UPDATE production_orders SET ${s.sql} WHERE order_id = $1`, [id, ...s.values]);
    },

    // ---------- rate limit (แชร์ระหว่าง instances) ----------
    async hitRateLimit(key, limit, windowSec) {
      const row = (await q(`INSERT INTO app_rate_limits (key, window_start, count) VALUES ($1, now(), 1)
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN app_rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE app_rate_limits.count + 1 END,
          window_start = CASE WHEN app_rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE app_rate_limits.window_start END
        RETURNING count`, [key, windowSec]))[0];
      return row.count <= limit;
    },
  };
  return repo;
}
