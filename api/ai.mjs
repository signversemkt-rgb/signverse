// /api/ai — งานสร้างภาพ AI (ต้องล็อกอิน + ตรวจสิทธิ์ทุกครั้งฝั่ง Server)
//   GET  /api/ai              → งานของฉัน + สิทธิ์คงเหลือ
//   GET  /api/ai?job=ID       → สถานะงาน (เฉพาะเจ้าของ)
//   POST /api/ai {action:"create", idempotencyKey, input, references, uploads, storefront, turnstileToken}
//   POST /api/ai {action:"step", jobId, step:"artwork"|"mockup"}  (เรียกซ้ำได้ ไม่สร้างภาพที่สำเร็จแล้วซ้ำ)
//   POST /api/ai {action:"order", idempotencyKey, input, jobId?}  → บันทึกคำขอสั่งผลิต + ข้อความสำหรับ LINE OA (ไม่เรียก AI)
//   GET  /api/ai?orders=1     → คำขอสั่งผลิตของฉัน (พร้อมสถานะการส่งผ่าน LINE)
//   POST /api/ai {action:"liffOrders"|"liffPrepare"|"liffResult", idToken, …}  → หน้า LIFF (ยืนยันตัวตนด้วย LINE ID token)
import { route } from "./_lib/route.mjs";
import { sendJson, readJson, query, HttpError, assertSameOrigin, getIp, cleanText, isId } from "./_lib/http.mjs";
import { need, rateLimit, verifyTurnstile, canUseLineOrders, canUseAi, isCreditExempt, resolveActor } from "./_lib/context.mjs";
import { createJob, runStep, jobView, quotaView, isJobOwner } from "./_lib/jobs.mjs";
import { ipHash, dayStart, guestUsage, budgetNow } from "./_lib/guest.mjs";
import { LIMITS } from "./_lib/images.mjs";
import { generateOrderNo, generateClaimCode, estimateFromForm, cleanOrderForm, orderView } from "./_lib/orders.mjs";
import { verifyLiffIdToken, liffListOrders, liffPrepare, liffResult } from "./_lib/delivery.mjs";

const TEXT_FIELDS = { shopName: 120, signText: 300, colors: 120, style: 120, material: 120, jobType: 60, details: 1500 };
const LIGHTING = ["none", "white", "warm"];

function ids(list, max) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > max || !list.every(isId)) throw new HttpError(400, "invalid_reference");
  return [...new Set(list)];
}

// owner = { userId } (สมาชิก) หรือ { guestId } (Guest) — ไฟล์ที่อ้างอิงต้องเป็นของเจ้าของคนเดียวกันเท่านั้น
export async function buildInput(ctx, owner, body) {
  const src = body.input || {};
  const input = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) input[k] = cleanText(src[k], max);
  if (!input.shopName && !input.signText) throw new HttpError(400, "bad_request");
  const w = Number(src.widthCm), h = Number(src.heightCm);
  if (!(w >= 1 && w <= 3000 && h >= 1 && h <= 3000)) throw new HttpError(400, "bad_request");
  input.widthCm = Math.round(w * 10) / 10;
  input.heightCm = Math.round(h * 10) / 10;
  input.lighting = LIGHTING.includes(src.lighting) ? src.lighting : "none";
  input.layers = Number(src.layers) === 2 ? 2 : 1;

  // ภาพอ้างอิง: รวมทุกแหล่งไม่เกิน 3 — ตรวจ ID ฝั่ง Server (ต้อง Published / ต้องเป็นของผู้ใช้เอง)
  const refIds = ids(body.references, LIMITS.maxReferences);
  const upIds = ids(body.uploads, LIMITS.maxReferenceUploads);
  if (refIds.length + upIds.length > LIMITS.maxReferences) throw new HttpError(400, "too_many_files");
  const published = await ctx.repo.getPublishedImages(refIds);
  if (published.length !== refIds.length) throw new HttpError(400, "invalid_reference");

  const storefrontIds = body.storefront ? ids([body.storefront], 1) : [];
  const uploads = await ctx.repo.getUploads([...upIds, ...storefrontIds]);
  const own = (id, kind) => uploads.find((u) => u.upload_id === id && u.kind === kind
    && ((owner.userId && u.user_id === owner.userId) || (owner.guestId && u.guest_id === owner.guestId)));
  if (!upIds.every((id) => own(id, "reference")) || !storefrontIds.every((id) => own(id, "storefront"))) {
    throw new HttpError(400, "invalid_reference");
  }
  input.references = published.map((i) => ({ imageId: i.image_id, url: i.public_url }));
  input.referenceUploads = upIds.map((id) => ({ uploadId: id, key: own(id, "reference").storage_key }));
  input.storefront = storefrontIds.length ? { uploadId: storefrontIds[0], key: own(storefrontIds[0], "storefront").storage_key } : null;
  return input;
}

