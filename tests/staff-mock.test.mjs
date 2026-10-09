// ทดสอบ Mock AI สำหรับพนักงาน (จำลองเว็บจริงที่ตั้ง AI_PROVIDER=mock) + สั่งผลิต + LINE (Mock)
// ไม่เรียก AI / LINE / Neon / Blob จริง
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.LINE_ORDERS_ENABLED = "staff";           // จำลองช่วงทดสอบ (บน Production ยังไม่ตั้ง)
delete process.env.LINE_GROUP_ORDERS_ENABLED;
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const ai = (await import("../api/ai.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const admin = (await import("../api/admin.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const webhook = (await import("../api/line/webhook.mjs")).default;
const { getContext, canUseAi, isCreditExempt } = await import("../api/_lib/context.mjs");
const ctx = await getContext();
ctx.aiMockStaffOnly = true;                          // = เว็บจริงที่ตั้ง AI_PROVIDER=mock
const FORM = { shopName: "ร้านทดสอบ", signText: "TEST", widthCm: 150, heightCm: 50, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "white" };
const PNG = [0x89, 0x50, 0x4e, 0x47];

async function call(handler, { method = "GET", url = "/", body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const req = { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": "5.6.7.8" }, body, rawBody: raw };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  let json = null; try { json = JSON.parse(Buffer.isBuffer(res.body) ? "" : String(res.body)); } catch {}
  return { status: res.statusCode, json, headers: res.headers, buf: Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? "")) };
}
const login = async (role) => (await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } })).headers["set-cookie"].split(";")[0];
const post = (cookie, body) => call(ai, { method: "POST", url: "/api/ai", cookie, body });
async function hook(userId, text) {
  const raw = Buffer.from(JSON.stringify({ events: [{ type: "message", replyToken: "rt-" + Math.random(), source: { type: "user", userId }, message: { type: "text", id: "1", text } }] }));
  return call(webhook, { method: "POST", url: "/api/line/webhook", raw, origin: null, headers: { "x-line-signature": createHmac("sha256", ctx.config.lineChannelSecret).update(raw).digest("base64") } });
}

test("ค่าจริงบน Production: AI_PROVIDER=mock → Mock AI เฉพาะพนักงาน, ระบบกลุ่มปิด, สั่งผลิตผ่าน LINE ปิด", async () => {
  const { getContext: fresh } = await import("../api/_lib/context.mjs?prod=" + Date.now());
  const prod = await fresh({ AI_PROVIDER: "mock", BETTER_AUTH_URL: "https://signverse-azure.vercel.app" });
  assert.equal(prod.aiMockStaffOnly, true);
  assert.equal(prod.ai.name, "mock");
  assert.equal(prod.config.lineOrdersMode, "off");
  assert.equal(prod.config.lineGroupOrdersEnabled, false);
});

test("ลูกค้าทั่วไป: ไม่เห็นส่วน AI และเรียก API สร้างภาพตรง ๆ ไม่ได้ (ตรวจที่ Server)", async () => {
  const customer = await login("customer");
  const m = (await call(me, { cookie: customer })).json;
  assert.equal(m.aiAvailable, false);
  assert.equal((await call(me)).json.aiAvailable, false, "ผู้ไม่ล็อกอินก็ไม่เห็น");
  const r = await post(customer, { action: "create", idempotencyKey: ctx.uuid(), input: FORM });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "ai_unavailable");
  assert.deepEqual(m.quota, { total: 1, used: 0, reserved: 0, remaining: 1 }, "เครดิตลูกค้าไม่ถูกแตะ");
  assert.equal(canUseAi(ctx, { role: "customer" }), false);
  assert.equal(isCreditExempt(ctx, { role: "customer" }), false);
});

