// ทดสอบส่งคำสั่งผลิตเข้าแชต LINE OA ของลูกค้า (ทาง A: OA reply, ทาง B: LIFF) — Mock ทั้งหมด ห้ามเรียก LINE จริง
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.LINE_GROUP_ORDERS_ENABLED;      // ค่าเริ่มต้น = ปิดระบบกลุ่ม
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const ai = (await import("../api/ai.mjs")).default;
const admin = (await import("../api/admin.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const webhook = (await import("../api/line/webhook.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const { parseOrderRef } = await import("../api/_lib/orders.mjs");
const ctx = await getContext();
const U = (c) => "U" + c.repeat(32);
const FORM = { shopName: "บ้านสวนคาเฟ่", signText: "BAAN SUAN", widthCm: 180, heightCm: 60, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "warm" };

async function call(handler, { method = "GET", url = "/", body, raw, cookie, origin = ORIGIN, headers = {} } = {}) {
  const req = { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": "1.2.3.4" }, body, rawBody: raw };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  const text = res.body == null ? "" : Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.statusCode, json, text, headers: res.headers };
}
const login = async (role = "customer", provider = "google") => (await call(me, { method: "POST", url: "/api/me?mock=login", body: { role, provider } })).headers["set-cookie"].split(";")[0];
const userIdOf = async (cookie) => (await call(me, { cookie })).json.user.id;
let replySeq = 0;
const msg = (userId, text) => ({ type: "message", webhookEventId: "e" + (++replySeq), replyToken: "rt-" + replySeq, source: { type: "user", userId }, message: { type: "text", id: String(replySeq), text } });
async function hook(events) {
  const raw = Buffer.from(JSON.stringify({ destination: "Ux", events }));
  const sig = createHmac("sha256", ctx.config.lineChannelSecret).update(raw).digest("base64");
  return call(webhook, { method: "POST", url: "/api/line/webhook", raw, origin: null, headers: { "x-line-signature": sig } });
}
const replies = () => ctx.line.sent.filter((s) => s.kind === "reply");

async function orderWithImages(cookie, { png = true } = {}) {
  // ให้สิทธิ์เพิ่มสำหรับการทดสอบที่สร้างหลายงานด้วยบัญชีเดียว
  const uid = await userIdOf(cookie);
  const q = await ctx.repo.getQuota(uid, 1);
  await ctx.repo.tx((t) => t.updateQuota(uid, { free_credits_total: q.free_credits_total + 1 }));
  const c = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: ctx.uuid(), input: FORM } });
  const jobId = c.json.job.jobId;
  await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "step", jobId, step: "artwork" } });
  await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "step", jobId, step: "mockup" } });
  // Mock AI สร้าง PNG ตัวอย่างอยู่แล้ว · png:false = จำลองไฟล์ชนิดที่ LINE ไม่รับ (SVG)
  if (!png) {
    const j = ctx.repo._db.jobs.get(jobId);
    for (const k of ["artwork_storage_key", "mockup_storage_key"]) {
      const f = ctx.storage._priv.get(j[k]);
      const newKey = j[k].replace(".png", ".svg");
      ctx.storage._priv.set(newKey, f);
      j[k] = newKey;
    }
  }
  const o = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "order", idempotencyKey: ctx.uuid(), jobId, input: FORM } });
  return o.json.order;
}

// ---------- ระบบกลุ่มเดิมต้องปิด ----------
test("ระบบส่งเข้ากลุ่ม LINE ปิดเป็นค่าเริ่มต้น: สร้างรหัส/ส่งเข้ากลุ่มไม่ได้, เหตุการณ์กลุ่มถูกข้าม", async () => {
  assert.equal(ctx.config.lineGroupOrdersEnabled, false);
  const adminCookie = await login("admin");
  assert.equal((await call(admin, { method: "POST", url: "/api/admin", cookie: adminCookie, body: { action: "createBindCode" } })).json.code, "feature_disabled");
  const job = { jobId: "x".repeat(32) };
  assert.equal((await call(admin, { method: "POST", url: "/api/admin", cookie: adminCookie, body: { action: "sendProductionOrder", jobId: job.jobId } })).json.code, "feature_disabled");
  await hook([{ type: "join", replyToken: "r", source: { type: "group", groupId: "C" + "a1".repeat(16) } }]);
  assert.equal(ctx.repo._db.lineGroups.size, 0);
  assert.equal(ctx.line.sent.filter((s) => s.kind === "push").length, 0, "ไม่มี push เข้ากลุ่ม");
  const st = (await call(admin, { url: "/api/admin?action=lineStatus", cookie: adminCookie })).json;
  assert.equal(st.groupOrdersEnabled, false);
});

