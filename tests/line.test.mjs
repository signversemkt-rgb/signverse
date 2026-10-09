// ทดสอบ LINE Webhook + ผูกกลุ่ม + ส่งคำสั่งผลิต ด้วย Mock (ห้ามเรียก LINE API จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.MOCK_SERVICES = "1";
process.env.LINE_GROUP_ORDERS_ENABLED = "true";   // ทดสอบระบบกลุ่มเดิม (ปิดเป็นค่าเริ่มต้นใน Production)
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.VERCEL_ENV;
// กันพลาดเรียกเครือข่ายจริง
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const webhook = (await import("../api/line/webhook.mjs")).default;
const admin = (await import("../api/admin.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const ai = (await import("../api/ai.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const { verifySignature, signedFileUrl, parseBindCommand } = await import("../api/_lib/line.mjs");
const ctx = await getContext();
const SECRET = ctx.config.lineChannelSecret;
const GROUP = "C" + "a1".repeat(16);
const OTHER = "C" + "b2".repeat(16);

async function call(handler, { method = "GET", url = "/", body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const req = { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": "1.2.3.4" }, body, rawBody: raw };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  const text = res.body == null ? "" : Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.statusCode, json, text, headers: res.headers };
}
const sign = (buf, secret = SECRET) => createHmac("sha256", secret).update(buf).digest("base64");
async function sendEvents(events, { secret = SECRET, tamper = false, noSig = false } = {}) {
  const raw = Buffer.from(JSON.stringify({ destination: "Uxxx", events }));
  const sig = sign(raw, secret);
  const body = tamper ? Buffer.from(raw.toString().replace("ผูกกลุ่ม", "ผูกกลุ่ม ")) : raw;
  return call(webhook, { method: "POST", url: "/api/line/webhook", raw: body, origin: null, headers: noSig ? {} : { "x-line-signature": sig } });
}
const textEvent = (groupId, text, type = "group") => ({ type: "message", replyToken: "rt-" + Math.random(), source: type === "group" ? { type: "group", groupId, userId: "U" + "c3".repeat(16) } : { type: "user", userId: "U" + "c3".repeat(16) }, message: { type: "text", id: "1", text } });
async function login(role) {
  const r = await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } });
  return r.headers["set-cookie"].split(";")[0];
}

test("ตรวจลายเซ็น: ถูกต้องผ่าน / ไม่มี / ผิด secret / body ถูกแก้ → 401", async () => {
  assert.equal(verifySignature(Buffer.from("x"), sign(Buffer.from("x")), SECRET), true);
  assert.equal((await sendEvents([])).status, 200, "Verify จาก LINE Console (events ว่าง)");
  assert.equal((await sendEvents([{ type: "join", source: { type: "group", groupId: GROUP } }], { noSig: true })).status, 401);
  assert.equal((await sendEvents([{ type: "join", source: { type: "group", groupId: GROUP } }], { secret: "wrong" })).status, 401);
  assert.equal((await sendEvents([textEvent(GROUP, "ผูกกลุ่ม SV-AAAAAAAA")], { tamper: true })).status, 401);
});

test("บอทเข้ากลุ่ม → บันทึกเป็น joined เท่านั้น (ยังไม่ใช่กลุ่มพนักงาน)", async () => {
  await sendEvents([{ type: "join", replyToken: "x", source: { type: "group", groupId: GROUP } }]);
  assert.equal(await ctx.repo.getSetting("line_staff_group_id"), null);
  assert.equal(ctx.repo._db.lineGroups.get(GROUP).status, "joined");
});

test("ผูกกลุ่ม: รหัสผิด/หมดอายุ/ใช้ซ้ำ/แชตส่วนตัว ไม่ผูก · รหัสถูกต้องผูกได้ครั้งเดียว", async () => {
  const staff = await login("staff");
  const adminCookie = await login("admin");
  assert.equal((await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "createBindCode" } })).status, 403, "staff สร้างรหัสไม่ได้");
  const { code } = (await call(admin, { method: "POST", url: "/api/admin", cookie: adminCookie, body: { action: "createBindCode" } })).json;
  assert.ok(parseBindCommand(`ผูกกลุ่ม ${code}`));
  assert.ok(!JSON.stringify(ctx.repo._db.settings.get("line_bind_code")).includes(code), "เก็บเฉพาะ hash");

  await sendEvents([textEvent(GROUP, "ผูกกลุ่ม SV-WRONGXXX")]);
  await sendEvents([textEvent(GROUP, `ผูกกลุ่ม ${code}`, "user")]);        // แชตส่วนตัว
  assert.equal(await ctx.repo.getSetting("line_staff_group_id"), null);
  const before = ctx.line.sent.length;
  await sendEvents([textEvent(GROUP, `ผูกกลุ่ม ${code}`)]);
  assert.equal(await ctx.repo.getSetting("line_staff_group_id"), GROUP);
  assert.equal(ctx.line.sent.length, before + 1, "ตอบยืนยันในกลุ่ม 1 ครั้ง");
  assert.equal(ctx.line.sent.at(-1).kind, "reply");
  await sendEvents([textEvent(OTHER, `ผูกกลุ่ม ${code}`)]);                 // ใช้ซ้ำจากกลุ่มอื่น
  assert.equal(await ctx.repo.getSetting("line_staff_group_id"), GROUP);

  // หมดอายุ
  const { code: c2 } = (await call(admin, { method: "POST", url: "/api/admin", cookie: adminCookie, body: { action: "createBindCode" } })).json;
  const saved = JSON.parse(await ctx.repo.getSetting("line_bind_code"));
  await ctx.repo.setSetting("line_bind_code", JSON.stringify({ ...saved, exp: Date.now() - 1 }));
  await sendEvents([textEvent(OTHER, `ผูกกลุ่ม ${c2}`)]);
  assert.equal(await ctx.repo.getSetting("line_staff_group_id"), GROUP);

  const status = (await call(admin, { url: "/api/admin?action=lineStatus", cookie: staff })).json;
  assert.equal(status.staffGroup.source, "db");
  assert.ok(!status.staffGroup.id.includes(GROUP), "หลังบ้านเห็น groupId แบบปิดบางส่วน");
  const logs = JSON.stringify(ctx.repo._db.audit);
  assert.ok(!logs.includes(GROUP), "audit log ไม่มี groupId เต็ม");
});

