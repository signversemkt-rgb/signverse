// ทดสอบโหมดทดสอบ AI จริงของเจ้าของเว็บ (AI_TEST_MODE + รหัส) — ไม่เรียก OpenAI จริง (ผู้สร้างภาพจำลอง)
import test from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.GUEST_AI_ENABLED;
delete process.env.AI_TEST_MODE;
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const CODE = "correct-horse-battery-staple";
const ai = (await import("../api/ai.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const upload = (await import("../api/upload.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const { aiTestConfig, readTestSession } = await import("../api/_lib/aitest.mjs");
const ctx = await getContext();
const mockAi = ctx.ai;
const SECRET = "x".repeat(40);
const FORM = { shopName: "ร้านทดสอบโหมดเจ้าของ", signText: "OWNER TEST", widthCm: 150, heightCm: 50, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none", colors: "น้ำเงิน", style: "มินิมอล" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ผู้สร้างภาพจำลองที่ "เป็น AI จริง" (ไม่ใช่ mock) และคิดค่าใช้จ่ายต่อภาพ
function fakeOpenAI({ costUsd = 0.05, fail = null } = {}) {
  const img = (n) => ({ bytes: new Uint8Array([n, n]), mime: "image/png", ext: "png", original: { bytes: new Uint8Array([9, n]), mime: "image/png", ext: "png" }, costUsd });
  return {
    name: "openai", calls: 0,
    async generateArtwork() { this.calls++; if (fail) throw fail; return img(1); },
    async generateMockup() { this.calls++; return img(2); },
  };
}

async function call(handler, { method = "GET", url = "/", body, cookie, origin = ORIGIN, ip = "7.7.7.7" } = {}) {
  const req = { method, url, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": ip }, body };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, end(d) { this.body = d; } };
  await handler(req, res);
  let json = null; try { json = JSON.parse(Buffer.isBuffer(res.body) ? "" : String(res.body)); } catch {}
  return { status: res.statusCode, json, headers: res.headers, raw: Buffer.isBuffer(res.body) ? "" : String(res.body) };
}
const cookieOf = (r) => [].concat(r.headers["set-cookie"] || []).find((c) => c.startsWith("sv_aitest="));
const post = (cookie, body, ip) => call(ai, { method: "POST", url: "/api/ai", cookie, body, ip });
const idem = () => ctx.uuid();
let ipN = 0;
const ip = () => `10.9.0.${++ipN}`;

function mode({ enabled = true, provider = fakeOpenAI(), code = CODE, budgetThb, maxJobs } = {}) {
  ctx.ai = provider;
  ctx.aiMockStaffOnly = provider === mockAi;
  ctx.config.aiTest = { ...aiTestConfig({ AI_TEST_MODE: enabled ? "true" : "", AI_TEST_CODE: code, BETTER_AUTH_SECRET: SECRET }), ...(budgetThb != null ? { budgetThb } : {}), ...(maxJobs != null ? { maxJobs } : {}) };
  ctx.config.aiBudget = { dailyThb: 200, monthlyThb: 1500, estimateThb: 8, usdThb: 36 };
  ctx.repo._db.jobs.clear();
  ctx.repo._db.rate.clear();
}
async function login(addr = ip()) {
  const r = await post(null, { action: "testLogin", code: CODE }, addr);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { cookie: cookieOf(r).split(";")[0], ip: addr, res: r };
}

test("ปิดอยู่ (ค่าเริ่มต้น) / รหัสสั้นเกิน / ใช้ Mock AI → ไม่มีโหมดทดสอบ", async () => {
  mode({ enabled: false });
  assert.equal((await post(null, { action: "testLogin", code: CODE })).status, 404);
  assert.equal((await call(me)).json.aiTest, null);
  mode({ code: "short" });
  assert.equal(ctx.config.aiTest.enabled, false, "รหัสต้องยาว ≥ 12 ตัว");
  mode({ provider: mockAi });
  assert.equal((await post(null, { action: "testLogin", code: CODE })).status, 404, "ห้ามใช้ Mock AI ในโหมดทดสอบ");
});

test("รหัสผิด → ปฏิเสธ · จำกัดการเดา 5 ครั้ง/IP · รหัสถูก → cookie HttpOnly + SameSite=Strict อายุสั้น · ไม่ส่งรหัสกลับ", async () => {
  mode();
  const bad = ip();
  for (let i = 0; i < 5; i++) {
    const r = await post(null, { action: "testLogin", code: "wrong-code-123456" }, bad);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "ai_test_bad_code");
  }
  assert.equal((await post(null, { action: "testLogin", code: CODE }, bad)).status, 429, "IP นี้เดาเกินแล้ว แม้รหัสถูกก็ต้องรอ");
  const { res } = await login();
  const c = cookieOf(res);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Max-Age=7200/);
  assert.ok(!res.raw.includes(CODE) && !c.includes(CODE), "ไม่มีรหัสในคำตอบหรือ cookie");
  const other = await post(null, { action: "testLogin", code: CODE }, ip());
  assert.equal(other.status, 200);
  assert.equal((await call(ai, { method: "POST", url: "/api/ai", body: { action: "testLogin", code: CODE }, origin: "https://evil.example" })).status, 403, "ต้องมาจากเว็บไซต์ของเรา");
});

test("ผู้เข้าชมทั่วไป (ไม่มีรหัส) เรียก API สร้างภาพ/อัปโหลดไม่ได้ · cookie ปลอม/หมดอายุใช้ไม่ได้", async () => {
  mode();
  assert.equal((await post(null, { action: "create", idempotencyKey: idem(), input: FORM })).status, 401);
  assert.equal((await call(upload, { method: "POST", url: "/api/upload", body: { kind: "reference", data: PNG } })).status, 401);
  const { cookie } = await login();
  const forged = cookie.replace(/\.[A-Za-z0-9_-]{32}$/, "." + "B".repeat(32));
  assert.equal((await post(forged, { action: "create", idempotencyKey: idem(), input: FORM })).status, 401);
  const [, sid] = /sv_aitest=([a-f0-9]{24})/.exec(cookie);
  assert.equal(readTestSession(ctx, { headers: { cookie } }, Date.now() + 3 * 3600e3), null, "หมดอายุหลัง 2 ชม.");
  assert.ok(sid);
  assert.equal((await call(me)).json.aiStatus, "login_required", "ผู้ไม่มีรหัสเห็นสถานะปกติ");
  assert.equal((await call(me)).json.aiTest.active, false);
});

test("เซสชันทดสอบ: อัปโหลดรูปหน้าร้าน → สร้าง Artwork + Mockup ด้วย AI จริง (ไม่ใช่ Mock) · บันทึกค่าใช้จ่าย · ดูภาพได้เฉพาะเซสชันนี้", async () => {
  const provider = fakeOpenAI({ costUsd: 0.05 });
  mode({ provider });
  const { cookie, ip: addr } = await login();
  const m = (await call(me, { cookie, ip: addr })).json;
  assert.equal(m.aiStatus, "test_ready");
  assert.equal(m.aiTest.remainingJobs, 12);
  assert.equal(m.aiTest.budgetThb, 100);
  const up = await call(upload, { method: "POST", url: "/api/upload", cookie, ip: addr, body: { kind: "storefront", data: PNG } });
  assert.equal(up.status, 201);
  const c = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM, storefront: up.json.uploadId }, addr);
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const jobId = c.json.job.jobId;
  await post(cookie, { action: "step", jobId, step: "artwork" }, addr);
  const done = await post(cookie, { action: "step", jobId, step: "mockup" }, addr);
  assert.equal(done.json.job.status, "completed");
  assert.equal(done.json.job.preview, false, "ภาพจาก AI จริง");
  assert.equal(provider.calls, 2);
  const row = ctx.repo._db.jobs.get(jobId);
  assert.equal(row.input.mode, "test");
  assert.match(row.guest_id, /^aitest-[a-f0-9]{24}$/);
  assert.ok(row.artwork_original_key && row.mockup_original_key, "ต้นฉบับเก็บแยกใน Private");
  assert.ok(Math.abs(row.cost_usd - 0.1) < 1e-9);
  assert.ok(Math.abs(done.json.test.spentThb - 3.6) < 0.01, "ใช้ไป 0.10 USD ≈ 3.6 บาท");
  assert.equal((await call(files, { url: `/api/files?job=${jobId}&kind=artwork`, cookie, ip: addr })).status, 200);
  const other = await login();
  assert.equal((await call(files, { url: `/api/files?job=${jobId}&kind=artwork`, cookie: other.cookie, ip: other.ip })).status, 404, "เซสชันอื่นดูไม่ได้");
  assert.equal((await call(files, { url: `/api/files?job=${jobId}&kind=artwork` })).status, 401);
});

