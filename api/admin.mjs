// /api/admin?action=… — หลังบ้านพนักงาน (ตรวจ Session + Role ฝั่ง Server ทุกคำขอ)
//   staff: จัดการอัลบั้ม/รูป, ดูสิทธิ์และงาน AI
//   admin: เพิ่มสิทธิ์ AI, ปิดงานค้าง, ลบรูปถาวร, ตั้งสิทธิ์พนักงาน
import { route } from "./_lib/route.mjs";
import { sendJson, readJson, query, HttpError, assertSameOrigin, cleanText, isId } from "./_lib/http.mjs";
import { need, requireStaff, rateLimit, staffGroup, maskId } from "./_lib/context.mjs";
import { generateBindCode, hashCode, signedFileUrl, buildOrderMessages, BIND_CODE_TTL_MS, signingSecretOk } from "./_lib/line.mjs";
import { orderView, STATUSES } from "./_lib/orders.mjs";
import { decodeImage, LIMITS } from "./_lib/images.mjs";
import { grantCredits, resolveJob, jobView, quotaView, STALE_MS } from "./_lib/jobs.mjs";

const PAGE = 30;
const adminOnly = (user) => { if (user.role !== "admin") throw new HttpError(403, "forbidden"); };
const groupEnabled = (ctx) => { if (!ctx.config.lineGroupOrdersEnabled) throw new HttpError(403, "feature_disabled"); };
const nowIso = () => new Date().toISOString();

function imageView(i) {
  return {
    id: i.image_id, albumId: i.album_id, title: i.title, alt: i.alt, width: i.width, height: i.height,
    sortOrder: i.sort_order, published: i.is_published, deletedAt: i.deleted_at,
    thumbUrl: `/api/files?gallery=${i.image_id}&thumb=1`, fullUrl: `/api/files?gallery=${i.image_id}`,
    publicUrl: i.public_url || null, updatedAt: i.updated_at,
  };
}
const albumView = (a) => ({ id: a.album_id, title: a.title, description: a.description, coverImageId: a.cover_image_id, sortOrder: a.sort_order, published: a.is_published, imageCount: a.image_count ?? null, updatedAt: a.updated_at });

async function getImageOr404(ctx, id) {
  if (!isId(id)) throw new HttpError(400, "bad_request");
  const img = await ctx.repo.getImage(id);
  if (!img) throw new HttpError(404, "not_found");
  return img;
}
async function getAlbumOr404(ctx, id) {
  if (!isId(id)) throw new HttpError(400, "bad_request");
  const a = await ctx.repo.getAlbum(id);
  if (!a || a.deleted_at) throw new HttpError(404, "not_found");
  return a;
}

// เผยแพร่ = คัดลอกจาก Private → Public; ซ่อน/ลบ = ลบสำเนา Public ออก
async function publish(ctx, img, user) {
  if (img.public_url) return;
  const [main, thumb] = await Promise.all([ctx.storage.getPrivate(img.private_key), ctx.storage.getPrivate(img.private_thumb_key)]);
  const ext = (m) => (m === "image/png" ? "png" : m === "image/webp" ? "webp" : "jpg");
  const pm = await ctx.storage.putPublic(`gallery/${img.image_id}.${ext(main.mime)}`, main.bytes, main.mime);
  const pt = await ctx.storage.putPublic(`gallery/${img.image_id}-thumb.${ext(thumb.mime)}`, thumb.bytes, thumb.mime);
  await ctx.repo.updateImage(img.image_id, { is_published: true, public_url: pm.url, public_key: pm.key, public_thumb_url: pt.url, public_thumb_key: pt.key, updated_by: user.id, updated_at: nowIso() });
}
async function unpublish(ctx, img, user, extra = {}) {
  if (img.public_key) await ctx.storage.delPublic(img.public_key).catch(() => {});
  if (img.public_thumb_key) await ctx.storage.delPublic(img.public_thumb_key).catch(() => {});
  await ctx.repo.updateImage(img.image_id, { is_published: false, public_url: null, public_key: null, public_thumb_url: null, public_thumb_key: null, updated_by: user.id, updated_at: nowIso(), ...extra });
}

