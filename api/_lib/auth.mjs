// Better Auth — เข้าสู่ระบบด้วย LINE (LINE Login) และเบอร์โทรศัพท์ + OTP · Session ในฐานข้อมูล Neon
// - วิธีที่เปิดใช้กำหนดด้วย AUTH_PROVIDERS (ค่าเริ่มต้น "line,phone") และต้องตั้งค่าครบจึงจะแสดง
// - Google / Facebook ยังรองรับในโค้ด แต่ปิดไว้ (ไม่อยู่ในค่าเริ่มต้น) — บัญชีเดิมในฐานข้อมูลไม่ถูกลบ
// - LINE Login ใช้ Channel ของ LINE Login (LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET)
//   ห้ามใช้ LINE_CHANNEL_SECRET ของ Messaging API (ใช้ตรวจลายเซ็น Webhook ของ OA)
// Secret ทั้งหมดอยู่ฝั่ง Server เท่านั้น
import { createHash } from "node:crypto";
import { phoneLoginConfig, createOtpService, isThaiMobileE164, maskPhone, phoneTempEmail } from "./phone.mjs";
import { HttpError, errorBody } from "./http.mjs";

const SOCIAL = {
  line: (env) => [env.LINE_LOGIN_CHANNEL_ID || env.LINE_CLIENT_ID, env.LINE_LOGIN_CHANNEL_SECRET || env.LINE_CLIENT_SECRET],
  google: (env) => [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
  facebook: (env) => [env.FACEBOOK_CLIENT_ID, env.FACEBOOK_CLIENT_SECRET],
};
export const DEFAULT_AUTH_PROVIDERS = "line,phone";

// LINE: ระบุสมาชิกด้วย LINE User ID (profile.sub → account.accountId) เท่านั้น
// - ไม่ใช้อีเมลจริงจาก LINE: กันชนกับบัญชีเดิมที่ใช้อีเมลเดียวกัน (เช่น บัญชี Google เดิม) ซึ่งจะทำให้ล็อกอินไม่ได้
//   และไม่ต้องขอสิทธิ์อีเมลจาก LINE · อีเมลแทนโดเมน .invalid ส่งอีเมลจริงไม่ได้ และไม่มี LINE User ID อยู่ในอีเมล
// - emailVerified = false → ไม่ถูกรวมกับบัญชีอื่นโดยอัตโนมัติ
export function lineProfileToUser(profile) {
  return {
    email: `l${createHash("sha256").update(`sv-line:${profile.sub}`).digest("hex").slice(0, 24)}@line.signverse.invalid`,
    name: String(profile.name || "").trim().slice(0, 80) || "สมาชิก LINE",
    emailVerified: false,
  };
}

export function allowedAuthMethods(env) {
  return String(env.AUTH_PROVIDERS || DEFAULT_AUTH_PROVIDERS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Social provider ที่อนุญาตและตั้ง Client ID + Secret ครบ
export function enabledProviders(env) {
  const allowed = allowedAuthMethods(env);
  return Object.keys(SOCIAL).filter((p) => allowed.includes(p) && SOCIAL[p](env).every(Boolean));
}

// ค่าที่ส่งให้ Better Auth (socialProviders) — Secret อยู่ฝั่ง Server เท่านั้น
export function socialProviderConfig(env) {
  const out = {};
  for (const p of enabledProviders(env)) {
    const [clientId, clientSecret] = SOCIAL[p](env);
    out[p] = { clientId, clientSecret };
  }
  if (out.line) out.line.mapProfileToUser = lineProfileToUser;
  return out;
}

// วิธีเข้าสู่ระบบที่แสดงบนหน้าเว็บ (เรียงตามที่ต้องการแสดง)
export function enabledLoginMethods(env, { mock = false } = {}) {
  const allowed = allowedAuthMethods(env);
  const social = mock ? ["line", "google", "facebook"].filter((p) => allowed.includes(p)) : enabledProviders(env);
  const phone = allowed.includes("phone") && phoneLoginConfig(env, { mock }).ready ? ["phone"] : [];
  return [...social.filter((p) => p === "line"), ...phone, ...social.filter((p) => p !== "line")];
}

export function authConfigured(env) {
  return Boolean(env.DATABASE_URL && env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL);
}

let authPromise = null;

export function getAuth(env) {
  if (!authConfigured(env)) return null;
  if (!authPromise) authPromise = buildAuth(env);
  return authPromise;
}

async function buildAuth(env) {
  const [{ betterAuth }, { Pool }] = await Promise.all([import("better-auth"), import("@neondatabase/serverless")]);
  const socialProviders = socialProviderConfig(env);
  const defaultCredits = Number.parseInt(env.AI_FREE_CREDITS || "1", 10);
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const plugins = [];
  if (allowedAuthMethods(env).includes("phone")) {
    const phone = await buildPhonePlugin(env, Pool);
    if (phone) plugins.push(phone);
  }

  return betterAuth({
    database: pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.BETTER_AUTH_URL],
    socialProviders,
    emailAndPassword: { enabled: false },          // ไม่เก็บรหัสผ่านเอง
    user: {
      additionalFields: {
        // input:false → ผู้ใช้ตั้งค่าเองผ่าน API ไม่ได้ (กันการส่ง role=admin จาก Browser)
        role: { type: "string", required: false, defaultValue: "customer", input: false },
        accountStatus: { type: "string", required: false, defaultValue: "active", input: false },
      },
    },
    account: {
      // ไม่รวมบัญชีอัตโนมัติจากอีเมลที่ตรงกัน (LINE / เบอร์โทร / บัญชีเดิม) — การผูกบัญชีต้องล็อกอินอยู่และยืนยันตัวตนเอง
      accountLinking: { enabled: true, trustedProviders: [], disableImplicitLinking: true },
    },
    plugins,
    // ไม่มีรหัสผ่าน → ปิดเส้นทางที่เกี่ยวกับรหัสผ่านของ phoneNumber plugin
    disabledPaths: ["/phone-number/sign-in", "/phone-number/request-password-reset", "/phone-number/reset-password"],
    session: {
      expiresIn: 60 * 60 * 24 * 14,                // 14 วัน
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: {
      useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    databaseHooks: {
      // ไม่เก็บ Access/Refresh/ID Token ของ Social Provider (ใช้แค่ยืนยันตัวตนตอนล็อกอิน)
      account: {
        create: { before: async (account) => ({ data: { ...account, accessToken: null, refreshToken: null, idToken: null } }) },
        update: { before: async (account) => ({ data: { ...account, accessToken: null, refreshToken: null, idToken: null } }) },
      },
      user: {
        create: {
          // สมาชิกใหม่ได้สิทธิ์ทดลองตามค่าที่ตั้ง (ค่าเริ่มต้น 1 ชุด)
          after: async (user) => {
            await pool.query(`INSERT INTO ai_quota (user_id, free_credits_total) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [user.id, defaultCredits]);
          },
        },
      },
    },
  });
}

// ---------- เบอร์โทร + OTP (Better Auth phoneNumber plugin + ตัวตรวจรหัสของเรา) ----------
// plugin ดูแลการสร้างบัญชี / session / cookie ส่วน OTP ใช้ phone.mjs: เก็บแบบ hash, จำกัดการส่ง, ใช้ได้ครั้งเดียว
// (plugin บันทึกรหัสแบบไม่ hash ลงตาราง verification ก่อนเรียก sendOTP → เราลบแถวนั้นทันที และใช้ verifyOTP ของเราแทน)
const STATUS = { 400: "BAD_REQUEST", 403: "FORBIDDEN", 429: "TOO_MANY_REQUESTS", 502: "BAD_GATEWAY", 503: "SERVICE_UNAVAILABLE" };

async function verifyTurnstileToken(secret, token, ip) {
  if (!secret) return;
  if (!token) throw new HttpError(400, "bot_check_failed");
  const body = new URLSearchParams({ secret, response: String(token), remoteip: ip });
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await r.json().catch(() => ({}));
  if (!data.success) throw new HttpError(400, "bot_check_failed");
}

const headerOf = (ctx, name) => (ctx?.headers?.get?.(name) ?? ctx?.request?.headers?.get?.(name) ?? "") || "";
export const clientIp = (ctx) => String(headerOf(ctx, "x-forwarded-for")).split(",")[0].trim() || "unknown";

async function buildPhonePlugin(env, Pool) {
  const cfg = phoneLoginConfig(env, { mock: false });
  if (!cfg.ready) return null;
  const [{ phoneNumber }, { APIError }, { createPgRepo }] = await Promise.all([
    import("better-auth/plugins"), import("better-auth/api"), import("./repo-pg.mjs"),
  ]);
  const repo = createPgRepo({ Pool, connectionString: env.DATABASE_URL, uuid: () => globalThis.crypto.randomUUID().replace(/-/g, "") });
  const otp = createOtpService({ repo, sms: cfg.sms, secret: cfg.secret, uuid: () => globalThis.crypto.randomUUID().replace(/-/g, ""), limits: cfg.limits });
  const toApiError = (err) => {
    if (err instanceof HttpError) return new APIError(STATUS[err.status] || "BAD_REQUEST", { ...errorBody(err.code), message: errorBody(err.code).error });
    console.error("[phone-auth] unexpected:", err && err.name);
    return new APIError("INTERNAL_SERVER_ERROR", { message: errorBody("server_error").error, code: "server_error" });
  };
  return phoneNumber({
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 5,
    phoneNumberValidator: (p) => isThaiMobileE164(p),          // หน้าเว็บแปลงเป็น +66… ก่อนส่ง
    async sendOTP({ phoneNumber: phone }, ctx) {
      try {
        await ctx.context.internalAdapter.deleteVerificationByIdentifier(phone);   // ไม่เก็บรหัสแบบไม่ hash
        await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY, headerOf(ctx, "x-turnstile-token"), clientIp(ctx));
        await otp.send({ phone, ip: clientIp(ctx) });
      } catch (err) { throw toApiError(err); }
    },
    async verifyOTP({ phoneNumber: phone, code }) {
      try { return await otp.verify({ phone, code }); } catch (err) { throw toApiError(err); }
    },
    // สมาชิกใหม่: สร้างบัญชีอัตโนมัติ (ไม่มีรหัสผ่าน) ชื่อเป็นเบอร์แบบปิดบัง · เครดิตฟรีมาจาก hook user.create (ครั้งเดียวต่อบัญชี)
    signUpOnVerification: { getTempEmail: phoneTempEmail, getTempName: maskPhone },
  });
}

// อ่าน session จาก cookie ของ request (ตรวจฝั่ง Server)
export async function sessionFromRequest(auth, req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, String(v));
  }
  const s = await auth.api.getSession({ headers });
  if (!s || !s.user) return null;
  const u = s.user;
  return { id: u.id, name: u.name || "", email: u.email || "", image: u.image || null, role: u.role || "customer", accountStatus: u.accountStatus || "active" };
}