test("งบทดลองแยก + จำกัดจำนวนงาน: ตรวจก่อนเรียก AI · ถึงงบ/ครบจำนวน → หยุด · ไม่รวมกับงบใช้งานจริง", async () => {
  const provider = fakeOpenAI({ costUsd: 0.5 });                     // งานละ 1 USD ≈ 36 บาท
  mode({ provider, budgetThb: 60, maxJobs: 5 });
  const { cookie, ip: addr } = await login();
  const c1 = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM }, addr);
  await post(cookie, { action: "step", jobId: c1.json.job.jobId, step: "artwork" }, addr);
  await post(cookie, { action: "step", jobId: c1.json.job.jobId, step: "mockup" }, addr);
  const c2 = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM }, addr);
  assert.equal(c2.status, 201, "36 + ประมาณ 8 ≤ 60");
  await post(cookie, { action: "step", jobId: c2.json.job.jobId, step: "artwork" }, addr);  // 36 + 18 = 54
  ctx.config.aiTest.budgetThb = 50;
  const stepBlocked = await post(cookie, { action: "step", jobId: c2.json.job.jobId, step: "mockup" }, addr);
  assert.equal(stepBlocked.status, 503, "ตรวจงบก่อนเรียก AI ทุกขั้น");
  assert.equal(stepBlocked.json.code, "ai_test_budget");
  const callsBefore = provider.calls;
  const c3 = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM }, addr);
  assert.equal(c3.status, 503);
  assert.equal(provider.calls, callsBefore, "ถูกปฏิเสธก่อนเรียก AI");
  assert.equal((await call(me, { cookie, ip: addr })).json.aiStatus, "test_limit");
  // งบใช้งานจริง (สมาชิก/Guest ในอนาคต) ไม่นับงานทดสอบ
  const o = { estimateThb: 8, usdThb: 36 };
  assert.equal(await ctx.repo.aiSpendThbSince(new Date(0), o), 0);
  assert.ok((await ctx.repo.aiSpendThbSince(new Date(0), { ...o, mode: "test" })) > 50);
  // จำนวนงานสูงสุด
  mode({ provider: fakeOpenAI({ costUsd: 0.001 }), maxJobs: 1 });
  const s2 = await login();
  const a = await post(s2.cookie, { action: "create", idempotencyKey: idem(), input: FORM }, s2.ip);
  assert.equal(a.status, 201);
  ctx.repo._db.jobs.get(a.json.job.jobId).status = "completed";
  const b = await post(s2.cookie, { action: "create", idempotencyKey: idem(), input: FORM }, s2.ip);
  assert.equal(b.json.code, "ai_test_limit");
});