test("พนักงาน: สร้าง Artwork + Mockup (PNG) ได้ โดยไม่ใช้เครดิต และทดสอบซ้ำได้", async () => {
  const staff = await login("staff");
  assert.equal((await call(me, { cookie: staff })).json.aiAvailable, true);
  for (let round = 0; round < 3; round++) {
    const c = await post(staff, { action: "create", idempotencyKey: ctx.uuid(), input: FORM });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    const jobId = c.json.job.jobId;
    await post(staff, { action: "step", jobId, step: "artwork" });
    const done = await post(staff, { action: "step", jobId, step: "mockup" });
    assert.equal(done.json.job.status, "completed");
    assert.deepEqual(done.json.quota, { total: 1, used: 0, reserved: 0, remaining: 1 }, "ไม่หักเครดิต");
    assert.equal(ctx.repo._db.jobs.get(jobId).credit_state, "exempt");
    for (const kind of ["artwork", "mockup"]) {
      const f = await call(files, { url: done.json.job[kind].url, cookie: staff });
      assert.equal(f.headers["content-type"], "image/png");
      assert.deepEqual([...f.buf.subarray(0, 4)], PNG, `${kind} เป็น PNG จริง`);
    }
  }
});

test("สั่งผลิต (พนักงาน) → บันทึกออร์เดอร์ → Mock LINE ตอบกลับรูป PNG 2 รูป + Request ID → หลังบ้านเปิดรูปได้ · ไม่ซ้ำ · ไม่ push", async () => {
  const staff = await login("staff");
  const c = await post(staff, { action: "create", idempotencyKey: ctx.uuid(), input: FORM });
  const jobId = c.json.job.jobId;
  await post(staff, { action: "step", jobId, step: "artwork" });
  await post(staff, { action: "step", jobId, step: "mockup" });

  let pushes = 0;
  const guarded = ctx.line.push;
  ctx.line.push = async (...a) => { pushes++; return guarded(...a); };

  const key = ctx.uuid();
  const o1 = await post(staff, { action: "order", idempotencyKey: key, jobId, input: FORM });
  assert.equal(o1.status, 201);
  const o2 = await post(staff, { action: "order", idempotencyKey: key, jobId, input: FORM });
  assert.equal(o2.json.created, false, "กดซ้ำได้ออร์เดอร์เดิม");
  assert.equal(o2.json.order.orderNo, o1.json.order.orderNo);
  const order = o1.json.order;
  assert.equal(order.lineDelivery.status, "awaiting_customer");

  const before = ctx.line.sent.filter((s) => s.kind === "reply").length;
  const lineUser = "U" + "c".repeat(32);
  await hook(lineUser, order.lineText);
  await hook(lineUser, order.lineText);                                        // ส่งข้อความเดิมซ้ำ
  const replies = ctx.line.sent.filter((s) => s.kind === "reply");
  assert.equal(replies.length, before + 1, "ตอบกลับครั้งเดียว");
  const imgs = replies.at(-1).messages.filter((m) => m.type === "image");
  assert.equal(imgs.length, 2);
  for (const im of imgs) {
    const u = new URL(im.originalContentUrl);
    const f = await call(files, { url: u.pathname + u.search, origin: null });
    assert.deepEqual([...f.buf.subarray(0, 4)], PNG);
  }
  ctx.line.push = guarded;
  assert.equal(pushes, 0, "ไม่มีการส่งเข้ากลุ่ม");

  const adminCookie = await login("admin");
  const d = (await call(admin, { url: `/api/admin?action=order&id=${order.orderId}`, cookie: adminCookie })).json;
  assert.equal(d.order.lineDelivery.status, "sent");
  assert.match(d.order.lineDelivery.requestId, /^mock-req-/);
  for (const kind of ["artwork", "mockup"]) {
    const f = await call(files, { url: d.job[kind].url, cookie: adminCookie });
    assert.equal(f.status, 200);
    assert.deepEqual([...f.buf.subarray(0, 4)], PNG);
  }
  const found = (await call(admin, { url: `/api/admin?action=orders&search=${order.orderNo}`, cookie: adminCookie })).json.orders;
  assert.equal(found.length, 1);
});

test("ลูกค้าทั่วไปสั่งผลิตผ่าน LINE ไม่ได้ในช่วงทดสอบ", async () => {
  const customer = await login("customer");
  assert.equal((await call(me, { cookie: customer })).json.lineOrders, false);
  assert.equal((await post(customer, { action: "order", idempotencyKey: ctx.uuid(), input: FORM })).json.code, "feature_disabled");
});