// ---------- Guest (ไม่ต้องสมัครสมาชิก) — สร้าง/ดูงานของตัวเองเท่านั้น · สั่งผลิตผ่าน LINE OA ของร้านตามเดิม ----------
async function handleGuest(req, res, ctx, { guestId }) {
  need(ctx, "storage");
  if (req.method === "GET") {
    const q = query(req);
    if (q.job) {
      if (!isId(q.job)) throw new HttpError(400, "bad_request");
      const job = await ctx.repo.getJob(q.job);
      if (!isJobOwner(job, { guestId })) throw new HttpError(404, "not_found");
      return sendJson(res, 200, { job: jobView(job) });
    }
    if (q.orders) throw new HttpError(401, "unauthenticated");
    const jobs = await ctx.repo.listJobsByGuest(guestId, 5);
    return sendJson(res, 200, { jobs: jobs.map(jobView), guest: await guestUsage(ctx, guestId, getIp(req)) });
  }
  if (req.method !== "POST") throw new HttpError(405, "bad_request");
  assertSameOrigin(req, ctx.config.origins);
  const body = req.body;
  if (body.action === "create") {
    const ip = getIp(req);
    await rateLimit(ctx, `ai-guest:${guestId}`, 10, 3600);           // กันยิงถี่ (เพดานงานจริงตรวจใน createJob)
    await rateLimit(ctx, `ai-guest-ip:${ip}`, 20, 3600);
    await verifyTurnstile(ctx, body.turnstileToken, ip);
    const input = await buildInput(ctx, { guestId }, body);
    input.provider = ctx.ai.name;
    const g = ctx.config.guest;
    const { job, created } = await createJob({
      repo: ctx.repo, guestId, ipHash: ipHash(ctx, ip), idempotencyKey: body.idempotencyKey, input, uuid: ctx.uuid,
      guestLimits: g, dayStart: dayStart(), budget: budgetNow(ctx),
    });
    return sendJson(res, created ? 201 : 200, { job: jobView(job), created, guest: await guestUsage(ctx, guestId, ip) });
  }
  if (body.action === "step") {
    if (!isId(body.jobId)) throw new HttpError(400, "bad_request");
    await rateLimit(ctx, `ai-guest-step:${guestId}`, 30, 3600);
    const job = await runStep({ repo: ctx.repo, storage: ctx.storage, provider: ctx.ai, guestId, jobId: body.jobId, step: body.step });
    return sendJson(res, 200, { job: jobView(job) });
  }
  // สั่งผลิตผ่านระบบออร์เดอร์ต้องเป็นสมาชิก — Guest ติดต่อร้านทาง LINE OA ได้ทันที
  throw new HttpError(401, "unauthenticated");
}

async function handleLiff(req, res, ctx, body) {
  if (!ctx.config.liffId && !ctx.mock) throw new HttpError(503, "not_configured");
  if (ctx.config.lineOrdersMode === "off") throw new HttpError(403, "feature_disabled");
  await rateLimit(ctx, `liff:ip:${getIp(req)}`, 60, 3600);
  const lineUserId = await verifyLiffIdToken(ctx, body.idToken);
  if (!lineUserId) throw new HttpError(401, "unauthenticated");
  if (body.action === "liffOrders") return sendJson(res, 200, { orders: await liffListOrders(ctx, lineUserId) });
  if (!isId(body.orderId)) throw new HttpError(400, "bad_request");
  const out = body.action === "liffPrepare"
    ? await liffPrepare(ctx, lineUserId, body.orderId)
    : await liffResult(ctx, lineUserId, body.orderId, body.ok === true);
  if (out.error === "not_found") throw new HttpError(404, "not_found");
  if (out.error) return sendJson(res, 409, { error: out.error === "already_sent" ? "ออร์เดอร์นี้ส่งเข้าแชตแล้ว" : "กำลังส่งอยู่ กรุณารอสักครู่", code: out.error });
  return sendJson(res, 200, out);
}