test("กดซ้ำ/คำขอพร้อมกัน: key เดิมได้งานเดิม · ระหว่างมีงานค้างสร้างงานใหม่ไม่ได้", async () => {
  mode();
  const { cookie, ip: addr } = await login();
  const key = idem();
  const [r1, r2] = await Promise.all([
    post(cookie, { action: "create", idempotencyKey: key, input: FORM }, addr),
    post(cookie, { action: "create", idempotencyKey: key, input: FORM }, addr),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 201]);
  assert.equal(r1.json.job.jobId, r2.json.job.jobId);
  const busy = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM }, addr);
  assert.equal(busy.status, 409);
});

test("ข้อผิดพลาดจริงจาก OpenAI แสดงเป็นรหัส (ไม่มีข้อมูลลับ) · ล้มเหลวก่อนได้ภาพ = ไม่เสียงาน", async () => {
  const err = Object.assign(new Error("openai_403"), { status: 403, code: "organization_verification_required", unknown: false });
  mode({ provider: fakeOpenAI({ fail: err }) });
  const { cookie, ip: addr } = await login();
  const c = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM }, addr);
  const r = await post(cookie, { action: "step", jobId: c.json.job.jobId, step: "artwork" }, addr);
  assert.equal(r.json.job.artwork.status, "failed");
  assert.equal(r.json.job.errorCode, "ai_failed:openai_403:organization_verification_required");
  assert.ok(!JSON.stringify(r.json).includes(SECRET));
});

