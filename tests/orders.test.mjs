// ทดสอบ "สั่งผลิตป้ายนี้" → บันทึกออร์เดอร์ + ข้อความ LINE OA (Mock ทั้งหมด ไม่เรียก LINE/AI จริง)
import test from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const ai = (await import("../api/ai.mjs")).default;
const admin = (await import("../api/admin.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const { generateOrderNo, lineOaUrls, buildLineText, MAX_LINE_TEXT } = await import("../api/_lib/orders.mjs");
const ctx = await getContext();

async function call(handler, { method = "GET", url = "/", body, cookie, origin = ORIGIN } = {}) {
  const req = { method, url, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": "1.2.3.4" }, body };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  const text = res.body == null ? "" : Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.statusCode, json, text, headers: res.headers };
}
const login = async (role = "customer") => (await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } })).headers["set-cookie"].split(";")[0];
const FORM = { shopName: "บ้านสวนคาเฟ่", signText: "BAAN SUAN", widthCm: 180, heightCm: 60, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "warm", colors: "เขียว", details: "ติดหน้าร้าน" };
const key = () => ctx.uuid();

async function finishedJob(cookie) {
  const c = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: key(), input: FORM } });
  const jobId = c.json.job.jobId;
  await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "step", jobId, step: "artwork" } });
  await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "step", jobId, step: "mockup" } });
  return jobId;
}

test("เลขออร์เดอร์รูปแบบถูกต้องและไม่ซ้ำ", () => {
  const set = new Set(Array.from({ length: 2000 }, () => generateOrderNo(Date.UTC(2026, 9, 9, 5))));
  assert.ok(set.size > 1990);
  for (const n of [...set].slice(0, 5)) assert.match(n, /^SV261009-[A-HJ-NP-Z2-9]{4}$/);
});

test("ลิงก์ LINE OA ทางการ: oaMessage + percent-encode ทั้ง @id และข้อความ", () => {
  const u = lineOaUrls("@signverse", "สั่งผลิต & ทดสอบ?");
  assert.equal(u.chatWithText, "https://line.me/R/oaMessage/%40signverse/?" + encodeURIComponent("สั่งผลิต & ทดสอบ?"));
  assert.equal(u.profile, "https://line.me/R/ti/p/%40signverse");
});

test("ผู้ไม่ล็อกอินสั่งผลิตไม่ได้ / origin อื่นไม่ได้", async () => {
  assert.equal((await call(ai, { method: "POST", url: "/api/ai", body: { action: "order", idempotencyKey: key(), input: FORM } })).status, 401);
  const c = await login();
  assert.equal((await call(ai, { method: "POST", url: "/api/ai", cookie: c, origin: "https://evil.example", body: { action: "order", idempotencyKey: key(), input: FORM } })).status, 403);
});

test("สั่งผลิต: บันทึกออร์เดอร์ + ข้อความครบ + ไม่เรียก AI ซ้ำ + กดซ้ำได้เลขเดิม + ราคาไม่เชื่อ Browser", async () => {
  const cookie = await login();
  const jobId = await finishedJob(cookie);
  const callsBefore = ctx.ai.calls.length;
  const k = key();
  const r = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "order", idempotencyKey: k, jobId, input: { ...FORM, price: 1, priceEstimate: 1, status: "completed" } } });
  assert.equal(r.status, 201, r.text);
  const o = r.json.order;
  assert.match(o.orderNo, /^SV\d{6}-[A-Z0-9]{4}$/);
  assert.equal(o.status, "new", "สถานะจาก Browser ถูกเพิกเฉย");
  assert.equal(o.priceEstimate, null, "ไม่มี PRICING_CONFIG → รอทีมงานประเมิน (ไม่ใช้ราคาที่ Browser ส่งมา)");
  assert.equal(ctx.ai.calls.length, callsBefore, "สั่งผลิตต้องไม่เรียก AI");
  for (const s of ["สั่งผลิตงานป้ายตามฟอร์มที่ลูกค้ากรอก", o.orderNo, "180 x 60 ซม.", "พลาสวูด", "ไฟวอร์มไวท์", "รอทีมงานประเมิน", "บ้านสวนคาเฟ่"]) assert.ok(o.lineText.includes(s), s);
  assert.ok(o.lineText.length <= MAX_LINE_TEXT);
  assert.ok(o.line.chatWithText.startsWith("https://line.me/R/oaMessage/%40signverse/?"));
  assert.ok(!o.lineText.includes("http"), "ไม่มีลิงก์รูป/URL ในข้อความ (รูปอยู่ในระบบหลังบ้าน)");
  const again = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "order", idempotencyKey: k, jobId, input: FORM } });
  assert.equal(again.json.created, false);
  assert.equal(again.json.order.orderNo, o.orderNo);
  const mine = (await call(ai, { url: "/api/ai?orders=1", cookie })).json.orders;
  assert.equal(mine.length, 1);
});

