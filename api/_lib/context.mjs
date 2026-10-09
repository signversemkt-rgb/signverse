// ประกอบบริการตาม Environment Variables
//   MOCK_SERVICES=1 → ฐานข้อมูล/ไฟล์/AI/ล็อกอินแบบจำลองในหน่วยความจำ (ห้ามใช้บน Production — ระบบปฏิเสธเอง)
//   ไม่ใช่ mock    → Neon + Vercel Blob + Better Auth (ต้องตั้งค่าครบ ไม่งั้นตอบ not_configured)
import { HttpError, allowedOrigins } from "./http.mjs";
import { createMemoryRepo } from "./repo-memory.mjs";
import { createMemoryStorage, createVercelStorage, resolveBlobConfig } from "./storage.mjs";
import { createMockProvider } from "./ai-mock.mjs";
import { enabledLoginMethods, phoneLoginStatus, getAuth, sessionFromRequest, authConfigured } from "./auth.mjs";
import { phoneLoginConfig, createOtpService } from "./phone.mjs";
import { createLineClient } from "./line.mjs";

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};

let cached = null;

export function newId() {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

export async function getContext(env = process.env) {
  if (cached && cached.env === env) return cached;
  const mock = env.MOCK_SERVICES === "1";
  if (mock && env.VERCEL_ENV === "production") throw new HttpError(503, "not_configured");

  const ctx = {
    env,
    mock,
    uuid: newId,
    config: {
      defaultCredits: int(env.AI_FREE_CREDITS, 1),
      dailyLimit: int(env.AI_DAILY_JOB_LIMIT, 20),
      retentionDays: int(env.CUSTOMER_FILE_RETENTION_DAYS, 90),
      tempUploadHours: int(env.TEMP_UPLOAD_HOURS, 24),
      trashDays: int(env.GALLERY_TRASH_DAYS, 30),
      origins: allowedOrigins(env),
      turnstileSecret: env.TURNSTILE_SECRET_KEY || "",
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
      baseUrl: (env.BETTER_AUTH_URL || env.APP_ORIGIN || "").replace(/\/$/, ""),
      lineChannelSecret: env.LINE_CHANNEL_SECRET || (mock ? "mock-line-channel-secret" : ""),
      // ลายเซ็นลิงก์รูปให้ LINE ดึง — ต้องเป็นค่าเฉพาะ (≥32 ตัว) ไม่ยืม secret อื่น · ไม่มี = ไม่ส่งรูป (ส่งข้อความอย่างเดียว)
      fileSigningSecret: env.FILE_SIGNING_SECRET || (mock ? "mock-file-signing-secret-0123456789abcdef" : ""),
      fileUrlTtlSec: Math.min(60, Math.max(1, int(env.FILE_URL_TTL_DAYS, 30))) * 86400,
      lineStaffGroupEnv: env.LINE_STAFF_GROUP_ID || "",
      lineOaId: env.LINE_OA_ID || "@signverse",          // LINE OA ที่พนักงานตอบแชตลูกค้า
      // ระบบสั่งผลิตผ่าน LINE OA: off (ค่าเริ่มต้น) | staff (เฉพาะบัญชีพนักงานทดสอบ) | on (ลูกค้าทุกคน)
      lineOrdersMode: ["staff", "on"].includes(env.LINE_ORDERS_ENABLED) ? env.LINE_ORDERS_ENABLED : (mock && env.LINE_ORDERS_ENABLED !== "off" ? "on" : "off"),
      // ระบบส่งเข้ากลุ่ม LINE พนักงาน: ปิดเป็นค่าเริ่มต้น (ต้องตั้ง "true" ตรง ๆ เท่านั้นถึงจะเปิด)
      lineGroupOrdersEnabled: env.LINE_GROUP_ORDERS_ENABLED === "true",
      liffId: env.LIFF_ID || "",                          // เปิดเผยได้ (ใช้ฝั่งหน้า LIFF)
      liffChannelId: env.LINE_LOGIN_CHANNEL_ID || "",     // ใช้ตรวจ LIFF ID token ฝั่ง Server
    },
    // ปุ่มเข้าสู่ระบบบนหน้าเว็บ: social = ["facebook"] (LINE/Google ปิด — เปิดได้ด้วย AUTH_PROVIDERS) + สถานะเบอร์โทร
    providers: enabledLoginMethods(env, { mock }),
    phoneLogin: phoneLoginStatus(env, { mock }),
    repo: null,
    storage: null,
    ai: null,
  };

  if (mock) {
    ctx.repo = createMemoryRepo({ uuid: newId });
    ctx.storage = createMemoryStorage({ uuid: newId });
    ctx.ai = createMockProvider({ format: env.MOCK_AI_FORMAT === "svg" ? "svg" : "png" });
    ctx.aiMockStaffOnly = env.MOCK_AI_STAFF_ONLY === "1";   // จำลองเว็บจริงที่ตั้ง AI_PROVIDER=mock (ทดสอบในเครื่อง)
    // เบอร์โทร + OTP แบบจำลอง (SMS ไม่ถูกส่งจริง) — ระบบจริงทำงานผ่าน Better Auth phoneNumber plugin ใน auth.mjs
    const phoneCfg = phoneLoginConfig(env, { mock: true });
    if (phoneCfg.ready) {
      ctx.sms = phoneCfg.sms;
      ctx.phone = createOtpService({ repo: ctx.repo, sms: phoneCfg.sms, secret: phoneCfg.secret, uuid: newId, limits: phoneCfg.limits });
    }
    ctx.getSession = async (req) => {
      const m = /(?:^|;\s*)sv_mock_user=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || "");
      return m ? ctx.repo.getUser(m[1]) : null;
    };
  } else {
    if (env.DATABASE_URL) {
      const [{ Pool }, { createPgRepo }] = await Promise.all([import("@neondatabase/serverless"), import("./repo-pg.mjs")]);
      ctx.repo = createPgRepo({ Pool, connectionString: env.DATABASE_URL, uuid: newId });
    }
    // Blob: token แยกของแต่ละ store หรือ Store ID + OIDC (ดู storage.mjs) — ตั้งไม่ครบ/ชี้ store เดียวกัน = ปิดระบบไฟล์
    const blobConfig = resolveBlobConfig(env);
    if (blobConfig?.error) console.error(`[storage] disabled: ${blobConfig.error}`);   // ไม่ log ค่าตัวแปร
    else if (blobConfig) {
      const blob = await import("@vercel/blob");
      ctx.storage = createVercelStorage({ blob, config: blobConfig });
    }
    // AI จริงยังไม่เปิด: ต้องมีระบบลายน้ำฝั่ง Server ก่อน (รออนุมัติแพ็กเกจประมวลผลภาพ)
    // AI_PROVIDER=mock ใช้ทดสอบบน Preview ได้โดยไม่มีค่าใช้จ่าย
    ctx.ai = env.AI_PROVIDER === "mock" ? createMockProvider({ format: env.MOCK_AI_FORMAT === "svg" ? "svg" : "png" }) : null;
    // Mock AI บนเว็บจริงใช้ทดสอบเท่านั้น → เฉพาะบัญชี staff/admin (ตรวจที่ Server)
    ctx.aiMockStaffOnly = env.AI_PROVIDER === "mock";
    ctx.getSession = async (req) => {
      const auth = await getAuth(env);
      return auth ? sessionFromRequest(auth, req) : null;
    };
  }
  // LINE Messaging API: mock เมื่อ MOCK_SERVICES=1 หรือ LINE_MOCK=1 (ไม่เรียก LINE จริง)
  ctx.line = createLineClient({ accessToken: env.LINE_CHANNEL_ACCESS_TOKEN, mock: mock || env.LINE_MOCK === "1" });
  // ชั้นป้องกันที่ 2: push ใช้ได้เฉพาะระบบกลุ่ม (ปิดอยู่) → ปิดที่ระดับ client ด้วย กันโค้ดส่วนอื่นเรียกโดยไม่ตั้งใจ
  if (ctx.line && !ctx.config.lineGroupOrdersEnabled) {
    ctx.line.push = async () => { throw new HttpError(403, "feature_disabled"); };
  }
  ctx.authReady = mock || authConfigured(env);
  cached = ctx;
  return ctx;
}