// ---------- ทาง A ----------
test("สั่งผลิต: บันทึกก่อน, สถานะ 'รอส่งผ่าน LINE', ข้อความมีเลขออร์เดอร์ + รหัสยืนยัน", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie);
  assert.equal(o.lineDelivery.status, "awaiting_customer");
  assert.equal(o.lineDelivery.label, "รอส่งผ่าน LINE");
  const ref = parseOrderRef(o.lineText);
  assert.equal(ref.orderNo, o.orderNo);
  assert.match(ref.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(o.status, "new", "สถานะการผลิตแยกจากสถานะการส่ง");
});

test("ลูกค้าส่งข้อความใน LINE → OA reply รูปจริง 2 รูป ในห้องของผู้ส่ง ครั้งเดียว + ผูก LINE userId", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie);
  const before = replies().length;
  const ev = msg(U("a"), o.lineText);
  assert.equal((await hook([ev])).status, 200);
  const r = replies();
  assert.equal(r.length, before + 1);
  const reply = r.at(-1);
  assert.equal(reply.replyToken, ev.replyToken, "ตอบด้วย replyToken ของข้อความนั้น = ห้องแชตของผู้ส่ง");
  assert.equal(reply.messages.length, 3);
  assert.match(reply.messages[0].text, new RegExp(o.orderNo));
  const imgs = reply.messages.filter((m) => m.type === "image");
  assert.equal(imgs.length, 2);
  for (const im of imgs) {
    const u = new URL(im.originalContentUrl);
    assert.ok(u.searchParams.get("sig") && u.searchParams.get("exp"), "ลิงก์มีลายเซ็น + หมดอายุ");
    assert.equal((await call(files, { url: u.pathname + u.search, origin: null })).status, 200);
  }
  const mine = (await call(ai, { url: "/api/ai?orders=1", cookie })).json.orders.find((x) => x.orderId === o.orderId);
  assert.equal(mine.lineDelivery.status, "sent");
  assert.equal(mine.lineDelivery.channel, "oa_reply");
  assert.equal(mine.lineDelivery.lineUserLinked, true);
  assert.equal(mine.status, "new");
  assert.equal(ctx.repo._db.orders.get(o.orderId).line_user_id, U("a"));

  // LINE ส่ง webhook ซ้ำ / ลูกค้าส่งข้อความเดิมอีกครั้ง → ไม่ส่งซ้ำ
  await hook([ev]);
  await hook([msg(U("a"), o.lineText)]);
  assert.equal(replies().length, before + 1);
});

test("คนอื่นนำข้อความ/รหัสไปส่ง → ไม่ส่งรูป · รหัสผิด → เงียบ · ข้อความทั่วไป → ไม่ตอบ (ไม่กระทบแชตพนักงาน)", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie);
  await hook([msg(U("b"), o.lineText)]);                         // ผูกกับ U(b)
  const before = replies().length;
  await hook([msg(U("c"), o.lineText)]);                         // คนอื่น
  const last = replies().at(-1);
  assert.equal(replies().length, before + 1);
  assert.ok(!last.messages.some((m) => m.type === "image"), "ไม่ส่งรูปให้บัญชีอื่น");
  assert.match(last.messages[0].text, /ไม่สามารถยืนยัน/);

  const o2 = await orderWithImages(cookie);
  const b2 = replies().length;
  await hook([msg(U("d"), o2.lineText.replace(/รหัสยืนยัน: .+$/m, "รหัสยืนยัน: AAAA-BBBB"))]);
  await hook([msg(U("d"), "สวัสดีค่ะ อยากสอบถามราคาป้าย")]);
  await hook([msg(U("d"), `ขอสถานะออร์เดอร์ ${o2.orderNo}`)]);  // มีเลขแต่ไม่มีรหัส
  assert.equal(replies().length, b2, "ไม่ตอบอัตโนมัติ → พนักงานตอบเองตามปกติ");
  assert.equal(ctx.repo._db.orders.get(o2.orderId).line_delivery_status, "awaiting_customer");
});

test("เจ้าของออร์เดอร์ล็อกอินเว็บด้วย LINE → ต้องเป็นบัญชี LINE เดียวกันเท่านั้น", async () => {
  const cookie = await login("customer", "line");
  const uid = await userIdOf(cookie);
  ctx.repo._db.identities.find((i) => i.userId === uid).accountId = U("e");   // LINE userId จาก LINE Login (provider เดียวกับ OA)
  const o = await orderWithImages(cookie);
  const before = replies().length;
  await hook([msg(U("f"), o.lineText)]);
  assert.ok(!replies().at(-1).messages.some((m) => m.type === "image"));
  assert.equal(ctx.repo._db.orders.get(o.orderId).line_user_id, null, "ไม่ผูกกับบัญชีผิด");
  await hook([msg(U("e"), o.lineText)]);
  assert.equal(replies().at(-1).messages.filter((m) => m.type === "image").length, 2);
  assert.equal(replies().length, before + 2);
});