test("แนบงานของคนอื่นไม่ได้ / ข้อมูลไม่ครบไม่ได้", async () => {
  const a = await login();
  const b = await login();
  const jobA = await finishedJob(a);
  assert.equal((await call(ai, { method: "POST", url: "/api/ai", cookie: b, body: { action: "order", idempotencyKey: key(), jobId: jobA, input: FORM } })).status, 404);
  assert.equal((await call(ai, { method: "POST", url: "/api/ai", cookie: b, body: { action: "order", idempotencyKey: key(), input: { ...FORM, widthCm: 0 } } })).status, 400);
});

test("ราคาประเมินคำนวณฝั่ง Server เมื่อมี PRICING_CONFIG", async () => {
  const { estimateFromForm } = await import("../api/_lib/orders.mjs");
  const config = { rules: { plaswood_1layer: { enabled: true, formula: "board", costPerCm2: 0.01, variableCost: 10, fixedCost: 10, multiplier: 2, shipping: 0, vatRate: 0.07, addons: [] } } };
  // ค่าทดสอบสมมติ (ไม่ใช่ต้นทุนจริง) — แค่ยืนยันว่าใช้เครื่องคำนวณเดียวกับ /api/estimate-price
  const price = estimateFromForm({ ...FORM, lighting: "none" }, { PRICING_CONFIG: JSON.stringify(config) });
  assert.equal(typeof price, "number");
});

test("พนักงานค้นหาออร์เดอร์ เปิดดูภาพ และอัปเดตสถานะได้ · ลูกค้าเข้าไม่ได้", async () => {
  const cookie = await login();
  const jobId = await finishedJob(cookie);
  const o = (await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "order", idempotencyKey: key(), jobId, input: FORM } })).json.order;
  assert.equal((await call(admin, { url: "/api/admin?action=orders", cookie })).status, 403);
  const staff = await login("staff");
  const found = (await call(admin, { url: `/api/admin?action=orders&search=${o.orderNo}`, cookie: staff })).json.orders;
  assert.equal(found.length, 1);
  assert.equal(found[0].orderNo, o.orderNo);
  const byShop = (await call(admin, { url: `/api/admin?action=orders&search=${encodeURIComponent("บ้านสวน")}`, cookie: staff })).json.orders;
  assert.ok(byShop.some((x) => x.orderNo === o.orderNo));
  const detail = (await call(admin, { url: `/api/admin?action=order&id=${o.orderId}`, cookie: staff })).json;
  assert.ok(detail.job.artwork.url && detail.job.mockup.url);
  assert.equal((await call(files, { url: detail.job.artwork.url, cookie: staff })).status, 200, "พนักงานเปิด Artwork ได้");
  assert.equal((await call(files, { url: detail.job.mockup.url, cookie: staff })).status, 200, "พนักงานเปิด Mockup ได้");
  assert.equal((await call(files, { url: detail.job.artwork.url })).status, 401, "ไม่มี public URL ถาวร");
  const up = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateOrder", id: o.orderId, status: "contacted", staffNote: "โทรแล้ว" } });
  assert.equal(up.json.order.status, "contacted");
  const bad = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateOrder", id: o.orderId, status: "hacked" } });
  assert.equal(bad.status, 400);
  const filtered = (await call(admin, { url: "/api/admin?action=orders&status=contacted", cookie: staff })).json.orders;
  assert.ok(filtered.every((x) => x.status === "contacted"));
});
