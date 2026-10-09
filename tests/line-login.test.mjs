// ทดสอบ LINE Login: การตั้งค่า Better Auth, การระบุสมาชิกด้วย LINE User ID, /api/me ไม่แสดง Google และไม่เปิดเผย Secret
// ไม่เรียก LINE / Neon จริง (เครือข่ายถูกบล็อก)
import test from "node:test";
import assert from "node:assert/strict";

const SECRET = "line-login-secret-value-should-never-leak";
process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.LINE_LOGIN_CHANNEL_ID = "2000000001";
process.env.LINE_LOGIN_CHANNEL_SECRET = SECRET;
process.env.GOOGLE_CLIENT_ID = "google-id";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
delete process.env.AUTH_PROVIDERS;
delete process.env.SMS_PROVIDER;
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const { lineProfileToUser, socialProviderConfig, enabledLoginMethods } = await import("../api/_lib/auth.mjs");
const { getContext } = await import("../api/_lib/context.mjs");
const me = (await import("../api/me.mjs")).default;

const LINE_ENV = { LINE_LOGIN_CHANNEL_ID: "2000000001", LINE_LOGIN_CHANNEL_SECRET: SECRET, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" };

test("Better Auth: เปิดเฉพาะ LINE จาก LINE_LOGIN_CHANNEL_ID/SECRET · ไม่มี Google", () => {
  const cfg = socialProviderConfig(LINE_ENV);
  assert.deepEqual(Object.keys(cfg), ["line"]);
  assert.equal(cfg.line.clientId, "2000000001");
  assert.equal(cfg.line.clientSecret, SECRET);
  assert.equal(typeof cfg.line.mapProfileToUser, "function");
  assert.deepEqual(socialProviderConfig({ LINE_CHANNEL_SECRET: "oa-secret", LINE_CHANNEL_ACCESS_TOKEN: "oa-token" }), {}, "ไม่ใช้ค่าของ Messaging API");
  assert.deepEqual(socialProviderConfig({ LINE_CLIENT_ID: "old", LINE_CLIENT_SECRET: "old-s" }).line.clientId, "old", "ชื่อเดิมยังใช้ได้");
});

test("/api/me providers: LINE พร้อม (ยังไม่ตั้ง SMS) → [\"line\"] เท่านั้น", async () => {
  assert.deepEqual(enabledLoginMethods(LINE_ENV), ["line"]);
  assert.deepEqual(enabledLoginMethods({}), [], "ยังไม่ตั้งค่า = ไม่มีปุ่ม");
  const prod = await getContext({ ...LINE_ENV, BETTER_AUTH_URL: "https://signverse-azure.vercel.app" });
  assert.deepEqual(prod.providers, ["line"]);
});

test("LINE: ระบุสมาชิกด้วย LINE User ID — อีเมลจริงจาก LINE ไม่ถูกใช้ (กันชนบัญชีเดิม)", () => {
  const a = lineProfileToUser({ sub: "U1111", name: "คุณเอ", email: "owner@example.com" });
  assert.match(a.email, /^l[0-9a-f]{24}@line\.signverse\.invalid$/);
  assert.notEqual(a.email, "owner@example.com");
  assert.equal(a.emailVerified, false, "ไม่รวมบัญชีอัตโนมัติ");
  assert.equal(a.name, "คุณเอ");
  assert.equal(lineProfileToUser({ sub: "U1111" }).email, a.email, "คนเดิม = อีเมลแทนเดิม (บัญชีเดิม)");
  assert.notEqual(lineProfileToUser({ sub: "U2222" }).email, a.email, "คนละคน = คนละบัญชี");
  assert.ok(!a.email.includes("U1111"), "ไม่มี LINE User ID ในอีเมล");
  assert.equal(lineProfileToUser({ sub: "U3", name: "  " }).name, "สมาชิก LINE");
  assert.equal(lineProfileToUser({ sub: "U4", name: "ก".repeat(200) }).name.length, 80);
});

test("ไม่เปิดเผย Channel Secret ทาง /api/me", async () => {
  const req = { method: "GET", url: "/api/me", headers: {} };
  const res = { statusCode: 200, headers: {}, body: "", setHeader() {}, end(d) { this.body = String(d); } };
  await me(req, res);
  assert.ok(!res.body.includes(SECRET));
  assert.ok(!res.body.includes("google"), "ไม่แสดง Google");
});
