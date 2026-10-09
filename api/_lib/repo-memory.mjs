// Repository แบบ In-memory — ใช้กับ Mock Services และชุดทดสอบเท่านั้น
// อินเทอร์เฟซเดียวกับ repo-pg.mjs; transaction ทำงานทีละรายการ (serialized) เพื่อจำลอง row lock

export function createMemoryRepo({ uuid }) {
  const db = {
    users: new Map(),      // id → { id, name, email, role, accountStatus, createdAt }
    identities: [],        // { userId, providerId, accountId }
    quota: new Map(),
    jobs: new Map(),
    uploads: new Map(),
    albums: new Map(),
    images: new Map(),
    audit: [],
    rate: new Map(),
    settings: new Map(),
    lineGroups: new Map(),
    lineOrders: [],
    orders: new Map(),
    otp: new Map(),        // request_id → { phone_hash, code_hash, attempts, expires_at, consumed_at, created_at }
  };
  let chain = Promise.resolve();
  const countGuest = (since, guestId, ipHash) => [...db.jobs.values()].filter((j) => j.guest_id && new Date(j.created_at) >= since
    && (!guestId || j.guest_id === guestId) && (!ipHash || j.guest_ip_hash === ipHash)).length;
  // ค่าใช้จ่าย AI (บาท) แบบไม่ให้ต่ำกว่าจริง — เหมือน repo-pg.mjs
  const isTest = (j) => j.input?.mode === "test";
  const countTest = () => [...db.jobs.values()].filter(isTest).length;
  const aiSpend = (since, { estimateThb, usdThb, mode = "live" }) => [...db.jobs.values()]
    .filter((j) => new Date(j.created_at) >= since && j.input?.provider && j.input.provider !== "mock" && isTest(j) === (mode === "test"))
    .reduce((sum, j) => {
      const done = (j.artwork_status === "done") + (j.mockup_status === "done");
      const spent = (j.cost_usd || 0) * usdThb + Math.max(j.attempts - done, 0) * (estimateThb / 2);
      return sum + (["completed", "failed"].includes(j.status) ? spent : Math.max(spent, estimateThb));
    }, 0);
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  const t = {
    async userExists(userId) { return db.users.has(userId); },
    async findJobByIdem(userId, key) {
      for (const j of db.jobs.values()) if (j.user_id === userId && j.idempotency_key === key) return clone(j);
      return null;
    },
    async countActiveJobs(userId) {
      return [...db.jobs.values()].filter((j) => j.user_id === userId && ["pending", "processing"].includes(j.status)).length;
    },
    async countJobsSince(date) {
      return [...db.jobs.values()].filter((j) => new Date(j.created_at) >= date).length;
    },
    async getQuotaForUpdate(userId, defaultCredits) {
      if (!db.quota.has(userId)) {
        db.quota.set(userId, { user_id: userId, free_credits_total: defaultCredits, free_credits_used: 0, reserved_credits: 0, updated_at: new Date().toISOString() });
      }
      return clone(db.quota.get(userId));
    },
    async updateQuota(userId, patch) {
      const q = { ...db.quota.get(userId), ...patch, updated_at: new Date().toISOString() };
      if (q.free_credits_used + q.reserved_credits > q.free_credits_total || q.reserved_credits < 0) throw new Error("quota constraint");
      db.quota.set(userId, q);
    },
    async insertJob(job) {
      const owner = (j) => j.user_id || `guest:${j.guest_id}`;     // 1 งานที่กำลังทำต่อสมาชิก / ต่อ Guest
      if (job.status === "pending" && [...db.jobs.values()].some((j) => owner(j) === owner(job) && ["pending", "processing"].includes(j.status))) {
        throw new Error("unique violation ai_jobs_one_active");
      }
      db.jobs.set(job.job_id, clone(job));
    },
    async getJobForUpdate(jobId) { return clone(db.jobs.get(jobId)) || null; },
    // ---------- Guest (ไม่ต้องสมัครสมาชิก) ----------
    async lockAiBudget() { /* transaction ในหน่วยความจำทำงานทีละรายการอยู่แล้ว */ },
    async findGuestJobByIdem(guestId, key) {
      for (const j of db.jobs.values()) if (j.guest_id === guestId && j.idempotency_key === key) return clone(j);
      return null;
    },
    async countGuestActiveJobs(guestId) {
      return [...db.jobs.values()].filter((j) => j.guest_id === guestId && ["pending", "processing"].includes(j.status)).length;
    },
    async countGuestJobsSince({ since, guestId, ipHash }) { return countGuest(since, guestId, ipHash); },
    async aiSpendThbSince(since, o) { return aiSpend(since, o); },
    async countTestJobs() { return countTest(); },
    async updateJob(jobId, patch) { db.jobs.set(jobId, { ...db.jobs.get(jobId), ...clone(patch) }); },
    async audit(actorId, action, target, detail) {
      db.audit.push({ event_id: uuid(), actor_id: actorId, action, target, detail, created_at: new Date().toISOString() });
    },
  };

  const repo = {
    _db: db,
    tx(fn) {
      const run = chain.then(() => fn(t));
      chain = run.catch(() => {});
      return run;
    },

    // ---------- users / quota ----------
    async getUser(id) { return clone(db.users.get(id)) || null; },
    async getQuota(userId, defaultCredits) { return repo.tx((tt) => tt.getQuotaForUpdate(userId, defaultCredits)); },
    async listUsers({ search = "", limit = 20, offset = 0 }) {
      const s = search.toLowerCase();
      const rows = [...db.users.values()]
        .filter((u) => !s || u.email.toLowerCase().includes(s) || u.name.toLowerCase().includes(s) || u.id === search)
        .slice(offset, offset + limit)
        .map((u) => ({ ...u, quota: db.quota.get(u.id) || null, providers: db.identities.filter((i) => i.userId === u.id).map((i) => i.providerId) }));
      return clone(rows);
    },
    async getJob(jobId) { return clone(db.jobs.get(jobId)) || null; },
    async listJobsByGuest(guestId, limit = 10) {
      return clone([...db.jobs.values()].filter((j) => j.guest_id === guestId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit));
    },
    async countGuestJobsSince({ since, guestId, ipHash }) { return countGuest(since, guestId, ipHash); },
    async aiSpendThbSince(since, o) { return aiSpend(since, o); },
    async countTestJobs() { return countTest(); },
    async listJobsByUser(userId, limit = 20) {
      return clone([...db.jobs.values()].filter((j) => j.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit));
    },
    async listProblemJobs(staleBefore, limit = 50) {
      return clone([...db.jobs.values()].filter((j) =>
        j.credit_state === "reserved" && (j.artwork_status === "unknown" || j.mockup_status === "unknown" || ((j.status === "processing" || j.status === "pending") && new Date(j.updated_at) < staleBefore))
      ).slice(0, limit));
    },
    async listFailedJobs(limit = 50) {
      return clone([...db.jobs.values()].filter((j) => j.status === "failed" || j.status === "partial").slice(0, limit));
    },
    async listAudit({ limit = 50, actions = null }) {
      return clone(db.audit.filter((a) => !actions || actions.includes(a.action)).slice(-limit).reverse());
    },
    async audit(actorId, action, target, detail = {}) { return t.audit(actorId, action, target, detail); },

    // ---------- customer uploads ----------
    async createUpload(row) { db.uploads.set(row.upload_id, clone(row)); },
    async getUploads(ids) { return clone(ids.map((id) => db.uploads.get(id)).filter(Boolean)); },
    async listExpiredUploads(now, limit = 200) {
      return clone([...db.uploads.values()].filter((u) => new Date(u.expires_at) < now).slice(0, limit));
    },
    async deleteUpload(id) { db.uploads.delete(id); },
    async listExpiredJobs(before, limit = 200) {
      return clone([...db.jobs.values()].filter((j) => new Date(j.created_at) < before && (j.artwork_storage_key || j.mockup_storage_key || j.artwork_original_key || j.mockup_original_key)).slice(0, limit));
    },
    async listExpiredGuestJobs(before, limit = 200) {
      return clone([...db.jobs.values()].filter((j) => j.guest_id && new Date(j.created_at) < before && (j.artwork_storage_key || j.mockup_storage_key || j.artwork_original_key || j.mockup_original_key)).slice(0, limit));
    },
    async clearJobFiles(jobId) { const j = db.jobs.get(jobId); if (j) { j.artwork_storage_key = null; j.mockup_storage_key = null; j.artwork_original_key = null; j.mockup_original_key = null; j.artwork_status = j.artwork_status === "done" ? "failed" : j.artwork_status; j.mockup_status = j.mockup_status === "done" ? "failed" : j.mockup_status; j.error_code = "expired"; } },

    // ไฟล์ private นี้เป็นของใคร (ใช้ตรวจสิทธิ์ใน /api/files)
    async findJobFile(jobId, kind) {
      const j = db.jobs.get(jobId);
      if (!j) return null;
      const key = j[`${kind}_storage_key`];
      return key ? { userId: j.user_id, guestId: j.guest_id || null, key } : null;
    },

    // ---------- gallery ----------
    async listAlbums({ publishedOnly = false, includeDeleted = false } = {}) {
      return clone([...db.albums.values()]
        .filter((a) => (includeDeleted || !a.deleted_at) && (!publishedOnly || a.is_published))
        .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
        .map((a) => ({ ...a, image_count: [...db.images.values()].filter((i) => i.album_id === a.album_id && !i.deleted_at && (!publishedOnly || i.is_published)).length })));
    },
    async getAlbum(id) { return clone(db.albums.get(id)) || null; },
    async insertAlbum(row) { db.albums.set(row.album_id, clone(row)); },
    async updateAlbum(id, patch) { db.albums.set(id, { ...db.albums.get(id), ...clone(patch) }); },
    async listImages({ albumId = null, search = "", publishedOnly = false, deleted = false, limit = 24, offset = 0 } = {}) {
      const s = search.toLowerCase();
      const rows = [...db.images.values()].filter((i) => {
        if (deleted ? !i.deleted_at : i.deleted_at) return false;
        if (albumId && i.album_id !== albumId) return false;
        if (publishedOnly) {
          const a = db.albums.get(i.album_id);
          if (!i.is_published || !a || !a.is_published || a.deleted_at) return false;
        }
        return !s || i.title.toLowerCase().includes(s) || i.alt.toLowerCase().includes(s);
      }).sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
      return { rows: clone(rows.slice(offset, offset + limit)), total: rows.length };
    },
    async getImage(id) { return clone(db.images.get(id)) || null; },
    async getPublishedImages(ids) {
      return clone(ids.map((id) => db.images.get(id)).filter((i) => {
        if (!i || i.deleted_at || !i.is_published || !i.public_url) return false;
        const a = db.albums.get(i.album_id);
        return a && a.is_published && !a.deleted_at;
      }));
    },
    async insertImage(row) { db.images.set(row.image_id, clone(row)); },
    async updateImage(id, patch) { db.images.set(id, { ...db.images.get(id), ...clone(patch) }); },
    async purgeImage(id) { db.images.delete(id); },
    async listTrashBefore(date, limit = 200) { return clone([...db.images.values()].filter((i) => i.deleted_at && new Date(i.deleted_at) < date).slice(0, limit)); },
    async setUserRole(id, role) { const u = db.users.get(id); if (u) u.role = role; },
    async countGallery() {
      const albums = [...db.albums.values()].filter((a) => !a.deleted_at).length;
      const imgs = [...db.images.values()];
      return { albums, images: imgs.filter((i) => !i.deleted_at).length, published: imgs.filter((i) => !i.deleted_at && i.is_published).length, trash: imgs.filter((i) => i.deleted_at).length };
    },

    // ---------- LINE ----------
    async getSetting(key) { return db.settings.has(key) ? db.settings.get(key).value : null; },
    async setSetting(key, value, by = null) { db.settings.set(key, { value, updated_by: by, updated_at: new Date().toISOString() }); },
    async deleteSetting(key) { db.settings.delete(key); },
    async upsertLineGroup(groupId, status) {
      const cur = db.lineGroups.get(groupId);
      db.lineGroups.set(groupId, { group_id: groupId, status, joined_at: cur ? cur.joined_at : new Date().toISOString(), updated_at: new Date().toISOString() });
    },
    async listLineGroups(limit = 20) { return clone([...db.lineGroups.values()].slice(-limit).reverse()); },
    async insertLineOrder(row) {
      if (db.lineOrders.some((o) => o.retry_key === row.retry_key)) return false;
      db.lineOrders.push(clone(row));
      return true;
    },
    async listLineOrders(jobId) { return clone(db.lineOrders.filter((o) => o.job_id === jobId)); },

    // ---------- production orders ----------
    async insertOrder(o) {
      for (const x of db.orders.values()) {
        if (x.user_id === o.user_id && x.idempotency_key === o.idempotency_key) return { order: clone(x), created: false };
        if (x.order_no === o.order_no) throw Object.assign(new Error("duplicate order_no"), { code: "23505" });
      }
      db.orders.set(o.order_id, clone(o));
      return { order: clone(o), created: true };
    },
    async getOrder(id) { return clone(db.orders.get(id)) || null; },
    async listOrdersByUser(userId, limit = 20) {
      return clone([...db.orders.values()].filter((o) => o.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit));
    },
    async listOrders({ search = "", status = "", limit = 30, offset = 0 } = {}) {
      const s = search.toLowerCase();
      const rows = [...db.orders.values()].filter((o) => {
        if (status && o.status !== status) return false;
        if (!s) return true;
        const u = db.users.get(o.user_id) || {};
        return o.order_no.toLowerCase().includes(s) || String(o.form.shopName || "").toLowerCase().includes(s) || String(u.email || "").toLowerCase().includes(s) || String(u.name || "").toLowerCase().includes(s);
      }).sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((o) => ({ ...o, customer_name: (db.users.get(o.user_id) || {}).name || "", customer_email: (db.users.get(o.user_id) || {}).email || "" }));
      return { rows: clone(rows.slice(offset, offset + limit)), total: rows.length };
    },
    async updateOrder(id, patch) { db.orders.set(id, { ...db.orders.get(id), ...clone(patch) }); },
    async getOrderByNo(orderNo) { for (const o of db.orders.values()) if (o.order_no === orderNo) return clone(o); return null; },
    async getUserLineId(userId) { const i = db.identities.find((x) => x.userId === userId && x.providerId === "line"); return i ? i.accountId : null; },
    // จองการส่งแบบ atomic: ได้สิทธิ์ส่งเพียงคำขอเดียว · ผูก LINE userId ครั้งแรก · ห้ามผู้ใช้ LINE คนอื่น
    async claimLineDelivery(orderId, lineUserId, channel, staleBefore) {
      return repo.tx(async () => {
        const o = db.orders.get(orderId);
        if (!o) return null;
        const stale = o.line_delivery_status === "sending" && new Date(o.line_delivery_updated_at) < staleBefore;
        if (!(["awaiting_customer", "failed"].includes(o.line_delivery_status) || stale)) return null;
        if (o.line_user_id && o.line_user_id !== lineUserId) return null;
        Object.assign(o, { line_delivery_status: "sending", line_user_id: o.line_user_id || lineUserId, line_delivery_channel: channel,
          line_delivery_attempts: (o.line_delivery_attempts || 0) + 1, line_delivery_updated_at: new Date().toISOString() });
        return clone(o);
      });
    },
    async finishLineDelivery(orderId, ok, error = null, requestId = null) {
      const o = db.orders.get(orderId);
      Object.assign(o, { line_delivery_status: ok ? "sent" : "failed", line_delivery_error: ok ? null : error, line_request_id: requestId,
        line_delivered_at: ok ? new Date().toISOString() : o.line_delivered_at, line_delivery_updated_at: new Date().toISOString() });
    },
    async listLineOrdersForUser(lineUserId, userId, limit = 10) {
      return clone([...db.orders.values()].filter((o) => o.line_user_id === lineUserId || (userId && o.user_id === userId))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit));
    },
    async findUserIdByLineId(lineUserId) { const i = db.identities.find((x) => x.providerId === "line" && x.accountId === lineUserId); return i ? i.userId : null; },

    // ---------- OTP เข้าสู่ระบบด้วยเบอร์โทร ----------
    async createOtpRequest(r) { db.otp.set(r.request_id, clone(r)); },
    async latestOtpRequest(phoneHash) {
      const rows = [...db.otp.values()].filter((r) => r.phone_hash === phoneHash).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return clone(rows[0] || null);
    },
    async supersedeOtpRequests(phoneHash, at) { for (const r of db.otp.values()) if (r.phone_hash === phoneHash && !r.consumed_at) r.consumed_at = at; },
    async countOtpSince(since) { return [...db.otp.values()].filter((r) => r.created_at >= since).length; },
    async deleteOtpRequest(id) { db.otp.delete(id); },
    async bumpOtpAttempt(id, maxAttempts, at) {
      const r = db.otp.get(id);
      if (!r || r.consumed_at || r.expires_at <= at || r.attempts >= maxAttempts) return null;
      r.attempts += 1;
      return clone(r);
    },
    async consumeOtpRequest(id, at) {
      const r = db.otp.get(id);
      if (!r || r.consumed_at) return false;
      r.consumed_at = at;
      return true;
    },
    async deleteOtpRequestsBefore(date) { for (const [k, r] of db.otp) if (r.created_at < date) db.otp.delete(k); },
    // (Mock) ผู้ใช้ที่เข้าสู่ระบบด้วยเบอร์โทร — ในระบบจริง Better Auth จัดการตาราง user เอง
    async findUserByPhone(phone) { for (const u of db.users.values()) if (u.phoneNumber === phone) return clone(u); return null; },

    // ---------- rate limit ----------
    async hitRateLimit(key, limit, windowSec, now = Date.now()) {
      const cur = db.rate.get(key);
      if (!cur || now - cur.start >= windowSec * 1000) {
        db.rate.set(key, { start: now, count: 1 });
        return true;
      }
      cur.count += 1;
      return cur.count <= limit;
    },
  };
  return repo;
}
