// Better Auth — Social Login (Google / LINE / Facebook) + Session ในฐานข้อมูล Neon
// เปิดเฉพาะ provider ที่ตั้ง Client ID + Secret ครบใน Environment Variables
// Secret ทั้งหมดอยู่ฝั่ง Server เท่านั้น

const PROVIDERS = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  line: ["LINE_CLIENT_ID", "LINE_CLIENT_SECRET"],
  facebook: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
};

export function enabledProviders(env) {
  return Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].every((k) => env[k]));
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
  const socialProviders = {};
  for (const p of enabledProviders(env)) {
    const [idKey, secretKey] = PROVIDERS[p];
    socialProviders[p] = { clientId: env[idKey], clientSecret: env[secretKey] };
  }
  const defaultCredits = Number.parseInt(env.AI_FREE_CREDITS || "1", 10);
  const pool = new Pool({ connectionString: env.DATABASE_URL });

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
      // เชื่อมหลาย provider ได้ แต่ไม่ถือว่าอีเมลเหมือนกัน = คนเดียวกัน เว้นแต่ provider ยืนยันอีเมลแล้ว
      accountLinking: { enabled: true, trustedProviders: [] },
    },
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