export default route(async (req, res, ctx) => {
  need(ctx, "repo");
  // หน้า LIFF ยืนยันตัวตนด้วย LINE ID token (ไม่ใช้ cookie ของเว็บ)
  if (req.method === "POST") {
    req.body = await readJson(req);          // อ่าน body ครั้งเดียว แล้วใช้ต่อด้านล่าง
    if (["liffOrders", "liffPrepare", "liffResult"].includes(req.body.action)) {
      assertSameOrigin(req, ctx.config.origins);
      return handleLiff(req, res, ctx, req.body);
    }
  }
  // สมาชิก หรือ Guest (GUEST_AI_ENABLED) — ตรวจที่ Server ทุกคำขอ
  const isCreate = req.method === "POST" && req.body && req.body.action === "create";
  const actor = await resolveActor(ctx, req, res, { create: isCreate });
  const { user } = actor;
  if (!user) return handleGuest(req, res, ctx, actor);

  if (req.method === "GET") {
    const q = query(req);
    if (q.orders) {
      const orders = await ctx.repo.listOrdersByUser(user.id, 20);
      return sendJson(res, 200, { orders: orders.map((o) => orderView(o, { lineText: true, oaId: ctx.config.lineOaId })) });
    }
    if (q.job) {
      if (!isId(q.job)) throw new HttpError(400, "bad_request");
      const job = await ctx.repo.getJob(q.job);
      if (!job || job.user_id !== user.id) throw new HttpError(404, "not_found");
      return sendJson(res, 200, { job: jobView(job) });
    }
    const [jobs, quota] = await Promise.all([ctx.repo.listJobsByUser(user.id, 10), ctx.repo.getQuota(user.id, ctx.config.defaultCredits)]);
    return sendJson(res, 200, { jobs: jobs.map(jobView), quota: quotaView(quota) });
  }

  if (req.method !== "POST") throw new HttpError(405, "bad_request");
  assertSameOrigin(req, ctx.config.origins);
  const body = await readJson(req);

  if (body.action === "create") {
    if (!ctx.ai || !ctx.storage) throw new HttpError(503, "ai_unavailable");
    if (!canUseAi(ctx, user)) throw new HttpError(403, "ai_unavailable");     // Mock AI บนเว็บจริง = เฉพาะพนักงาน
    await rateLimit(ctx, `ai:user:${user.id}`, 10, 3600);
    await rateLimit(ctx, `ai:ip:${getIp(req)}`, 20, 3600);
    await verifyTurnstile(ctx, body.turnstileToken, getIp(req));
    const input = await buildInput(ctx, { userId: user.id }, body);
    input.provider = ctx.ai.name;                        // "mock" = ภาพตัวอย่าง (หน้าเว็บติดป้ายว่าไม่ใช่ AI จริง)
    const { job, created } = await createJob({
      repo: ctx.repo, userId: user.id, idempotencyKey: body.idempotencyKey, input,
      dailyLimit: ctx.config.dailyLimit, defaultCredits: ctx.config.defaultCredits, uuid: ctx.uuid,
      exempt: isCreditExempt(ctx, user),
      budget: budgetNow(ctx),                             // งบ AI รวมทั้งระบบ (เฉพาะ AI จริง)
    });
    const quota = quotaView(await ctx.repo.getQuota(user.id, ctx.config.defaultCredits));
    return sendJson(res, created ? 201 : 200, { job: jobView(job), quota, created });
  }

  if (body.action === "step") {
    if (!ctx.ai || !ctx.storage) throw new HttpError(503, "ai_unavailable");
    if (!canUseAi(ctx, user)) throw new HttpError(403, "ai_unavailable");
    if (!isId(body.jobId)) throw new HttpError(400, "bad_request");
    await rateLimit(ctx, `ai-step:user:${user.id}`, 30, 3600);
    const job = await runStep({ repo: ctx.repo, storage: ctx.storage, provider: ctx.ai, userId: user.id, jobId: body.jobId, step: body.step });
    const quota = quotaView(await ctx.repo.getQuota(user.id, ctx.config.defaultCredits));
    return sendJson(res, 200, { job: jobView(job), quota });
  }

  if (body.action === "order") {
    if (!canUseLineOrders(ctx, user)) throw new HttpError(403, "feature_disabled");   // ยังไม่เปิดให้ลูกค้าทั่วไป
    await rateLimit(ctx, `order:user:${user.id}`, 10, 3600);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(body.idempotencyKey || "")) throw new HttpError(400, "bad_request");
    const form = cleanOrderForm(body.input || {}, cleanText);
    if (!form) throw new HttpError(400, "bad_request");
    let jobId = null;
    if (body.jobId != null) {
      if (!isId(body.jobId)) throw new HttpError(400, "bad_request");
      const job = await ctx.repo.getJob(body.jobId);
      if (!job || job.user_id !== user.id) throw new HttpError(404, "not_found");
      jobId = job.job_id;
    }
    const base = {
      order_id: ctx.uuid(), user_id: user.id, job_id: jobId, idempotency_key: body.idempotencyKey, form,
      price_estimate: estimateFromForm(form, ctx.env), status: "new", staff_note: "", created_at: new Date().toISOString(),
      claim_code: generateClaimCode(), line_user_id: null, line_delivery_status: "awaiting_customer", line_delivery_attempts: 0,
    };
    let result = null;
    for (let i = 0; i < 4 && !result; i++) {               // เลขออร์เดอร์ชนกัน (โอกาสต่ำมาก) → สุ่มใหม่
      try { result = await ctx.repo.insertOrder({ ...base, order_no: generateOrderNo() }); }
      catch (err) { if (err.code !== "23505") throw err; }
    }
    if (!result) throw new HttpError(500, "server_error");
    if (result.created) await ctx.repo.audit(user.id, "order_created", result.order.order_no, { jobId });
    return sendJson(res, result.created ? 201 : 200, { order: orderView(result.order, { lineText: true, oaId: ctx.config.lineOaId }), created: result.created });
  }

  throw new HttpError(400, "bad_request");
});