const GET = {
  async dashboard(ctx) {
    const [counts, problems] = await Promise.all([ctx.repo.countGallery(), ctx.repo.listProblemJobs(new Date(Date.now() - STALE_MS))]);
    return { ...counts, problemJobs: problems.length };
  },
  async albums(ctx) { return { albums: (await ctx.repo.listAlbums({})).map(albumView) }; },
  async images(ctx, q) {
    const page = Math.max(0, Number.parseInt(q.page || "0", 10) || 0);
    if (q.album && !isId(q.album)) throw new HttpError(400, "bad_request");
    const { rows, total } = await ctx.repo.listImages({ albumId: q.album || null, search: cleanText(q.search, 80), deleted: q.trash === "1", limit: PAGE, offset: page * PAGE });
    return { images: rows.map(imageView), total, page, hasMore: (page + 1) * PAGE < total };
  },
  async users(ctx, q) {
    const page = Math.max(0, Number.parseInt(q.page || "0", 10) || 0);
    const rows = await ctx.repo.listUsers({ search: cleanText(q.search, 120), limit: 20, offset: page * 20 });
    return { users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, accountStatus: u.accountStatus, createdAt: u.createdAt, providers: u.providers || [], quota: u.quota ? quotaView(u.quota) : null })) };
  },
  async userJobs(ctx, q) {
    if (!isId(q.user)) throw new HttpError(400, "bad_request");
    return { jobs: (await ctx.repo.listJobsByUser(q.user, 50)).map((j) => ({ ...jobView(j), creditState: j.credit_state, attempts: j.attempts })) };
  },
  async problemJobs(ctx) {
    const [stuck, failed] = await Promise.all([ctx.repo.listProblemJobs(new Date(Date.now() - STALE_MS)), ctx.repo.listFailedJobs(50)]);
    const v = (j) => ({ ...jobView(j), userId: j.user_id, creditState: j.credit_state, attempts: j.attempts, updatedAt: j.updated_at });
    return { stuck: stuck.map(v), failed: failed.map(v) };
  },
  async orders(ctx, q) {
    const page = Math.max(0, Number.parseInt(q.page || "0", 10) || 0);
    const status = STATUSES.includes(q.status) ? q.status : "";
    const { rows, total } = await ctx.repo.listOrders({ search: cleanText(q.search, 80), status, limit: PAGE, offset: page * PAGE });
    return { orders: rows.map((o) => ({ ...orderView(o), customer: { name: o.customer_name, email: o.customer_email } })), total, page, hasMore: (page + 1) * PAGE < total };
  },
  async order(ctx, q) {
    if (!isId(q.id)) throw new HttpError(400, "bad_request");
    const o = await ctx.repo.getOrder(q.id);
    if (!o) throw new HttpError(404, "not_found");
    const [customer, job] = await Promise.all([ctx.repo.getUser(o.user_id), o.job_id ? ctx.repo.getJob(o.job_id) : null]);
    return {
      order: { ...orderView(o, { lineText: true, oaId: ctx.config.lineOaId }), customer: customer ? { id: customer.id, name: customer.name, email: customer.email } : null },
      job: job ? jobView(job) : null,      // รูป Artwork/Mockup เปิดผ่าน /api/files (พนักงานเท่านั้น)
    };
  },
  async lineStatus(ctx) {
    const group = await staffGroup(ctx);
    const raw = await ctx.repo.getSetting("line_bind_code");
    const code = raw ? JSON.parse(raw) : null;
    return {
      groupOrdersEnabled: ctx.config.lineGroupOrdersEnabled,
      oaReplyReady: Boolean(ctx.config.lineChannelSecret && ctx.line),
      liffReady: Boolean(ctx.config.liffId && ctx.config.liffChannelId),
      imageLinksReady: signingSecretOk(ctx.config.fileSigningSecret),
      oaId: ctx.config.lineOaId,
      webhookReady: Boolean(ctx.config.lineChannelSecret),
      pushReady: Boolean(ctx.line),
      mock: Boolean(ctx.line && ctx.line.mock),
      staffGroup: group ? { id: maskId(group.groupId), source: group.source } : null,
      bindCodeExpiresAt: code && code.exp > Date.now() ? new Date(code.exp).toISOString() : null,
      groups: (await ctx.repo.listLineGroups(10)).map((g) => ({ id: maskId(g.group_id), status: g.status, updatedAt: g.updated_at })),
    };
  },
  async jobOrders(ctx, q) {
    if (!isId(q.job)) throw new HttpError(400, "bad_request");
    return { orders: (await ctx.repo.listLineOrders(q.job)).map((o) => ({ orderId: o.order_id, sentBy: o.sent_by, createdAt: o.created_at, group: maskId(o.group_id) })) };
  },
  async audit(ctx, q) {
    const actions = q.type === "credits" ? ["ai_credits_granted", "ai_job_refund", "ai_job_close", "role_changed"] : null;
    return { events: await ctx.repo.listAudit({ limit: 100, actions }) };
  },
};

