// ทดสอบสถานะส่วน "สร้างภาพป้ายด้วย AI" + การกันลูกค้าทั่วไปไม่ให้ใช้ Mock AI ผ่าน API
// ไม่เรียก AI / LINE / Neon / Blob จริง (fetch ถูกบล็อก)
import test from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.LINE_ORDERS_ENABLED;
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const ai = (await import("../api/ai.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const upload = (await import("../api/upload.mjs")).default;
const { getContext, aiStatus, aiReadyForCustomers } = await import("../api/_lib/context.mjs");
const { createMockProvider } = await import("../api/_lib/ai-mock.mjs");
const ctx = await getContext();
const mockAi = ctx.ai;
const FORM = { shopName: "ร้านทดสอบ", signText: "TEST", widthCm: 150, heightCm: 50, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "white" };
const PNG_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function call(handler, { method = "GET", url = "/", body, cookie, origin = ORIGIN } = {}) {
  const req = { method, url, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": "9.9.9.9" }, body };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  let json = null; try { json = JSON.parse(String(res.body)); } catch {}
  return { status: res.statusCode, json, headers: res.headers };
}
const login = async (role) => (await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } })).headers["set-cookie"].split(";")[0];
const post = (cookie, body) => call(ai, { method: "POST", url: "/api/ai", cookie, body });
const idem = () => ctx.uuid();

// ตั้งสภาพแวดล้อมจำลองแต่ละแบบ แล้วคืนค่าเดิมหลังทดสอบ
async function withMode({ ai: provider, staffOnly }, fn) {
  const prev = { ai: ctx.ai, staffOnly: ctx.aiMockStaffOnly };
  ctx.ai = provider;
  ctx.aiMockStaffOnly = staffOnly;
  try { await fn(); } finally { ctx.ai = prev.ai; ctx.aiMockStaffOnly = prev.staffOnly; }
}

test("aiStatus: ฟังก์ชันตัดสินสถานะ", () => {
  const base = { repo: {}, storage: {} };
  const real = { name: "openai" };
  assert.equal(aiStatus({ ...base, ai: real }, null), "login_required");
  assert.equal(aiStatus({ ...base, ai: null }, null), "login_required");
  assert.equal(aiStatus({ ...base, ai: null }, { role: "customer" }), "coming_soon");
  assert.equal(aiStatus({ ...base, ai: null }, { role: "admin" }), "coming_soon");
  assert.equal(aiStatus({ ...base, ai: real, storage: null }, { role: "customer" }), "coming_soon", "ไม่มี Blob = ยังไม่พร้อม");
  assert.equal(aiStatus({ ...base, ai: { name: "mock" }, aiMockStaffOnly: true }, { role: "customer" }), "coming_soon");
  assert.equal(aiStatus({ ...base, ai: { name: "mock" }, aiMockStaffOnly: true }, { role: "staff" }), "mock_test");
  assert.equal(aiStatus({ ...base, ai: real }, { role: "customer" }), "ready");
  assert.equal(aiReadyForCustomers({ ...base, ai: real }), true);
  assert.equal(aiReadyForCustomers({ ...base, ai: { name: "mock" } }), false, "Mock ไม่นับเป็น AI จริง");
  assert.equal(aiReadyForCustomers({ ...base, ai: null }), false);
});

test("Production ตอนนี้ (ยังไม่มี AI): ลูกค้าเห็นสถานะ 'กำลังเตรียมเปิด' และ API ไม่สร้างภาพ/ไม่รับรูป", async () => {
  await withMode({ ai: null, staffOnly: false }, async () => {
    const anon = (await call(me)).json;
    assert.equal(anon.aiStatus, "login_required");
    assert.equal(anon.aiReady, false);
    const customer = await login("customer");
    const m = (await call(me, { cookie: customer })).json;
    assert.equal(m.aiStatus, "coming_soon");
    assert.equal(m.aiAvailable, false);
    const c = await post(customer, { action: "create", idempotencyKey: idem(), input: FORM });
    assert.equal(c.status, 503);
    assert.equal(c.json.code, "ai_unavailable");
    const u = await call(upload, { method: "POST", url: "/api/upload", cookie: customer, body: { kind: "reference", data: PNG_B64 } });
    assert.equal(u.status, 403, "ไม่เก็บรูปลูกค้าเมื่อระบบยังไม่เปิด");
    assert.equal(ctx.repo._db.uploads.size, 0);
    assert.deepEqual((await call(me, { cookie: customer })).json.quota.remaining, 1, "ไม่ใช้สิทธิ์");
    assert.equal((await call(me, { cookie: await login("admin") })).json.aiStatus, "coming_soon");
  });
});

