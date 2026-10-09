// โหมดทดสอบ AI จริงสำหรับเจ้าของเว็บไซต์ (ไม่ต้องสมัครสมาชิก) — เปิดด้วย AI_TEST_MODE=true
// - ต้องยืนยันด้วยรหัสทดสอบ (AI_TEST_CODE เก็บใน Vercel เท่านั้น) ตรวจฝั่ง Server แบบ timing-safe
// - สำเร็จ = ออก cookie เซสชันทดสอบ HttpOnly · SameSite=Strict · อายุสั้น (ค่าเริ่มต้น 2 ชม.) · ลงลายเซ็น HMAC
//   (กุญแจผูกกับรหัสทดสอบ → เปลี่ยนรหัส = เซสชันเดิมใช้ไม่ได้ทันที)
// - กรอกรหัสผิด: จำกัดต่อ IP และทั้งระบบ · ไม่มีการส่งรหัส/secret ไปที่ Browser
// - ใช้ได้เฉพาะ AI จริง (ห้าม Mock) · งบแยกเฉพาะโหมดทดสอบ (AI_TEST_BUDGET_THB) ไม่รวมกับงบใช้งานจริง
// - ปิดทันที: ลบ AI_TEST_MODE หรือเปลี่ยน AI_TEST_CODE แล้ว Redeploy
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.mjs";

export const AITEST_COOKIE = "sv_aitest";
export const MIN_TEST_CODE_LENGTH = 12;

// ค่าจาก Vercel อาจมีช่องว่าง/ขึ้นบรรทัดใหม่ติดมาตอนวาง หรือพิมพ์ใหญ่ — อ่านแบบทนทาน
export const envFlag = (v) => String(v ?? "").trim().toLowerCase();
export const envText = (v) => String(v ?? "").trim();

// กุญแจลงลายเซ็นเซสชัน: GUEST_SIGNING_SECRET ถ้ายาวพอ ไม่งั้นใช้ BETTER_AUTH_SECRET (ค่าสั้นไม่ทับค่าที่ใช้ได้)
function signingBase(env) {
  const g = envText(env.GUEST_SIGNING_SECRET);
  return g.length >= 32 ? g : envText(env.BETTER_AUTH_SECRET);
}

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const AITEST_DEFAULTS = {
  budgetThb: 100,        // AI_TEST_BUDGET_THB — งบทดลองรวมทั้งหมดของโหมดทดสอบ
  maxJobs: 12,           // AI_TEST_MAX_JOBS   — จำนวนงานทดสอบสูงสุด (Artwork + Mockup = 1 งาน)
  sessionMinutes: 120,   // AI_TEST_SESSION_MINUTES
};

export function aiTestConfig(env) {
  const code = envText(env.AI_TEST_CODE);
  const base = signingBase(env);
  const usable = envFlag(env.AI_TEST_MODE) === "true" && code.length >= MIN_TEST_CODE_LENGTH && base.length >= 32;
  return {
    enabled: usable,
    // ใช้ตรวจรหัสเพื่อแสดงผลวินิจฉัยให้เจ้าของ (แม้โหมดยังเปิดไม่ได้) — ไม่ใช้ออกเซสชัน
    probeHash: code ? createHash("sha256").update(code).digest() : null,
    codeHash: usable ? createHash("sha256").update(code).digest() : null,
    key: usable ? createHmac("sha256", base).update(`sv-aitest-v1:${createHash("sha256").update(code).digest("hex")}`).digest() : null,
    budgetThb: int(env.AI_TEST_BUDGET_THB, AITEST_DEFAULTS.budgetThb),
    maxJobs: int(env.AI_TEST_MAX_JOBS, AITEST_DEFAULTS.maxJobs),
    sessionMinutes: Math.min(720, Math.max(5, int(env.AI_TEST_SESSION_MINUTES, AITEST_DEFAULTS.sessionMinutes))),
  };
}

// วินิจฉัย: ชื่อเงื่อนไขที่ยังไม่ครบ (ไม่มีค่า/ความยาว/ส่วนของค่าใด ๆ) — ใช้ใน log ของ Server และแสดงให้ผู้ที่รู้รหัสทดสอบเท่านั้น
export function aiTestDiagnostics(ctx, env) {
  const out = [];
  const provider = envFlag(env.AI_PROVIDER);
  if (!provider) out.push("missing_AI_PROVIDER");
  else if (provider !== "openai") out.push("invalid_AI_PROVIDER");
  if (!envText(env.OPENAI_API_KEY)) out.push("missing_OPENAI_API_KEY");
  if (!envFlag(env.AI_TEST_MODE)) out.push("missing_AI_TEST_MODE");
  else if (envFlag(env.AI_TEST_MODE) !== "true") out.push("invalid_AI_TEST_MODE");
  const code = envText(env.AI_TEST_CODE);
  if (!code) out.push("missing_AI_TEST_CODE");
  else if (code.length < MIN_TEST_CODE_LENGTH) out.push("invalid_AI_TEST_CODE");
  const base = signingBase(env);
  if (!base) out.push("missing_BETTER_AUTH_SECRET");
  else if (base.length < 32) out.push("invalid_BETTER_AUTH_SECRET");
  if (envText(env.GUEST_SIGNING_SECRET) && envText(env.GUEST_SIGNING_SECRET).length < 32) out.push("invalid_GUEST_SIGNING_SECRET");
  if (!ctx.repo) out.push("missing_DATABASE");
  if (!ctx.storage) out.push("missing_BLOB_STORAGE");
  if (ctx.ai && ctx.ai.name === "mock") out.push("invalid_AI_PROVIDER_mock");
  return out;
}