test("reply ล้มเหลว → สถานะ 'ส่งไม่สำเร็จ' และลูกค้าส่งใหม่ได้ · webhook พร้อมกันส่งได้ครั้งเดียว", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie);
  const realReply = ctx.line.reply;
  ctx.line.reply = async () => { throw Object.assign(new Error("x"), { status: 500 }); };
  await hook([msg(U("7"), o.lineText)]);
  ctx.line.reply = realReply;
  assert.equal(ctx.repo._db.orders.get(o.orderId).line_delivery_status, "failed");
  const before = replies().length;
  await Promise.all([hook([msg(U("7"), o.lineText)]), hook([msg(U("7"), o.lineText)]), hook([msg(U("7"), o.lineText)])]);
  assert.equal(replies().length, before + 1, "คำขอพร้อมกันส่งได้ครั้งเดียว");
  assert.equal(ctx.repo._db.orders.get(o.orderId).line_delivery_status, "sent");
});

test("ภาพที่ LINE ไม่รับ (เช่น SVG ของ Mock) ไม่ถูกส่งเป็นรูป แต่ยังส่งข้อความยืนยัน", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie, { png: false });
  await hook([msg(U("8"), o.lineText)]);
  const r = replies().at(-1);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].text, /ทีมงานจะเปิดดูจากระบบ/);
});

test("หลังบ้าน: เห็นสถานะการส่งแยกจากสถานะการผลิต", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie);
  await hook([msg(U("9"), o.lineText)]);
  const staff = await login("staff");
  const d = (await call(admin, { url: `/api/admin?action=order&id=${o.orderId}`, cookie: staff })).json;
  assert.equal(d.order.status, "new");
  assert.equal(d.order.lineDelivery.status, "sent");
  assert.ok(d.job.artwork.url && d.job.mockup.url);
});

// ---------- ทาง B: LIFF ----------
test("LIFF: ตรวจ ID token, เห็นเฉพาะออร์เดอร์ของตัวเอง, เตรียมข้อความครั้งเดียว, รายงานผล", async () => {
  const cookie = await login("customer", "line");
  const uid = await userIdOf(cookie);
  ctx.repo._db.identities.find((i) => i.userId === uid).accountId = U("1");
  const o = await orderWithImages(cookie);
  const post = (body) => call(ai, { method: "POST", url: "/api/ai", body });
  assert.equal((await post({ action: "liffOrders", idToken: "forged-token-value" })).status, 401);
  const list = (await post({ action: "liffOrders", idToken: `mock:${U("1")}` })).json.orders;
  assert.ok(list.some((x) => x.orderId === o.orderId));
  assert.ok(!(await post({ action: "liffOrders", idToken: `mock:${U("2")}` })).json.orders.some((x) => x.orderId === o.orderId));
  assert.equal((await post({ action: "liffPrepare", idToken: `mock:${U("2")}`, orderId: o.orderId })).status, 404, "บัญชีอื่นเตรียมส่งไม่ได้");
  const prep = await post({ action: "liffPrepare", idToken: `mock:${U("1")}`, orderId: o.orderId });
  assert.equal(prep.status, 200);
  assert.equal(prep.json.messages.filter((m) => m.type === "image").length, 2);
  assert.match(prep.json.messages[0].text, /รหัสยืนยัน/);
  assert.equal((await post({ action: "liffPrepare", idToken: `mock:${U("1")}`, orderId: o.orderId })).status, 409, "กดซ้ำระหว่างส่ง → ไม่ส่งซ้ำ");
  await post({ action: "liffResult", idToken: `mock:${U("1")}`, orderId: o.orderId, ok: true });
  const v = ctx.repo._db.orders.get(o.orderId);
  assert.equal(v.line_delivery_status, "sent");
  assert.equal(v.line_delivery_channel, "liff");
  // ข้อความที่ลูกค้าส่งผ่าน LIFF (มีรหัส) ถูกส่งเข้ามาที่ webhook อีกที → ไม่ reply ซ้ำ
  const before = replies().length;
  await hook([msg(U("1"), prep.json.messages[0].text)]);
  assert.equal(replies().length, before);
});