test("ออกจากโหมด / เปลี่ยนรหัส / ปิด flag → เซสชันเดิมใช้ไม่ได้ทันที", async () => {
  mode();
  const { cookie, ip: addr } = await login();
  const out = await post(cookie, { action: "testLogout" }, addr);
  assert.match(cookieOf(out), /Max-Age=0/);
  const s = await login();
  mode({ code: "a-brand-new-code-9876" });
  assert.equal((await post(s.cookie, { action: "create", idempotencyKey: idem(), input: FORM }, s.ip)).status, 401, "เปลี่ยนรหัสแล้วเซสชันเดิมหมดสิทธิ์");
  mode({ enabled: false });
  assert.equal((await post(s.cookie, { action: "create", idempotencyKey: idem(), input: FORM }, s.ip)).status, 401);
});

test("ยังไม่ได้รัน SQL migration: แจ้งข้อความที่เข้าใจง่าย (503) · /api/me ยังทำงาน · ไม่เรียก AI", async () => {
  const provider = fakeOpenAI();
  mode({ provider });
  const { cookie, ip: addr } = await login();
  const missing = () => Object.assign(new Error('column "cost_usd" does not exist'), { code: "42703" });
  const saved = { spend: ctx.repo.aiSpendThbSince, count: ctx.repo.countTestJobs, tx: ctx.repo.tx };
  const logs = []; const origErr = console.error; console.error = (...a) => logs.push(a.join(" "));
  try {
    ctx.repo.aiSpendThbSince = async () => { throw missing(); };
    ctx.repo.countTestJobs = async () => { throw missing(); };
    ctx.repo.tx = async () => { throw missing(); };
    const m = await call(me, { cookie, ip: addr });
    assert.equal(m.status, 200, "หน้าเว็บยังอ่านสถานะได้");
    assert.equal(m.json.aiTest.error, "db_migration_required");
    assert.equal(m.json.aiStatus, "test_limit", "ปุ่มสร้างภาพถูกปิด");
    const c = await post(cookie, { action: "create", idempotencyKey: idem(), input: FORM }, addr);
    assert.equal(c.status, 503);
    assert.equal(c.json.code, "db_migration_required");
    assert.match(c.json.error, /db\/schema\.sql/);
    assert.equal(provider.calls, 0, "ไม่เรียก AI เมื่อฐานข้อมูลยังไม่พร้อม");
    assert.ok(logs.some((l) => l.includes("run db/schema.sql")) && !logs.some((l) => l.includes("cost_usd")), "log ไม่มีรายละเอียด SQL");
  } finally {
    Object.assign(ctx.repo, { aiSpendThbSince: saved.spend, countTestJobs: saved.count, tx: saved.tx });
    console.error = origErr;
  }
});