// โหมดทดสอบพร้อมใช้หรือไม่ (ต้องมี AI จริง ไม่ใช่ Mock + ฐานข้อมูล + ไฟล์)
export function aiTestReady(ctx) {
  const t = ctx.config.aiTest;
  return Boolean(t && t.enabled && ctx.ai && ctx.ai.name !== "mock" && ctx.repo && ctx.storage);
}

const sign = (key, payload) => createHmac("sha256", key).update(`aitest:${payload}`).digest("base64url").slice(0, 32);

// อ่านเซสชันทดสอบจาก cookie → { sid } หรือ null (หมดอายุ / ลายเซ็นไม่ถูก / โหมดปิด)
export function readTestSession(ctx, req, now = Date.now()) {
  if (!aiTestReady(ctx)) return null;
  const m = new RegExp(`(?:^|;\\s*)${AITEST_COOKIE}=([a-f0-9]{24})\\.(\\d{10})\\.([A-Za-z0-9_-]{32})`).exec(req.headers.cookie || "");
  if (!m) return null;
  const [, sid, exp, sig] = m;
  if (Number(exp) * 1000 < now) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(ctx.config.aiTest.key, `${sid}.${exp}`));
  return a.length === b.length && timingSafeEqual(a, b) ? { sid, exp: Number(exp) } : null;
}

const cookieAttrs = (ctx) => `Path=/; HttpOnly; SameSite=Strict${ctx.config.baseUrl.startsWith("https://") ? "; Secure" : ""}`;

// ยืนยันรหัสทดสอบ → ออกเซสชันใหม่ (ไม่ส่งรหัสหรือข้อมูลลับใด ๆ กลับไป)
export async function testLogin(ctx, req, res, code, ip, now = Date.now()) {
  const t = ctx.config.aiTest;
  // ยังเปิดไม่ได้: ตอบ 404 เหมือนไม่มีโหมดนี้ — ยกเว้นผู้ที่กรอกรหัสตรงกับ AI_TEST_CODE จะได้ "ชื่อ" เงื่อนไขที่ยังไม่ครบ
  if (!aiTestReady(ctx)) {
    if (!t || !t.probeHash || !ctx.repo) throw new HttpError(404, "not_found");
    if (!(await ctx.repo.hitRateLimit(`aitest-login:ip:${ip}`, 5, 900))) throw new HttpError(429, "rate_limited");
    const probe = createHash("sha256").update(envText(code)).digest();
    if (!timingSafeEqual(probe, t.probeHash)) throw new HttpError(404, "not_found");
    throw Object.assign(new HttpError(503, "ai_test_not_ready"), { details: aiTestDiagnostics(ctx, ctx.env) });
  }
  // จำกัดการเดารหัส: ต่อ IP 5 ครั้ง / 15 นาที และทั้งระบบ 30 ครั้ง / ชั่วโมง
  if (!(await ctx.repo.hitRateLimit(`aitest-login:ip:${ip}`, 5, 900))) throw new HttpError(429, "rate_limited");
  if (!(await ctx.repo.hitRateLimit("aitest-login:all", 30, 3600))) throw new HttpError(429, "rate_limited");
  const given = createHash("sha256").update(envText(code)).digest();
  if (!timingSafeEqual(given, ctx.config.aiTest.codeHash)) {
    await ctx.repo.audit(null, "ai_test_login_failed", null, {});
    throw new HttpError(403, "ai_test_bad_code");
  }
  const sid = randomBytes(12).toString("hex");
  const exp = Math.floor(now / 1000) + ctx.config.aiTest.sessionMinutes * 60;
  res.setHeader("Set-Cookie", `${AITEST_COOKIE}=${sid}.${exp}.${sign(ctx.config.aiTest.key, `${sid}.${exp}`)}; Max-Age=${ctx.config.aiTest.sessionMinutes * 60}; ${cookieAttrs(ctx)}`);
  await ctx.repo.audit(null, "ai_test_login", sid.slice(0, 8), {});
  return { sid, expiresAt: new Date(exp * 1000).toISOString() };
}

export function testLogout(ctx, res) {
  res.setHeader("Set-Cookie", `${AITEST_COOKIE}=; Max-Age=0; ${cookieAttrs(ctx)}`);
}

// งานของเซสชันทดสอบเก็บแบบ Guest: guest_id = "aitest-<sid>" (แยกจากสมาชิก/Guest จริง)
export const testOwnerId = (sid) => `aitest-${sid}`;

// งบทดลองที่ใช้ไปแล้ว (บาท) + จำนวนงาน — สำหรับแสดงผลบนหน้าเว็บ
export async function testUsage(ctx) {
  const t = ctx.config.aiTest;
  const b = ctx.config.aiBudget;
  const [spentThb, jobs] = await Promise.all([
    ctx.repo.aiSpendThbSince(new Date(0), { estimateThb: b.estimateThb, usdThb: b.usdThb, mode: "test" }),
    ctx.repo.countTestJobs(),
  ]);
  const remainingJobs = Math.max(0, t.maxJobs - jobs);
  const exhausted = remainingJobs <= 0 || spentThb + b.estimateThb > t.budgetThb;
  return { spentThb: Math.round(spentThb * 100) / 100, budgetThb: t.budgetThb, jobs, maxJobs: t.maxJobs, remainingJobs: exhausted ? 0 : remainingJobs, exhausted };
}
