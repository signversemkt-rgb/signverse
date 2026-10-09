// ทดสอบสวิตช์เปิดใช้ระบบสั่งผลิตผ่าน LINE (LINE_ORDERS_ENABLED) — off เป็นค่าเริ่มต้นบน Production
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
process.env.LINE_ORDERS_ENABLED = "staff";          // ช่วงทดสอบ: เฉพาะบัญชีพนักงาน
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const ai = (await import("../api/ai.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const webhook = (await import("../api/line/webhook.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const ctx = await getContext();
const FORM = { shopName: "ทดสอบ", signText: "TEST", widthCm: 100, heightCm: 50, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" };

async function call(handler, { method = "GET", url = "/", body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const req = { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": "9.9.9.9" }, body, rawBody: raw };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  let json = null; try { json = JSON.parse(String(res.body)); } catch {}
  return { status: res.statusCode, json, headers: res.headers };
}
const login = async (role) => (await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } })).headers["set-cookie"].split(";")[0];
async function hook(userId, text) {
  const raw = Buffer.from(JSON.stringify({ events: [{ type: "message", replyToken: "rt" + Math.random(), source: { type: "user", userId }, message: { type: "text", id: "1", text } }] }));
  const sig = createHmac("sha256", ctx.config.lineChannelSecret).update(raw).digest("base64");
  return call(webhook, { method: "POST", url: "/api/line/webhook", raw, origin: null, headers: { "x-line-signature": sig } });
}

test("ค่าเริ่มต้นนอกโหมด Mock = ปิด (ไม่มี LINE_ORDERS_ENABLED)", async () => {
  const { getContext: fresh } = await import("../api/_lib/context.mjs?prod=" + Date.now());
  const prod = await fresh({ BETTER_AUTH_URL: "https://example.com" });
  assert.equal(prod.config.lineOrdersMode, "off");
  assert.equal(prod.config.lineGroupOrdersEnabled, false);
  assert.equal(prod.ai, null, "AI จริงปิด");
  assert.equal(prod.line, null, "ไม่มี token = ไม่มี LINE client");
});

test("โหมด staff: ลูกค้าทั่วไปไม่เห็นปุ่ม/สั่งผ่าน LINE ไม่ได้ · พนักงานทดสอบได้", async () => {
  const customer = await login("customer");
  assert.equal((await call(me, { cookie: customer })).json.lineOrders, false);
  const r = await call(ai, { method: "POST", url: "/api/ai", cookie: customer, body: { action: "order", idempotencyKey: ctx.uuid(), input: FORM } });
  assert.equal(r.json.code, "feature_disabled");

  const staff = await login("staff");
  assert.equal((await call(me, { cookie: staff })).json.lineOrders, true);
  const o = (await call(ai, { method: "POST", url: "/api/ai", cookie: staff, body: { action: "order", idempotencyKey: ctx.uuid(), input: FORM } })).json.order;
  assert.ok(o.orderNo);
  const before = ctx.line.sent.length;
  await hook("U" + "1".repeat(32), o.lineText);
  assert.equal(ctx.line.sent.length, before + 1, "ออร์เดอร์ของพนักงานทดสอบได้รับการตอบกลับ");
});

test("โหมด staff: ออร์เดอร์ของลูกค้าทั่วไป (ถ้ามี) จะไม่ถูกตอบกลับ", async () => {
  const customer = await login("customer");
  const uid = (await call(me, { cookie: customer })).json.user.id;
  // จำลองออร์เดอร์เก่าของลูกค้า (สร้างก่อนเปลี่ยนโหมด)
  ctx.repo._db.orders.set("o".repeat(32), { order_id: "o".repeat(32), order_no: "SV261009-ABCD", user_id: uid, job_id: null, idempotency_key: "k".repeat(20), form: FORM, price_estimate: null, status: "new", claim_code: "WXYZ-2345", line_user_id: null, line_delivery_status: "awaiting_customer", line_delivery_attempts: 0, created_at: new Date().toISOString() });
  const before = ctx.line.sent.length;
  await hook("U" + "2".repeat(32), "เลขออร์เดอร์: SV261009-ABCD\nรหัสยืนยัน: WXYZ-2345");
  assert.equal(ctx.line.sent.length, before);
  assert.equal(ctx.repo._db.orders.get("o".repeat(32)).line_delivery_status, "awaiting_customer");
});

test("โหมด off: Webhook ยังตอบ 200 (Verify ผ่าน) แต่ไม่ตอบข้อความใด ๆ", async () => {
  ctx.config.lineOrdersMode = "off";
  const staff = await login("staff");
  ctx.config.lineOrdersMode = "staff";
  const o = (await call(ai, { method: "POST", url: "/api/ai", cookie: staff, body: { action: "order", idempotencyKey: ctx.uuid(), input: FORM } })).json.order;
  ctx.config.lineOrdersMode = "off";
  assert.equal((await call(me, { cookie: staff })).json.lineOrders, false);
  const before = ctx.line.sent.length;
  const verify = await call(webhook, { method: "POST", url: "/api/line/webhook", raw: Buffer.from('{"events":[]}'), origin: null,
    headers: { "x-line-signature": createHmac("sha256", ctx.config.lineChannelSecret).update('{"events":[]}').digest("base64") } });
  assert.equal(verify.status, 200);
  await hook("U" + "3".repeat(32), o.lineText);
  assert.equal(ctx.line.sent.length, before);
  assert.equal((await call(ai, { method: "POST", url: "/api/ai", cookie: staff, body: { action: "order", idempotencyKey: ctx.uuid(), input: FORM } })).json.code, "feature_disabled");
  ctx.config.lineOrdersMode = "staff";
});
