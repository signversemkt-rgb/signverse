// ทดสอบการเข้าสู่ระบบด้วย Facebook (ค่าเริ่มต้น) · LINE/Google ปิด · การระบุสมาชิกด้วยรหัสผู้ใช้ของ Provider · ไม่เปิดเผย Secret
// ไม่เรียก Facebook / LINE / Neon จริง (เครือข่ายถูกบล็อก)
import test from "node:test";
import assert from "node:assert/strict";

const FB_SECRET = "facebook-app-secret-should-never-leak";
const LINE_SECRET = "line-login-secret-should-never-leak";
process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.FACEBOOK_CLIENT_ID = "1234567890";
process.env.FACEBOOK_CLIENT_SECRET = FB_SECRET;
process.env.LINE_LOGIN_CHANNEL_ID = "2000000001";
process.env.LINE_LOGIN_CHANNEL_SECRET = LINE_SECRET;
process.env.GOOGLE_CLIENT_ID = "google-id";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
delete process.env.AUTH_PROVIDERS;
delete process.env.SMS_PROVIDER;
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const { facebookProfileToUser, lineProfileToUser, socialProviderConfig, enabledLoginMethods, phoneLoginStatus } = await import("../api/_lib/auth.mjs");
const { getContext } = await import("../api/_lib/context.mjs");
const me = (await import("../api/me.mjs")).default;

const ALL = {
  FACEBOOK_CLIENT_ID: "1234567890", FACEBOOK_CLIENT_SECRET: FB_SECRET,
  LINE_LOGIN_CHANNEL_ID: "2000000001", LINE_LOGIN_CHANNEL_SECRET: LINE_SECRET,
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs",
};

test("Better Auth: ค่าเริ่มต้นเปิดเฉพาะ Facebook (App ID/Secret) · ขอแค่ public_profile · LINE/Google ปิด", () => {
  const cfg = socialProviderConfig(ALL);
  assert.deepEqual(Object.keys(cfg), ["facebook"]);
  assert.equal(cfg.facebook.clientId, "1234567890");
  assert.equal(cfg.facebook.clientSecret, FB_SECRET);
  assert.equal(cfg.facebook.disableDefaultScope, true);
  assert.deepEqual(cfg.facebook.scope, ["public_profile"], "ไม่ขออีเมล");
  assert.equal(typeof cfg.facebook.mapProfileToUser, "function");
  assert.deepEqual(socialProviderConfig({ FACEBOOK_CLIENT_ID: "x" }), {}, "ตั้งค่าไม่ครบ = ปิด");
});

test("เปิด LINE / Google คืนได้ด้วย AUTH_PROVIDERS โดยไม่แก้โค้ด (LINE ไม่ใช้ secret ของ OA)", () => {
  assert.deepEqual(Object.keys(socialProviderConfig({ ...ALL, AUTH_PROVIDERS: "facebook,line,phone" })), ["line", "facebook"]);
  assert.deepEqual(enabledLoginMethods({ ...ALL, AUTH_PROVIDERS: "facebook,line,google" }), ["facebook", "line", "google"]);
  assert.deepEqual(socialProviderConfig({ AUTH_PROVIDERS: "line", LINE_CHANNEL_SECRET: "oa-secret", LINE_CHANNEL_ACCESS_TOKEN: "oa-token" }), {}, "ค่าของ Messaging API ไม่เปิด LINE Login");
});

test("/api/me: providers = [\"facebook\"] · เบอร์โทร 'กำลังเตรียมเปิดใช้งาน' เมื่อยังไม่มีผู้ส่ง SMS จริง", async () => {
  assert.deepEqual(enabledLoginMethods(ALL), ["facebook"]);
  assert.deepEqual(enabledLoginMethods({}), [], "ยังไม่ตั้งค่า = ไม่มีปุ่ม");
  assert.equal(phoneLoginStatus(ALL), "coming_soon");
  assert.equal(phoneLoginStatus({ ...ALL, SMS_PROVIDER: "mock", OTP_HASH_SECRET: "x".repeat(40) }), "coming_soon", "SMS จำลองไม่นับว่าพร้อม (Production)");
  assert.equal(phoneLoginStatus({ ...ALL, AUTH_PROVIDERS: "facebook" }), "off");
  const tbs = { SMS_PROVIDER: "thaibulksms", THAIBULKSMS_API_KEY: "k", THAIBULKSMS_API_SECRET: "s", SMS_SENDER_NAME: "SV", OTP_HASH_SECRET: "x".repeat(40) };
  assert.equal(phoneLoginStatus({ ...ALL, ...tbs }), "ready");
  const prod = await getContext({ ...ALL, BETTER_AUTH_URL: "https://signverse-azure.vercel.app" });
  assert.deepEqual(prod.providers, ["facebook"]);
  assert.equal(prod.phoneLogin, "coming_soon");
  assert.equal(prod.phone, undefined, "ไม่มีบริการ OTP บน Production เมื่อยังไม่มี SMS");
});

test("Facebook: ระบุสมาชิกด้วย Facebook User ID — ไม่ใช้อีเมล (กันชนบัญชีเดิม / ไม่รวมบัญชีอัตโนมัติ)", () => {
  const a = facebookProfileToUser({ id: "10221", name: "คุณบี", email: "owner@example.com", email_verified: true });
  assert.match(a.email, /^f[0-9a-f]{24}@facebook\.signverse\.invalid$/);
  assert.equal(a.emailVerified, false);
  assert.equal(a.name, "คุณบี");
  assert.equal(facebookProfileToUser({ id: "10221" }).email, a.email, "คนเดิม = บัญชีเดิม");
  assert.notEqual(facebookProfileToUser({ id: "10222" }).email, a.email, "คนละคน = คนละบัญชี");
  assert.ok(!a.email.includes("10221"));
  assert.equal(facebookProfileToUser({ id: "1", name: " " }).name, "สมาชิก Facebook");
  // บัญชี LINE เดิม (ถ้ามี) ยังได้อีเมลแทนรูปแบบเดิม → ไม่ชนกับบัญชี Facebook
  assert.match(lineProfileToUser({ sub: "U1" }).email, /^l[0-9a-f]{24}@line\.signverse\.invalid$/);
  assert.notEqual(lineProfileToUser({ sub: "10221" }).email, a.email);
});

test("ไม่เปิดเผย App Secret / Channel Secret ทาง /api/me และไม่แสดง Google/LINE", async () => {
  const req = { method: "GET", url: "/api/me", headers: {} };
  const res = { statusCode: 200, headers: {}, body: "", setHeader() {}, end(d) { this.body = String(d); } };
  await me(req, res);
  const body = JSON.parse(res.body);
  assert.ok(!res.body.includes(FB_SECRET) && !res.body.includes(LINE_SECRET));
  assert.deepEqual(body.providers, ["facebook"]);
  assert.equal(body.phoneLogin, "ready", "โหมดทดสอบในเครื่องใช้ SMS จำลอง");
});