// ---------- ความปลอดภัยเพิ่มเติม ----------
test("ระบบกลุ่มปิดสมบูรณ์: push ถูกปิดที่ระดับ client และไม่มีขั้นตอนใดเรียก push", async () => {
  await assert.rejects(ctx.line.push("C" + "a1".repeat(16), [{ type: "text", text: "x" }]), { code: "feature_disabled" });
  let pushes = 0;
  const guarded = ctx.line.push;
  ctx.line.push = async (...a) => { pushes++; return guarded(...a); };
  const cookie = await login();
  const o = await orderWithImages(cookie);
  await hook([msg(U("3"), o.lineText)]);
  await hook([{ type: "join", replyToken: "r", source: { type: "group", groupId: "C" + "b2".repeat(16) } }]);
  await hook([{ type: "message", replyToken: "r2", source: { type: "group", groupId: "C" + "b2".repeat(16), userId: U("3") }, message: { type: "text", id: "9", text: "ผูกกลุ่ม SV-AAAAAAAA" } }]);
  const adminCookie = await login("admin");
  await call(admin, { method: "POST", url: "/api/admin", cookie: adminCookie, body: { action: "sendProductionOrder", jobId: o.jobId } });
  ctx.line.push = guarded;
  assert.equal(pushes, 0, "ไม่มีการเรียก push เลย");
  assert.equal(ctx.line.sent.filter((s) => s.kind === "push").length, 0);
});

test("บันทึกหลักฐานการส่งจริง (request id จาก LINE) + Mock ใช้ PNG ที่ LINE รับได้", async () => {
  const cookie = await login();
  const o = await orderWithImages(cookie);
  await hook([msg(U("4"), o.lineText)]);
  const row = ctx.repo._db.orders.get(o.orderId);
  assert.equal(row.line_delivery_status, "sent");
  assert.match(row.line_request_id, /^mock-req-/);
  const img = replies().at(-1).messages.find((m) => m.type === "image");
  const u = new URL(img.originalContentUrl);
  const r = await call(files, { url: u.pathname + u.search, origin: null });
  assert.equal(r.headers["content-type"], "image/png");
  const staff = await login("staff");
  const d = (await call(admin, { url: `/api/admin?action=order&id=${o.orderId}`, cookie: staff })).json;
  assert.match(d.order.lineDelivery.requestId, /^mock-req-/);
});

test("FILE_SIGNING_SECRET: ไม่มี/สั้นเกิน → ไม่ส่งรูป ไม่สร้างลิงก์ และลิงก์เดิมใช้ไม่ได้", async () => {
  const { signedFileUrl, verifyFileSig } = await import("../api/_lib/line.mjs");
  assert.equal(signedFileUrl({ baseUrl: ORIGIN, secret: "short", jobId: "a".repeat(32), kind: "artwork" }), null);
  assert.equal(signedFileUrl({ baseUrl: ORIGIN, secret: "", jobId: "a".repeat(32), kind: "artwork" }), null);
  assert.equal(verifyFileSig({ secret: "short", jobId: "a".repeat(32), kind: "artwork", exp: "9999999999", sig: "x" }), false);
  const cookie = await login();
  const o = await orderWithImages(cookie);
  const saved = ctx.config.fileSigningSecret;
  ctx.config.fileSigningSecret = "too-short";
  await hook([msg(U("5"), o.lineText)]);
  ctx.config.fileSigningSecret = saved;
  const r = replies().at(-1);
  assert.equal(r.messages.filter((m) => m.type === "image").length, 0);
  assert.match(r.messages[0].text, /ทีมงานจะเปิดดูจากระบบ/);
});

test("ลิงก์รูปผูกกับงาน+ชนิดภาพ+วันหมดอายุ: แก้ค่าใดค่าหนึ่งแล้วใช้ไม่ได้ · secret ต่างกันใช้ไม่ได้", async () => {
  const { signedFileUrl, verifyFileSig } = await import("../api/_lib/line.mjs");
  const secret = "x".repeat(40);
  const u = new URL(signedFileUrl({ baseUrl: ORIGIN, secret, jobId: "a".repeat(32), kind: "artwork" }));
  const base = { secret, jobId: "a".repeat(32), kind: "artwork", exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") };
  assert.equal(verifyFileSig(base), true);
  assert.equal(verifyFileSig({ ...base, jobId: "b".repeat(32) }), false);
  assert.equal(verifyFileSig({ ...base, kind: "mockup" }), false);
  assert.equal(verifyFileSig({ ...base, exp: String(Number(base.exp) + 1) }), false);
  assert.equal(verifyFileSig({ ...base, secret: "y".repeat(40) }), false, "เปลี่ยน secret = ลิงก์เดิมทั้งหมดใช้ไม่ได้ (เพิกถอนได้)");
});

test("LINE Login ที่ไม่ใช่รูปแบบ userId ของ Provider เดียวกัน → ไม่ใช้ผูก (ใช้รหัสยืนยันแทน)", async () => {
  const cookie = await login("customer", "line");
  const uid = await userIdOf(cookie);
  ctx.repo._db.identities.find((i) => i.userId === uid).accountId = "not-a-line-user-id";
  const o = await orderWithImages(cookie);
  await hook([msg(U("6"), o.lineText)]);
  assert.equal(ctx.repo._db.orders.get(o.orderId).line_delivery_status, "sent");
  assert.equal(ctx.repo._db.orders.get(o.orderId).line_user_id, U("6"));
});