export function need(ctx, ...parts) {
  for (const p of parts) if (!ctx[p]) throw new HttpError(503, "not_configured");
}

export async function requireUser(ctx, req) {
  const user = await ctx.getSession(req);
  if (!user) throw new HttpError(401, "unauthenticated");
  if (user.accountStatus === "suspended") throw new HttpError(403, "suspended");
  return user;
}

export async function requireStaff(ctx, req) {
  const user = await requireUser(ctx, req);
  if (user.role !== "staff" && user.role !== "admin") throw new HttpError(403, "forbidden");
  return user;
}

export async function requireAdmin(ctx, req) {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw new HttpError(403, "forbidden");
  return user;
}

export async function rateLimit(ctx, key, limit, windowSec) {
  if (!ctx.repo) return;
  if (!(await ctx.repo.hitRateLimit(key, limit, windowSec))) throw new HttpError(429, "rate_limited");
}

// Cloudflare Turnstile (เปิดเมื่อมี TURNSTILE_SECRET_KEY เท่านั้น)
export async function verifyTurnstile(ctx, token, ip) {
  if (!ctx.config.turnstileSecret) return;
  if (!token) throw new HttpError(400, "bot_check_failed");
  const body = new URLSearchParams({ secret: ctx.config.turnstileSecret, response: String(token), remoteip: ip });
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await r.json().catch(() => ({}));
  if (!data.success) throw new HttpError(400, "bot_check_failed");
}

