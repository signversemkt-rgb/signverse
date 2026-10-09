// ทดสอบเข้าสู่ระบบด้วยเบอร์โทร + OTP และการตั้งค่าวิธีเข้าสู่ระบบ (LINE / เบอร์โทร · Google ปิด)
// SMS จำลองเท่านั้น — เครือข่ายถูกบล็อก ไม่ส่ง SMS จริง
import test from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
delete process.env.VERCEL_ENV;
delete process.env.AUTH_PROVIDERS;
delete process.env.SMS_PROVIDER;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const P = await import("../api/_lib/phone.mjs");
const { createMemoryRepo } = await import("../api/_lib/repo-memory.mjs");
const { enabledLoginMethods, enabledProviders } = await import("../api/_lib/auth.mjs");
const authRoute = (await import("../api/auth/[...all].mjs")).default;
const me = (await import("../api/me.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const ctx = await getContext();

const SECRET = "test-otp-hash-secret-0123456789abcdef";
const PHONE = "+66812345678";
let seq = 0;
const uuid = () => `id${String(++seq).padStart(6, "0")}`;

// บริการ OTP พร้อมนาฬิกาที่เลื่อนเวลาได้
function setup({ limits = {}, failSms = false } = {}) {
  const repo = createMemoryRepo({ uuid });
  const sent = [];
  const sms = { name: "mock", async send(phone, message) { if (failSms) throw Object.assign(new Error("down"), { status: 500 }); sent.push({ phone, message }); } };
  const clock = { t: Date.parse("2026-10-09T03:00:00Z") };
  const logs = [];
  const logger = { error: (...a) => logs.push(a.join(" ")), log: (...a) => logs.push(a.join(" ")) };
  const otp = P.createOtpService({ repo, sms, secret: SECRET, uuid, limits, now: () => clock.t, logger });
  const lastCode = () => /(\d{6})/.exec(sent.at(-1).message)[1];
  return { repo, sent, clock, otp, lastCode, logs };
}
const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

// ---------- รูปแบบเบอร์ / การปิดบัง ----------
test("แปลงเบอร์มือถือไทย 06/08/09 เป็น E.164 และปฏิเสธเบอร์อื่น", () => {
  assert.equal(P.normalizeThaiMobile("081-234-5678"), PHONE);
  assert.equal(P.normalizeThaiMobile("0812345678"), PHONE);
  assert.equal(P.normalizeThaiMobile("+66 81 234 5678"), PHONE);
  assert.equal(P.normalizeThaiMobile("66812345678"), PHONE);
  assert.equal(P.normalizeThaiMobile("0612345678"), "+66612345678");
  assert.equal(P.normalizeThaiMobile("0912345678"), "+66912345678");
  for (const bad of ["021234567", "0712345678", "081234567", "08123456789", "+15551234567", "abc", "", null]) assert.equal(P.normalizeThaiMobile(bad), null, String(bad));
  assert.equal(P.maskPhone(PHONE), "081-xxx-5678");
  const email = P.phoneTempEmail(PHONE);
  assert.match(email, /@phone\.signverse\.invalid$/);
  assert.ok(!email.includes("812345678"), "อีเมลแทนต้องไม่มีเบอร์");
});

test("ข้อความ SMS สั้นพอสำหรับ 1 เครดิต (≤ 70 ตัวอักษร)", () => {
  assert.ok(P.otpMessage("123456").length <= 70, String(P.otpMessage("123456").length));
});

// ---------- ส่ง OTP ----------
test("ส่ง OTP สำเร็จ: เก็บเฉพาะ hash ไม่มีรหัสหรือเบอร์เต็มในฐานข้อมูล", async () => {
  const { repo, sent, otp, lastCode } = setup();
  const r = await otp.send({ phone: PHONE, ip: "1.1.1.1" });
  assert.deepEqual(r, { resendAfter: 60, expiresIn: 300 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, PHONE);
  const rows = [...repo._db.otp.values()];
  assert.equal(rows.length, 1);
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes(lastCode()), "ไม่เก็บรหัส OTP");
  assert.ok(!raw.includes("812345678"), "ไม่เก็บเบอร์เต็ม");
  assert.ok(!raw.includes("1.1.1.1"), "ไม่เก็บ IP เต็ม");
});

test("ส่ง OTP ไม่สำเร็จ: เบอร์ไม่ถูกต้อง / ผู้ให้บริการ SMS ล่ม (ลบคำขอ และ Log ไม่มีเบอร์เต็ม)", async () => {
  const a = setup();
  await assert.rejects(a.otp.send({ phone: "0812345678", ip: "x" }), (e) => e.code === "invalid_phone");
  const b = setup({ failSms: true });
  await assert.rejects(b.otp.send({ phone: PHONE, ip: "x" }), (e) => e.status === 502 && e.code === "sms_failed");
  assert.equal(b.repo._db.otp.size, 0);
  assert.ok(b.logs.length && b.logs.every((l) => !l.includes("812345678")));
});

// ---------- ตรวจ OTP ----------
test("OTP ถูกต้อง → ผ่านครั้งเดียว · ใช้ซ้ำไม่ได้", async () => {
  const { otp, lastCode } = setup();
  await otp.send({ phone: PHONE, ip: "x" });
  const code = lastCode();
  assert.equal(await otp.verify({ phone: PHONE, code }), true);
  await assert.rejects(otp.verify({ phone: PHONE, code }), (e) => e.code === "otp_not_found");
});

test("OTP ผิด → กรอกผิดได้ไม่เกิน 5 ครั้ง แล้วรหัสที่ถูกก็ใช้ไม่ได้", async () => {
  const { otp, lastCode } = setup();
  await otp.send({ phone: PHONE, ip: "x" });
  const code = lastCode();
  for (let i = 1; i <= 4; i++) await assert.rejects(otp.verify({ phone: PHONE, code: wrong(code) }), (e) => e.code === "otp_invalid", `ครั้งที่ ${i}`);
  await assert.rejects(otp.verify({ phone: PHONE, code: wrong(code) }), (e) => e.code === "otp_too_many_attempts");
  await assert.rejects(otp.verify({ phone: PHONE, code }), (e) => e.code === "otp_too_many_attempts");
  await assert.rejects(otp.verify({ phone: PHONE, code: "12ab56" }), (e) => e.code === "otp_invalid");
});

test("OTP หมดอายุหลัง 5 นาที", async () => {
  const { otp, lastCode, clock } = setup();
  await otp.send({ phone: PHONE, ip: "x" });
  const code = lastCode();
  clock.t += 300 * 1000 + 1;
  await assert.rejects(otp.verify({ phone: PHONE, code }), (e) => e.code === "otp_expired");
});

test("Race Condition: ยืนยันรหัสเดียวกันพร้อมกัน 5 คำขอ → ผ่านเพียง 1", async () => {
  const { otp, lastCode } = setup();
  await otp.send({ phone: PHONE, ip: "x" });
  const code = lastCode();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => otp.verify({ phone: PHONE, code })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

// ---------- ส่งซ้ำ / Rate limit ----------
test("ส่งซ้ำได้หลัง 60 วินาที และรหัสเก่าใช้ไม่ได้เมื่อขอรหัสใหม่", async () => {
  const { otp, lastCode, clock } = setup();
  await otp.send({ phone: PHONE, ip: "x" });
  const first = lastCode();
  clock.t += 30 * 1000;
  await assert.rejects(otp.send({ phone: PHONE, ip: "x" }), (e) => e.code === "otp_resend_wait" && e.retryAfter === 30);
  clock.t += 31 * 1000;
  await otp.send({ phone: PHONE, ip: "x" });
  const second = lastCode();
  if (first !== second) await assert.rejects(otp.verify({ phone: PHONE, code: first }), (e) => e.code === "otp_invalid");
  assert.equal(await otp.verify({ phone: PHONE, code: second }), true);
});

test("จำกัดการขอ OTP ต่อเบอร์ ต่อ IP และเพดาน SMS ทั้งระบบต่อวัน (กัน SMS Bombing)", async () => {
  const perPhone = setup();
  for (let i = 0; i < 5; i++) { await perPhone.otp.send({ phone: PHONE, ip: `10.0.0.${i}` }); perPhone.clock.t += 61 * 1000; }
  await assert.rejects(perPhone.otp.send({ phone: PHONE, ip: "10.0.0.99" }), (e) => e.status === 429 && e.code === "otp_rate_limited");
  assert.equal(perPhone.sent.length, 5);

  const perIp = setup();
  for (let i = 0; i < 10; i++) await perIp.otp.send({ phone: `+668123400${String(i).padStart(2, "0")}`, ip: "6.6.6.6" });
  await assert.rejects(perIp.otp.send({ phone: "+66812340099", ip: "6.6.6.6" }), (e) => e.code === "otp_rate_limited");

  const daily = setup({ limits: { dailyTotal: 3 } });
  for (let i = 0; i < 3; i++) await daily.otp.send({ phone: `+669000000${i}0`, ip: `7.7.7.${i}` });
  await assert.rejects(daily.otp.send({ phone: "+66900000099", ip: "7.7.7.99" }), (e) => e.code === "otp_daily_limit");
  assert.equal(daily.sent.length, 3, "ไม่ส่ง SMS เกินเพดาน");
});

// ---------- ห้ามใช้ OTP จำลองบน Production / การตั้งค่าวิธีเข้าสู่ระบบ ----------
test("Production: SMS จำลองใช้ไม่ได้ และต้องมี secret ยาวพอ", () => {
  assert.equal(P.createSmsClient({ provider: "mock", env: {}, mock: false }), null);
  assert.equal(P.phoneLoginConfig({ SMS_PROVIDER: "mock", OTP_HASH_SECRET: SECRET }, { mock: false }).ready, false);
  assert.equal(P.phoneLoginConfig({}, { mock: false }).ready, false, "ไม่ตั้งค่า = ปิด");
  const tbs = { SMS_PROVIDER: "thaibulksms", THAIBULKSMS_API_KEY: "k", THAIBULKSMS_API_SECRET: "s", SMS_SENDER_NAME: "SIGNVERSE" };
  assert.equal(P.phoneLoginConfig({ ...tbs, OTP_HASH_SECRET: "short" }).ready, false);
  assert.equal(P.phoneLoginConfig({ ...tbs, OTP_HASH_SECRET: SECRET }).ready, true);
  assert.throws(() => P.createOtpService({ repo: {}, sms: {}, secret: "short", uuid }), /otp_secret_missing/);
});

test("วิธีเข้าสู่ระบบ: ค่าเริ่มต้น LINE + เบอร์โทร · Google ไม่แสดงแม้มีค่า · ไม่ใช้ secret ของ Messaging API", () => {
  const base = { DATABASE_URL: "x", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" };
  assert.deepEqual(enabledProviders(base), [], "Google ปิดเป็นค่าเริ่มต้น");
  assert.deepEqual(enabledProviders({ ...base, LINE_CHANNEL_SECRET: "messaging-secret" }), [], "secret ของ OA ไม่เปิด LINE Login");
  const line = { ...base, LINE_LOGIN_CHANNEL_ID: "200", LINE_LOGIN_CHANNEL_SECRET: "ls" };
  assert.deepEqual(enabledProviders(line), ["line"]);
  const phone = { SMS_PROVIDER: "thaibulksms", THAIBULKSMS_API_KEY: "k", THAIBULKSMS_API_SECRET: "s", SMS_SENDER_NAME: "SV", OTP_HASH_SECRET: SECRET };
  assert.deepEqual(enabledLoginMethods({ ...line, ...phone }), ["line", "phone"]);
  assert.deepEqual(enabledLoginMethods({ ...line, ...phone, AUTH_PROVIDERS: "line,phone,google" }), ["line", "phone", "google"], "เปิด Google คืนได้ด้วย AUTH_PROVIDERS");
  assert.deepEqual(enabledLoginMethods({ ...line }), ["line"], "SMS ยังไม่ตั้ง = ไม่แสดงเบอร์โทร");
  assert.deepEqual(enabledLoginMethods({}, { mock: true }), ["line", "phone"]);
});

test("ThaiBulkSMS: รูปแบบคำขอถูกต้อง (Basic Auth, เบอร์ไทย, ชื่อผู้ส่ง) และแจ้งเมื่อส่งไม่สำเร็จ", async () => {
  const calls = [];
  const env = { THAIBULKSMS_API_KEY: "key1", THAIBULKSMS_API_SECRET: "sec1", SMS_SENDER_NAME: "SIGNVERSE" };
  const ok = P.createSmsClient({ provider: "thaibulksms", env, fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201 }; } });
  await ok.send(PHONE, "รหัส 123456");
  assert.equal(calls[0].url, "https://api-v2.thaibulksms.com/sms");
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from("key1:sec1").toString("base64")}`);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get("msisdn"), "0812345678");
  assert.equal(form.get("sender"), "SIGNVERSE");
  const bad = P.createSmsClient({ provider: "thaibulksms", env, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(bad.send(PHONE, "x"), (e) => e.status === 401);
  assert.equal(P.createSmsClient({ provider: "thaibulksms", env: { THAIBULKSMS_API_KEY: "k" } }), null, "ตั้งค่าไม่ครบ = ไม่เปิด");
});

// ---------- ผ่าน API (โหมดทดสอบ) : สมัครใหม่ / ลูกค้าเดิม / Session / ออกจากระบบ / เครดิต ----------
async function call(handler, { method = "GET", url = "/", body, cookie, origin = ORIGIN, ip = "8.8.8.8" } = {}) {
  const req = { method, url, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": ip }, body };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(d) { this.body = d; } };
  await handler(req, res);
  let json = null; try { json = JSON.parse(String(res.body)); } catch {}
  return { status: res.statusCode, json, headers: res.headers };
}
const codeFor = (phone) => /(\d{6})/.exec(ctx.sms.sent.filter((s) => s.phone === phone).at(-1).message)[1];
async function phoneLogin(phone, ip) {
  const s = await call(authRoute, { method: "POST", url: "/api/auth/phone-number/send-otp", body: { phoneNumber: phone }, ip });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const v = await call(authRoute, { method: "POST", url: "/api/auth/phone-number/verify", body: { phoneNumber: phone, code: codeFor(phone) }, ip });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return v.headers["set-cookie"].split(";")[0];
}

test("API: แสดงเฉพาะ LINE + เบอร์โทร (ไม่มี Google)", async () => {
  const m = (await call(me)).json;
  assert.deepEqual(m.providers, ["line", "phone"]);
});

test("API: สมาชิกใหม่ด้วยเบอร์โทร → สร้างบัญชี + ได้สิทธิ์ฟรี 1 งาน · ชื่อเป็นเบอร์ที่ปิดบัง", async () => {
  const cookie = await phoneLogin("+66898765432", "20.0.0.1");
  const m = (await call(me, { cookie })).json;
  assert.equal(m.user.name, "089-xxx-5432");
  assert.ok(!JSON.stringify(m).includes("898765432"), "/api/me ไม่มีเบอร์เต็ม");
  assert.deepEqual(m.quota, { total: 1, used: 0, reserved: 0, remaining: 1 });
});

test("API: ลูกค้าเดิมเข้าสู่ระบบซ้ำ → บัญชีเดิม ไม่สร้างซ้ำ และไม่ได้เครดิตฟรีเพิ่ม", async () => {
  const phone = "+66611112222";
  const first = await phoneLogin(phone, "20.0.0.2");
  const id1 = (await call(me, { cookie: first })).json.user.id;
  // ใช้สิทธิ์ไปแล้ว 1 ครั้ง (จำลอง) แล้วออกจากระบบ
  await ctx.repo.tx(async (t) => { const q = await t.getQuotaForUpdate(id1, 1); await t.updateQuota(id1, { free_credits_used: q.free_credits_used + 1 }); });
  const out = await call(authRoute, { method: "POST", url: "/api/auth/sign-out", body: {}, cookie: first });
  assert.equal(out.status, 200);
  assert.match(out.headers["set-cookie"], /Max-Age=0/);
  ctx.sms.sent.length = 0;
  const usersBefore = ctx.repo._db.users.size;
  // ต้องรอ 60 วินาทีก่อนขอรหัสใหม่ของเบอร์เดิม → จำลองด้วยการเลื่อนเวลาคำขอเดิม
  for (const r of ctx.repo._db.otp.values()) r.created_at = new Date(Date.now() - 120000).toISOString();
  const again = await phoneLogin(phone, "20.0.0.3");
  const m = (await call(me, { cookie: again })).json;
  assert.equal(m.user.id, id1, "บัญชีเดิม");
  assert.equal(ctx.repo._db.users.size, usersBefore, "ไม่สร้างบัญชีซ้ำ");
  assert.deepEqual(m.quota, { total: 1, used: 1, reserved: 0, remaining: 0 }, "ไม่ได้เครดิตฟรีใหม่");
});

test("API: Session — ไม่มี cookie = ไม่ได้ล็อกอิน · OTP ผิดไม่ได้ cookie · คำขอจากเว็บอื่นถูกปฏิเสธ", async () => {
  assert.equal((await call(me)).json.user, null);
  const phone = "+66922223333";
  await call(authRoute, { method: "POST", url: "/api/auth/phone-number/send-otp", body: { phoneNumber: phone }, ip: "20.0.0.4" });
  const bad = await call(authRoute, { method: "POST", url: "/api/auth/phone-number/verify", body: { phoneNumber: phone, code: wrong(codeFor(phone)) }, ip: "20.0.0.4" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "otp_invalid");
  assert.match(bad.json.error, /รหัส OTP ไม่ถูกต้อง/);
  assert.equal(bad.headers["set-cookie"], undefined);
  const evil = await call(authRoute, { method: "POST", url: "/api/auth/phone-number/send-otp", body: { phoneNumber: "+66933334444" }, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const badPhone = await call(authRoute, { method: "POST", url: "/api/auth/phone-number/send-otp", body: { phoneNumber: "021234567" }, ip: "20.0.0.5" });
  assert.equal(badPhone.status, 400);
  assert.equal(badPhone.json.code, "invalid_phone");
});

test("API: LINE (โหมดทดสอบ) ยังเข้าสู่ระบบได้ และแยกบัญชีจากเบอร์โทร (ไม่รวมอัตโนมัติ)", async () => {
  const r = await call(me, { method: "POST", url: "/api/me?mock=login", body: { role: "customer", provider: "line" } });
  const lineCookie = r.headers["set-cookie"].split(";")[0];
  const lineUser = (await call(me, { cookie: lineCookie })).json.user;
  assert.ok(lineUser);
  const phoneCookie = await phoneLogin("+66944445555", "20.0.0.6");
  const phoneUser = (await call(me, { cookie: phoneCookie })).json.user;
  assert.notEqual(lineUser.id, phoneUser.id);
});