test("ส่งคำสั่งผลิต: staff ส่งได้, ลูกค้าส่งไม่ได้, ใช้ signed URL, retry key เดิมไม่ส่งซ้ำ", async () => {
  // เตรียมงานที่มี Artwork + Mockup
  const customer = await login("customer");
  const idem = ctx.uuid();
  const created = await call(ai, { method: "POST", url: "/api/ai", cookie: customer, body: { action: "create", idempotencyKey: idem, input: { shopName: "บ้านสวน", signText: "CAFE", widthCm: 120, heightCm: 60, lighting: "warm", material: "พลาสวูด" } } });
  const jobId = created.json.job.jobId;
  await call(ai, { method: "POST", url: "/api/ai", cookie: customer, body: { action: "step", jobId, step: "artwork" } });
  await call(ai, { method: "POST", url: "/api/ai", cookie: customer, body: { action: "step", jobId, step: "mockup" } });

  assert.equal((await call(admin, { method: "POST", url: "/api/admin", cookie: customer, body: { action: "sendProductionOrder", jobId } })).status, 403);
  const staff = await login("staff");
  const before = ctx.line.sent.length;
  const r = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "sendProductionOrder", jobId, note: "ลูกค้าโอนมัดจำแล้ว", agreedPrice: 4500 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.mock, true);
  const push = ctx.line.sent.at(-1);
  assert.equal(ctx.line.sent.length, before + 1);
  assert.equal(push.kind, "push");
  assert.equal(push.to, GROUP);
  assert.equal(push.messages.length, 3);
  assert.match(push.messages[0].text, /คำสั่งผลิตใหม่/);
  assert.match(push.messages[0].text, /120 x 60 ซม\./);
  assert.match(push.messages[0].text, /4,500 บาท/);
  assert.ok(!push.messages[0].text.includes("memory-private"), "ไม่มี storage key ในข้อความ");

  // signed URL เปิดไฟล์ได้โดยไม่ต้องมี session; แก้ลายเซ็น/หมดอายุ/เปลี่ยนไฟล์ → 403
  const imgUrl = new URL(push.messages[1].originalContentUrl);
  assert.equal((await call(files, { url: imgUrl.pathname + imgUrl.search, origin: null })).status, 200);
  const tampered = imgUrl.search.replace(/sig=[^&]+/, "sig=AAAA" + imgUrl.searchParams.get("sig").slice(4));
  assert.equal((await call(files, { url: imgUrl.pathname + tampered, origin: null })).status, 403);
  const otherKind = imgUrl.search.replace("kind=artwork", "kind=mockup");
  assert.equal((await call(files, { url: imgUrl.pathname + otherKind, origin: null })).status, 403);
  const expired = new URL(signedFileUrl({ baseUrl: ORIGIN, secret: ctx.config.fileSigningSecret, jobId, kind: "artwork", now: Date.now() - 40 * 86400000 }));
  assert.equal((await call(files, { url: expired.pathname + expired.search, origin: null })).status, 403);

  // ส่งซ้ำด้วย retry key เดิม
  const again = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "sendProductionOrder", jobId, retryKey: r.json.retryKey } });
  assert.equal(again.json.duplicate, true);
  assert.equal(ctx.repo._db.lineOrders.filter((o) => o.job_id === jobId).length, 1);
  const orders = (await call(admin, { url: `/api/admin?action=jobOrders&job=${jobId}`, cookie: staff })).json.orders;
  assert.equal(orders.length, 1);
});