// กลุ่มพนักงานที่ผูกแล้ว (ผูกผ่านรหัสจากหลังบ้าน) — ค่าใน env ใช้เป็นค่าสำรอง
export async function staffGroup(ctx) {
  const fromDb = ctx.repo ? await ctx.repo.getSetting("line_staff_group_id") : null;
  if (fromDb) return { groupId: fromDb, source: "db" };
  if (ctx.config.lineStaffGroupEnv) return { groupId: ctx.config.lineStaffGroupEnv, source: "env" };
  return null;
}

export function maskId(id) {
  return id ? `${String(id).slice(0, 5)}…${String(id).slice(-4)}` : null;
}

// ผู้ใช้คนนี้ใช้ระบบสั่งผลิตผ่าน LINE ได้หรือไม่ (ตามช่วงทดลองใช้)
export function canUseLineOrders(ctx, user) {
  if (ctx.config.lineOrdersMode === "on") return Boolean(user);
  if (ctx.config.lineOrdersMode === "staff") return Boolean(user && (user.role === "staff" || user.role === "admin"));
  return false;
}

const isStaffUser = (user) => Boolean(user && (user.role === "staff" || user.role === "admin"));

// ผู้ใช้คนนี้สร้างภาพ AI ได้หรือไม่ (Mock AI บนเว็บจริง = เฉพาะพนักงาน)
export function canUseAi(ctx, user) {
  if (!ctx.ai || !ctx.repo || !ctx.storage) return false;
  if (ctx.aiMockStaffOnly) return isStaffUser(user);
  return true;
}

// สถานะส่วน "สร้างภาพป้ายด้วย AI" สำหรับหน้าเว็บ (หน้าเว็บแสดงส่วนนี้เสมอ แต่ปุ่มทำงานตามสถานะนี้)
//   ready          → AI จริงพร้อม และผู้ใช้นี้สร้างได้ (โควตายังตรวจที่ createJob)
//   mock_test      → ใช้ Mock AI ได้ (พนักงาน / dev ในเครื่อง) — ผลเป็นภาพตัวอย่าง ไม่ใช่ AI จริง
//   login_required → ยังไม่ล็อกอิน (กดปุ่มแล้วเปิดหน้าต่างเข้าสู่ระบบ)
//   coming_soon    → ล็อกอินแล้ว แต่ระบบยังไม่เปิดให้ผู้ใช้นี้ (ไม่อัปโหลดรูป ไม่สร้างภาพ ไม่ใช้สิทธิ์)
// aiReady = เปิดให้ลูกค้าทั่วไปใช้ AI จริงแล้วหรือยัง (ไม่ขึ้นกับผู้ใช้)
export function aiReadyForCustomers(ctx) {
  return Boolean(ctx.ai && ctx.repo && ctx.storage && ctx.ai.name !== "mock" && !ctx.aiMockStaffOnly);
}
export function aiStatus(ctx, user) {
  if (!user) return "login_required";
  if (!canUseAi(ctx, user)) return "coming_soon";
  return ctx.ai.name === "mock" ? "mock_test" : "ready";
}

// งานทดสอบของพนักงานด้วย Mock AI ไม่ใช้เครดิตของใคร
export function isCreditExempt(ctx, user) {
  return Boolean(ctx.ai && ctx.ai.name === "mock" && isStaffUser(user));
}
