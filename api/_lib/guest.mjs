// สร้างภาพ AI ฟรีโดยไม่ต้องสมัครสมาชิก (Guest) — เปิดชั่วคราวด้วย GUEST_AI_ENABLED=true
// - ตรวจสิทธิ์ที่ Server ทุกครั้ง (ไม่ใช่แค่ซ่อน/แสดงปุ่ม) · ปิด flag = กลับไปใช้ระบบสมาชิก + โควตาเดิมทันที
// - ตัวตน Guest = รหัสสุ่มใน cookie HttpOnly ที่ลงลายเซ็น HMAC (ปลอมไม่ได้) + ตรวจร่วมกับ IP (เก็บเป็น hash)
// - ใช้ได้เฉพาะ AI จริง — ห้ามใช้ Mock AI กับลูกค้า · ยังไม่มี AI จริง = สถานะ "กำลังเตรียมเปิดบริการ" (กดไม่ได้)
// - จำกัด: ต่อ Guest / ต่อ IP / ทั้งระบบต่อวัน
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const GUEST_COOKIE = "sv_guest";
const COOKIE_MAX_AGE = 30 * 86400;

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

// ค่าจำกัดเริ่มต้น (เสนอให้เจ้าของร้านอนุมัติ — ปรับได้ด้วย Environment Variables)
export const GUEST_DEFAULTS = {
  perGuestDay: 2,          // GUEST_AI_PER_GUEST_DAY — งานต่อ Guest (cookie) ต่อวัน
  perIpDay: 4,             // GUEST_AI_PER_IP_DAY    — งานต่อ IP ต่อวัน (กันล้าง cookie แล้วขอใหม่)
  dailyTotal: 40,          // GUEST_AI_DAILY_TOTAL   — งาน Guest ทั้งระบบต่อวัน
  retentionDays: 7,        // GUEST_FILE_RETENTION_DAYS — เก็บรูป/ภาพของ Guest กี่วัน
};

export function guestConfig(env, { mock = false } = {}) {
  // กุญแจลงลายเซ็น cookie: ใช้ค่าเฉพาะถ้ามี ไม่งั้นแตกจาก BETTER_AUTH_SECRET (คนละ label = ใช้แทนกันไม่ได้)
  const base = env.GUEST_SIGNING_SECRET || env.BETTER_AUTH_SECRET || (mock ? "mock-guest-signing-secret-0123456789abcdef" : "");
  return {
    enabled: env.GUEST_AI_ENABLED === "true",
    key: base && base.length >= 32 ? createHmac("sha256", base).update("sv-guest-cookie-v1").digest() : null,
    perGuestDay: int(env.GUEST_AI_PER_GUEST_DAY, GUEST_DEFAULTS.perGuestDay),
    perIpDay: int(env.GUEST_AI_PER_IP_DAY, GUEST_DEFAULTS.perIpDay),
    dailyTotal: int(env.GUEST_AI_DAILY_TOTAL, GUEST_DEFAULTS.dailyTotal),
    retentionDays: Math.max(1, int(env.GUEST_FILE_RETENTION_DAYS, GUEST_DEFAULTS.retentionDays)),
  };
}

// AI จริงพร้อมสำหรับ Guest หรือไม่ (ไม่รวมการตรวจงบ/จำนวน ซึ่งต้องอ่านฐานข้อมูล)
//   off         → flag ปิด (ใช้ระบบสมาชิกตามเดิม)
//   coming_soon → flag เปิด แต่ยังไม่มี AI จริง / ไฟล์ / ฐานข้อมูล / กุญแจ / Turnstile → ปุ่มกดไม่ได้
//   ready       → สร้างได้ (ยังต้องผ่านเพดานใน createJob)
export function guestAiState(ctx) {
  const g = ctx.config?.guest;
  if (!g || !g.enabled) return "off";
  const realAi = ctx.ai && ctx.ai.name !== "mock";
  // กันบอท: เปิด Guest ได้เฉพาะเมื่อตั้ง Cloudflare Turnstile ครบ (Site Key + Secret) — ยกเว้นโหมดทดสอบในเครื่อง
  const botCheck = ctx.mock || Boolean(ctx.config.turnstileSecret && ctx.config.turnstileSiteKey);
  return realAi && ctx.repo && ctx.storage && g.key && botCheck ? "ready" : "coming_soon";
}

// ---------- cookie ----------
const sign = (key, id) => createHmac("sha256", key).update(`guest:${id}`).digest("base64url").slice(0, 32);

export function readGuestId(ctx, req) {
  const key = ctx.config.guest?.key;
  if (!key) return null;
  const m = new RegExp(`(?:^|;\\s*)${GUEST_COOKIE}=([a-f0-9]{32})\\.([A-Za-z0-9_-]{32})`).exec(req.headers.cookie || "");
  if (!m) return null;
  const a = Buffer.from(m[2]);
  const b = Buffer.from(sign(key, m[1]));
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}

// ใช้ cookie เดิมถ้ามีและถูกต้อง ไม่งั้นออกใหม่ (HttpOnly · SameSite=Lax · Secure บน https)
export function ensureGuestId(ctx, req, res) {
  const existing = readGuestId(ctx, req);
  if (existing) return existing;
  const id = randomBytes(16).toString("hex");
  const secure = ctx.config.baseUrl.startsWith("https://") ? "; Secure" : "";
  appendCookie(res, `${GUEST_COOKIE}=${id}.${sign(ctx.config.guest.key, id)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`);
  return id;
}

function appendCookie(res, value) {
  const cur = res.getHeader ? res.getHeader("Set-Cookie") : res.headers?.["set-cookie"];
  const list = cur == null ? [] : Array.isArray(cur) ? cur : [cur];
  res.setHeader("Set-Cookie", list.length ? [...list, value] : value);
}

export const ipHash = (ctx, ip) => createHmac("sha256", ctx.config.guest.key).update(`ip:${ip || "unknown"}`).digest("hex").slice(0, 32);

// ช่วงเวลา (เวลาไทย) สำหรับนับเพดาน
const TH_OFFSET = 7 * 3600 * 1000;
export function dayStart(now = Date.now()) {
  const d = new Date(now + TH_OFFSET);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - TH_OFFSET);
}

// สิทธิ์คงเหลือวันนี้ของ Guest (แสดงบนหน้าเว็บ — การบังคับจริงอยู่ใน createJob)
export async function guestUsage(ctx, guestId, ip, now = Date.now()) {
  const g = ctx.config.guest;
  const [mine, byIp, total] = await Promise.all([
    guestId ? ctx.repo.countGuestJobsSince({ since: dayStart(now), guestId }) : 0,
    ctx.repo.countGuestJobsSince({ since: dayStart(now), ipHash: ipHash(ctx, ip) }),
    ctx.repo.countGuestJobsSince({ since: dayStart(now) }),
  ]);
  const paused = total >= g.dailyTotal;
  const remaining = paused ? 0 : Math.max(0, Math.min(g.perGuestDay - mine, g.perIpDay - byIp));
  return { remainingToday: remaining, paused };
}