test("ยังไม่ผูกกลุ่ม → ส่งคำสั่งผลิตไม่ได้ · บอทออกจากกลุ่ม → ยกเลิกการผูกอัตโนมัติ", async () => {
  await sendEvents([{ type: "leave", source: { type: "group", groupId: GROUP } }]);
  assert.equal(await ctx.repo.getSetting("line_staff_group_id"), null);
  const staff = await login("staff");
  const job = [...ctx.repo._db.jobs.values()].find((j) => j.artwork_status === "done");
  const r = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "sendProductionOrder", jobId: job.job_id } });
  assert.equal(r.status, 409);
});

test("LINE client จริง (fetch จำลอง): URL/Header/Retry-Key ถูกต้อง, 409 = ส่งไปแล้ว, error โยนต่อ", async () => {
  const { createLineClient } = await import("../api/_lib/line.mjs");
  const calls = [];
  let nextStatus = 200;
  const client = createLineClient({ accessToken: "TEST-TOKEN", fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: nextStatus < 300, status: nextStatus, headers: new Map([["x-line-request-id", "req-123"]]) }; } });
  await client.push(GROUP, [{ type: "text", text: "hi" }], "11111111-2222-3333-4444-555555555555");
  assert.equal(calls[0].url, "https://api.line.me/v2/bot/message/push");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer TEST-TOKEN");
  assert.equal(calls[0].opts.headers["X-Line-Retry-Key"], "11111111-2222-3333-4444-555555555555");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { to: GROUP, messages: [{ type: "text", text: "hi" }] });
  nextStatus = 409;
  assert.deepEqual(await client.push(GROUP, [], "k"), { ok: true, duplicate: true, requestId: "req-123" });
  nextStatus = 200;
  assert.equal((await client.reply("rt", [{ type: "text", text: "x" }])).requestId, "req-123", "เก็บ x-line-request-id");
  nextStatus = 500;
  await assert.rejects(client.push(GROUP, [], "k"), /line_500/);
  assert.equal(createLineClient({ accessToken: "" }), null, "ไม่มี token = ปิดการส่ง");
});