test("AI_PROVIDER=mock บนเว็บจริง: ลูกค้าเรียก Mock AI ผ่าน API ไม่ได้ทุกทาง", async () => {
  await withMode({ ai: mockAi, staffOnly: true }, async () => {
    const customer = await login("customer");
    const m = (await call(me, { cookie: customer })).json;
    assert.equal(m.aiStatus, "coming_soon");
    assert.equal(m.aiReady, false, "Mock ไม่ทำให้ลูกค้าเห็นว่าระบบพร้อม");
    const anon = (await call(me)).json;
    assert.equal(anon.aiStatus, "login_required");
    assert.equal(anon.aiReady, false);

    const c = await post(customer, { action: "create", idempotencyKey: idem(), input: FORM });
    assert.equal(c.status, 403);
    assert.equal(c.json.code, "ai_unavailable");

    // ขโมย jobId ของพนักงานมาสั่ง step ก็ไม่ได้
    const staff = await login("staff");
    const sc = await post(staff, { action: "create", idempotencyKey: idem(), input: FORM });
    assert.equal(sc.status, 201);
    const step = await post(customer, { action: "step", jobId: sc.json.job.jobId, step: "artwork" });
    assert.equal(step.status, 403);
    // ไม่ล็อกอิน
    assert.equal((await post(null, { action: "create", idempotencyKey: idem(), input: FORM })).status, 401);
    // อัปโหลดรูปไม่ได้
    const u = await call(upload, { method: "POST", url: "/api/upload", cookie: customer, body: { kind: "storefront", data: PNG_B64 } });
    assert.equal(u.status, 403);
    // ดูงานของพนักงานไม่ได้
    const peek = await call(ai, { url: `/api/ai?job=${sc.json.job.jobId}`, cookie: customer });
    assert.equal(peek.status, 404);
    assert.equal((await call(me, { cookie: customer })).json.quota.remaining, 1, "เครดิตลูกค้าไม่ถูกแตะ");
  });
});

test("พนักงาน + Mock: สถานะ mock_test และผลลัพธ์ถูกติดป้ายว่าเป็นภาพตัวอย่าง (preview)", async () => {
  await withMode({ ai: mockAi, staffOnly: true }, async () => {
    const staff = await login("staff");
    assert.equal((await call(me, { cookie: staff })).json.aiStatus, "mock_test");
    const c = await post(staff, { action: "create", idempotencyKey: idem(), input: FORM });
    const jobId = c.json.job.jobId;
    await post(staff, { action: "step", jobId, step: "artwork" });
    const done = await post(staff, { action: "step", jobId, step: "mockup" });
    assert.equal(done.json.job.status, "completed");
    assert.equal(done.json.job.preview, true);
    const list = (await call(ai, { url: "/api/ai", cookie: staff })).json.jobs;
    assert.ok(list.every((j) => j.preview === true));
  });
});

test("เมื่อ AI จริงพร้อม: ลูกค้าใหม่สร้างได้ 1 งาน (ตรวจที่ Server) และไม่ติดป้าย preview", async () => {
  // ผู้สร้างภาพจำลองที่ทำตัวเป็น "AI จริง" — ไม่เรียกเครือข่าย
  const fakeReal = { ...createMockProvider(), name: "test-real" };
  await withMode({ ai: fakeReal, staffOnly: false }, async () => {
    assert.equal((await call(me)).json.aiReady, true);
    assert.equal((await call(me)).json.aiStatus, "login_required");
    const customer = await login("customer");
    const m = (await call(me, { cookie: customer })).json;
    assert.equal(m.aiStatus, "ready");
    assert.deepEqual(m.quota, { total: 1, used: 0, reserved: 0, remaining: 1 });

    const up = await call(upload, { method: "POST", url: "/api/upload", cookie: customer, body: { kind: "storefront", data: PNG_B64 } });
    assert.equal(up.status, 201, "AI พร้อมแล้วจึงรับรูปหน้าร้าน");
    const c = await post(customer, { action: "create", idempotencyKey: idem(), input: FORM, storefront: up.json.uploadId });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    const jobId = c.json.job.jobId;
    await post(customer, { action: "step", jobId, step: "artwork" });
    const done = await post(customer, { action: "step", jobId, step: "mockup" });
    assert.equal(done.json.job.status, "completed");
    assert.equal(done.json.job.preview, false);
    assert.deepEqual(done.json.quota, { total: 1, used: 1, reserved: 0, remaining: 0 });

    const again = await post(customer, { action: "create", idempotencyKey: idem(), input: FORM });
    assert.equal(again.status, 403);
    assert.equal(again.json.code, "quota_exhausted", "สิทธิ์ฟรีมี 1 งาน");
  });
});