const POST = {
  async createAlbum(ctx, b, user) {
    const title = cleanText(b.title, 120);
    if (!title) throw new HttpError(400, "bad_request");
    const row = { album_id: ctx.uuid(), title, description: cleanText(b.description, 1000), sort_order: Number.parseInt(b.sortOrder, 10) || 0, is_published: false, created_by: user.id, updated_by: user.id, created_at: nowIso(), updated_at: nowIso(), deleted_at: null, cover_image_id: null };
    await ctx.repo.insertAlbum(row);
    await ctx.repo.audit(user.id, "album_created", row.album_id, { title });
    return { album: albumView(row) };
  },
  async updateAlbum(ctx, b, user) {
    const a = await getAlbumOr404(ctx, b.id);
    const patch = { updated_by: user.id, updated_at: nowIso() };
    if (b.title !== undefined) { patch.title = cleanText(b.title, 120); if (!patch.title) throw new HttpError(400, "bad_request"); }
    if (b.description !== undefined) patch.description = cleanText(b.description, 1000);
    if (b.sortOrder !== undefined) patch.sort_order = Number.parseInt(b.sortOrder, 10) || 0;
    if (b.published !== undefined) patch.is_published = Boolean(b.published);
    if (b.coverImageId !== undefined) {
      const img = await getImageOr404(ctx, b.coverImageId);
      if (img.album_id !== a.album_id || img.deleted_at) throw new HttpError(400, "bad_request");
      patch.cover_image_id = img.image_id;
    }
    await ctx.repo.updateAlbum(a.album_id, patch);
    await ctx.repo.audit(user.id, "album_updated", a.album_id, { fields: Object.keys(patch) });
    return { album: albumView({ ...a, ...patch }) };
  },
  async deleteAlbum(ctx, b, user) {
    const a = await getAlbumOr404(ctx, b.id);
    const { total } = await ctx.repo.listImages({ albumId: a.album_id, limit: 1 });
    if (total > 0) throw new HttpError(409, "bad_request");     // ต้องย้าย/ลบรูปออกก่อน
    await ctx.repo.updateAlbum(a.album_id, { deleted_at: nowIso(), is_published: false, updated_by: user.id, updated_at: nowIso() });
    await ctx.repo.audit(user.id, "album_deleted", a.album_id, {});
    return { ok: true };
  },
  async uploadImage(ctx, b, user) {
    need(ctx, "storage");
    await rateLimit(ctx, `admin-upload:${user.id}`, 300, 3600);
    const album = await getAlbumOr404(ctx, b.albumId);
    const main = decodeImage(b.data, LIMITS.galleryBytes);
    const thumb = decodeImage(b.thumb, LIMITS.thumbBytes);
    const id = ctx.uuid();
    // เก็บต้นฉบับแบบ Private ก่อน — จะคัดลอกไป Public เมื่อกดเผยแพร่เท่านั้น
    const privateKey = await ctx.storage.putPrivate(`gallery/${album.album_id}/${id}.${main.ext}`, main.bytes, main.mime);
    const privateThumb = await ctx.storage.putPrivate(`gallery/${album.album_id}/${id}-thumb.${thumb.ext}`, thumb.bytes, thumb.mime);
    const row = { image_id: id, album_id: album.album_id, private_key: privateKey, private_thumb_key: privateThumb, title: cleanText(b.title, 160), alt: cleanText(b.alt, 300), width: main.width, height: main.height, sort_order: Number.parseInt(b.sortOrder, 10) || 0, is_published: false, created_by: user.id, updated_by: user.id, created_at: nowIso(), updated_at: nowIso(), deleted_at: null, public_url: null, public_thumb_url: null, public_key: null, public_thumb_key: null };
    await ctx.repo.insertImage(row);
    await ctx.repo.audit(user.id, "image_uploaded", id, { albumId: album.album_id });
    return { image: imageView(row) };
  },
  async updateImage(ctx, b, user) {
    const img = await getImageOr404(ctx, b.id);
    if (img.deleted_at) throw new HttpError(409, "bad_request");
    const patch = { updated_by: user.id, updated_at: nowIso() };
    if (b.title !== undefined) patch.title = cleanText(b.title, 160);
    if (b.alt !== undefined) patch.alt = cleanText(b.alt, 300);
    if (b.sortOrder !== undefined) patch.sort_order = Number.parseInt(b.sortOrder, 10) || 0;
    if (b.albumId !== undefined && b.albumId !== img.album_id) patch.album_id = (await getAlbumOr404(ctx, b.albumId)).album_id;
    await ctx.repo.updateImage(img.image_id, patch);
    await ctx.repo.audit(user.id, patch.album_id ? "image_moved" : "image_updated", img.image_id, { fields: Object.keys(patch) });
    return { image: imageView({ ...img, ...patch }) };
  },
  async publishImage(ctx, b, user) {
    need(ctx, "storage");
    const img = await getImageOr404(ctx, b.id);
    if (img.deleted_at) throw new HttpError(409, "bad_request");
    if (b.published) await publish(ctx, img, user);
    else await unpublish(ctx, img, user);
    await ctx.repo.audit(user.id, b.published ? "image_published" : "image_hidden", img.image_id, {});
    return { image: imageView(await ctx.repo.getImage(img.image_id)) };
  },
  async deleteImage(ctx, b, user) {   // Soft delete → ถังขยะ (กู้คืนได้)
    need(ctx, "storage");
    const img = await getImageOr404(ctx, b.id);
    await unpublish(ctx, img, user, { deleted_at: nowIso() });
    await ctx.repo.audit(user.id, "image_trashed", img.image_id, {});
    return { ok: true };
  },
  async restoreImage(ctx, b, user) {
    const img = await getImageOr404(ctx, b.id);
    await ctx.repo.updateImage(img.image_id, { deleted_at: null, updated_by: user.id, updated_at: nowIso() });
    await ctx.repo.audit(user.id, "image_restored", img.image_id, {});
    return { ok: true };
  },
  async purgeImage(ctx, b, user) {    // ลบถาวร (admin)
    adminOnly(user);
    need(ctx, "storage");
    const img = await getImageOr404(ctx, b.id);
    if (!img.deleted_at) throw new HttpError(409, "bad_request");
    await ctx.storage.delPrivate(img.private_key).catch(() => {});
    await ctx.storage.delPrivate(img.private_thumb_key).catch(() => {});
    await ctx.repo.purgeImage(img.image_id);
    await ctx.repo.audit(user.id, "image_purged", img.image_id, {});
    return { ok: true };
  },
  async grantCredits(ctx, b, user) {
    adminOnly(user);
    if (!isId(b.userId)) throw new HttpError(400, "bad_request");
    const quota = await grantCredits({ repo: ctx.repo, actorId: user.id, userId: b.userId, amount: b.amount, note: b.note, defaultCredits: ctx.config.defaultCredits });
    return { quota };
  },
  async resolveJob(ctx, b, user) {
    adminOnly(user);
    if (!isId(b.jobId)) throw new HttpError(400, "bad_request");
    const job = await resolveJob({ repo: ctx.repo, actorId: user.id, jobId: b.jobId, action: b.resolution });
    return { job: jobView(job) };
  },
  async updateOrder(ctx, b, user) {
    if (!isId(b.id)) throw new HttpError(400, "bad_request");
    const o = await ctx.repo.getOrder(b.id);
    if (!o) throw new HttpError(404, "not_found");
    const patch = { updated_by: user.id, updated_at: nowIso() };
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw new HttpError(400, "bad_request"); patch.status = b.status; }
    if (b.staffNote !== undefined) patch.staff_note = cleanText(b.staffNote, 1000);
    await ctx.repo.updateOrder(o.order_id, patch);
    await ctx.repo.audit(user.id, "order_updated", o.order_no, { status: patch.status });
    return { order: orderView({ ...o, ...patch }) };
  },
  // ---------- LINE (ระบบกลุ่มพนักงาน — ปิดไว้ เว้นแต่ LINE_GROUP_ORDERS_ENABLED=true) ----------
  async createBindCode(ctx, b, user) {      // รหัสผูกกลุ่มพนักงาน: แสดงครั้งเดียว เก็บเฉพาะ hash, หมดอายุ 10 นาที
    groupEnabled(ctx);
    adminOnly(user);
    const code = generateBindCode();
    const exp = Date.now() + BIND_CODE_TTL_MS;
    await ctx.repo.setSetting("line_bind_code", JSON.stringify({ hash: hashCode(code), exp, createdBy: user.id }), user.id);
    await ctx.repo.audit(user.id, "line_bind_code_created", null, {});
    return { code, expiresAt: new Date(exp).toISOString(), instruction: `เชิญบอท LINE ของร้านเข้ากลุ่มพนักงาน แล้วพิมพ์ในกลุ่ม: ผูกกลุ่ม ${code}` };
  },
  async unbindGroup(ctx, b, user) {
    groupEnabled(ctx);
    adminOnly(user);
    await ctx.repo.deleteSetting("line_staff_group_id");
    await ctx.repo.audit(user.id, "line_group_unbound", null, {});
    return { ok: true };
  },
  async sendProductionOrder(ctx, b, user) {  // พนักงานยืนยันคำสั่งผลิต → ส่งเข้ากลุ่ม LINE พนักงาน
    groupEnabled(ctx);
    if (!isId(b.jobId)) throw new HttpError(400, "bad_request");
    if (!ctx.line) throw new HttpError(503, "not_configured");
    const group = await staffGroup(ctx);
    if (!group) throw new HttpError(409, "not_configured");
    if (!ctx.config.baseUrl.startsWith("https://") && !ctx.line.mock) throw new HttpError(503, "not_configured");   // LINE ต้องใช้ HTTPS
    const job = await ctx.repo.getJob(b.jobId);
    if (!job) throw new HttpError(404, "not_found");
    if (job.artwork_status !== "done") throw new HttpError(409, "step_not_ready");
    const retryKey = typeof b.retryKey === "string" && /^[0-9a-f-]{36}$/.test(b.retryKey) ? b.retryKey : ctx.uuid().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const price = b.agreedPrice === undefined || b.agreedPrice === "" ? null : Number(b.agreedPrice);
    if (price !== null && !(price > 0 && price < 10_000_000)) throw new HttpError(400, "bad_request");
    const url = (kind) => job[`${kind}_status`] === "done"
      ? signedFileUrl({ baseUrl: ctx.config.baseUrl, secret: ctx.config.fileSigningSecret, jobId: job.job_id, kind })
      : null;
    const customer = await ctx.repo.getUser(job.user_id);
    const messages = buildOrderMessages({ job, customer, staff: user, note: cleanText(b.note, 500), agreedPrice: price, artworkUrl: url("artwork"), mockupUrl: url("mockup") });
    // บันทึกก่อนส่ง: retry key เดิม = ไม่ส่งซ้ำ (LINE ก็กันซ้ำด้วย X-Line-Retry-Key)
    const fresh = await ctx.repo.insertLineOrder({ order_id: ctx.uuid(), job_id: job.job_id, group_id: group.groupId, retry_key: retryKey, sent_by: user.id });
    try {
      await ctx.line.push(group.groupId, messages, retryKey);
    } catch (err) {
      console.error("[line] push failed:", err.status || err.name);
      throw new HttpError(502, "line_failed");        // ลองใหม่ด้วย retryKey เดิมได้ ไม่ส่งซ้ำ
    }
    await ctx.repo.audit(user.id, "line_order_sent", job.job_id, { group: maskId(group.groupId), duplicate: !fresh });
    return { ok: true, duplicate: !fresh, retryKey, mock: ctx.line.mock, group: maskId(group.groupId), messageCount: messages.length };
  },
  async setRole(ctx, b, user) {
    adminOnly(user);
    if (!isId(b.userId) || !["customer", "staff", "admin"].includes(b.role)) throw new HttpError(400, "bad_request");
    if (b.userId === user.id) throw new HttpError(400, "bad_request");      // ห้ามเปลี่ยนสิทธิ์ตัวเอง
    if (!(await ctx.repo.getUser(b.userId))) throw new HttpError(404, "not_found");
    await ctx.repo.setUserRole(b.userId, b.role);
    await ctx.repo.audit(user.id, "role_changed", b.userId, { role: b.role });
    return { ok: true };
  },
};

export default route(async (req, res, ctx) => {
  need(ctx, "repo");
  const user = await requireStaff(ctx, req);
  const q = query(req);
  if (req.method === "GET") {
    const fn = GET[q.action];
    if (!fn) throw new HttpError(400, "bad_request");
    return sendJson(res, 200, await fn(ctx, q, user));
  }
  if (req.method !== "POST") throw new HttpError(405, "bad_request");
  assertSameOrigin(req, ctx.config.origins);
  const body = await readJson(req, 4_400_000);
  const fn = POST[body.action];
  if (!fn || !Object.prototype.hasOwnProperty.call(POST, body.action)) throw new HttpError(400, "bad_request");
  await rateLimit(ctx, `admin:${user.id}`, 600, 3600);
  sendJson(res, 200, await fn(ctx, body, user));
});
