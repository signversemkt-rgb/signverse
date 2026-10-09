// เข้าสู่ระบบด้วยเบอร์โทรศัพท์ + OTP — ส่วนตรวจรหัส (ไม่ผูกกับ Better Auth เพื่อทดสอบได้ในเครื่อง)
// - รับเฉพาะเบอร์มือถือไทย 06/08/09 → เก็บเป็น E.164 (+66…)
// - OTP 6 หลัก หมดอายุ 5 นาที · เก็บเป็น HMAC hash เท่านั้น · ห้ามเขียน OTP หรือเบอร์เต็มลง Log
// - กรอกผิดได้ไม่เกิน 5 ครั้งต่อคำขอ · ใช้ได้ครั้งเดียว (consume แบบมีเงื่อนไข กัน Race Condition)
// - ส่งซ้ำได้หลัง 60 วินาที · จำกัดต่อเบอร์ / ต่อ IP / ทั้งระบบต่อวัน (กัน SMS Bombing และค่าใช้จ่ายผิดปกติ)
import { createHmac, createHash, randomInt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.mjs";

export const OTP_TTL_SEC = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SEC = 60;
export const DEFAULT_LIMITS = {
  perPhoneHour: 5,
  perPhoneDay: 10,
  perIpHour: 10,
  perIpDay: 30,
  dailyTotal: 200,            // เพดาน SMS ทั้งระบบต่อวัน (OTP_DAILY_LIMIT)
};
export const MIN_OTP_SECRET_LENGTH = 32;

// "081-234-5678" / "0812345678" / "+66812345678" / "66812345678" → "+66812345678" | null
export function normalizeThaiMobile(input) {
  const digits = String(input ?? "").replace(/[\s\-().]/g, "");
  let local = null;
  if (/^0[689]\d{8}$/.test(digits)) local = digits.slice(1);
  else if (/^\+66[689]\d{8}$/.test(digits)) local = digits.slice(3);
  else if (/^66[689]\d{8}$/.test(digits)) local = digits.slice(2);
  return local ? `+66${local}` : null;
}
export const isThaiMobileE164 = (v) => typeof v === "string" && /^\+66[689]\d{8}$/.test(v);

// แสดงผลแบบปิดบัง: +66812345678 → "081-xxx-5678"
export function maskPhone(e164) {
  if (!isThaiMobileE164(e164)) return "เบอร์โทรศัพท์";
  const local = `0${e164.slice(3)}`;
  return `${local.slice(0, 3)}-xxx-${local.slice(6)}`;
}

// อีเมลแทน (ตาราง user บังคับมีอีเมล) — โดเมน .invalid ส่งอีเมลจริงไม่ได้ และไม่มีเบอร์อยู่ในอีเมล
export function phoneTempEmail(e164) {
  return `p${createHash("sha256").update(`sv-phone:${e164}`).digest("hex").slice(0, 24)}@phone.signverse.invalid`;
}

export function otpSecretOk(secret) {
  return typeof secret === "string" && secret.length >= MIN_OTP_SECRET_LENGTH;
}
const hmac = (secret, label, value) => createHmac("sha256", secret).update(`${label}:${value}`).digest("hex");
export const phoneHash = (secret, e164) => hmac(secret, "phone", e164);
const ipHash = (secret, ip) => hmac(secret, "ip", ip || "unknown").slice(0, 32);
const codeHash = (secret, requestId, code) => hmac(secret, `otp:${requestId}`, code);

function sameHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function otpMessage(code) {
  // สั้นไม่เกิน 70 ตัวอักษร = 1 เครดิต SMS
  return `รหัส OTP SIGN VERSE: ${code} (ใช้ได้ 5 นาที) ห้ามบอกรหัสนี้กับผู้อื่น`;
}

// repo ต้องมี: hitRateLimit, createOtpRequest, latestOtpRequest, supersedeOtpRequests, countOtpSince,
//              deleteOtpRequest, bumpOtpAttempt (atomic), consumeOtpRequest (atomic)
export function createOtpService({ repo, sms, secret, uuid, limits = {}, now = () => Date.now(), logger = console }) {
  if (!otpSecretOk(secret)) throw new Error("otp_secret_missing");
  const L = { ...DEFAULT_LIMITS, ...limits };

  async function limit(key, max, windowSec, code = "otp_rate_limited") {
    if (!(await repo.hitRateLimit(key, max, windowSec))) throw new HttpError(429, code);
  }

  return {
    // ขอรหัส: ตรวจเบอร์ → จำกัดการส่ง → สร้างรหัส (เก็บ hash) → ส่ง SMS
    async send({ phone, ip }) {
      if (!isThaiMobileE164(phone)) throw new HttpError(400, "invalid_phone");
      const ph = phoneHash(secret, phone);
      const t = now();

      const last = await repo.latestOtpRequest(ph);
      if (last && t - new Date(last.created_at).getTime() < OTP_RESEND_SEC * 1000) {
        const wait = Math.ceil((OTP_RESEND_SEC * 1000 - (t - new Date(last.created_at).getTime())) / 1000);
        throw Object.assign(new HttpError(429, "otp_resend_wait"), { retryAfter: wait });
      }
      const ih = ipHash(secret, ip);
      await limit(`otp:ip:h:${ih}`, L.perIpHour, 3600);
      await limit(`otp:ip:d:${ih}`, L.perIpDay, 86400);
      await limit(`otp:ph:h:${ph}`, L.perPhoneHour, 3600);
      await limit(`otp:ph:d:${ph}`, L.perPhoneDay, 86400);
      if ((await repo.countOtpSince(new Date(t - 86400 * 1000).toISOString())) >= L.dailyTotal) {
        logger.error("[otp] daily SMS limit reached");
        throw new HttpError(429, "otp_daily_limit");
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const id = uuid();
      await repo.supersedeOtpRequests(ph, new Date(t).toISOString());      // รหัสเก่าของเบอร์นี้ใช้ไม่ได้อีก
      await repo.createOtpRequest({
        request_id: id, phone_hash: ph, code_hash: codeHash(secret, id, code), attempts: 0,
        expires_at: new Date(t + OTP_TTL_SEC * 1000).toISOString(), consumed_at: null,
        created_at: new Date(t).toISOString(), ip_hash: ih,
      });
      try {
        await sms.send(phone, otpMessage(code));
      } catch (err) {
        await repo.deleteOtpRequest(id).catch(() => {});
        logger.error("[otp] sms send failed:", maskPhone(phone), err && (err.status || err.name));
        throw new HttpError(502, "sms_failed");
      }
      return { resendAfter: OTP_RESEND_SEC, expiresIn: OTP_TTL_SEC };
    },

    // ตรวจรหัส: true = ถูกต้องและใช้รหัสนี้ไปแล้ว (ใช้ซ้ำไม่ได้) · ผิด/หมดอายุ/ครบจำนวนครั้ง → HttpError
    async verify({ phone, code }) {
      if (!isThaiMobileE164(phone)) throw new HttpError(400, "invalid_phone");
      if (!/^\d{6}$/.test(String(code ?? ""))) throw new HttpError(400, "otp_invalid");
      const ph = phoneHash(secret, phone);
      const t = new Date(now()).toISOString();
      const cur = await repo.latestOtpRequest(ph);
      if (!cur || cur.consumed_at) throw new HttpError(400, "otp_not_found");
      if (cur.expires_at <= t) throw new HttpError(400, "otp_expired");
      // นับครั้งก่อนเทียบรหัส (atomic) → ยิงพร้อมกันหลายคำขอก็เกิน 5 ครั้งไม่ได้
      const row = await repo.bumpOtpAttempt(cur.request_id, OTP_MAX_ATTEMPTS, t);
      if (!row) {
        const again = await repo.latestOtpRequest(ph);
        if (!again || again.request_id !== cur.request_id || again.consumed_at) throw new HttpError(400, "otp_not_found");
        if (again.expires_at <= t) throw new HttpError(400, "otp_expired");
        throw new HttpError(429, "otp_too_many_attempts");
      }
      if (!sameHex(row.code_hash, codeHash(secret, row.request_id, String(code)))) {
        throw new HttpError(400, row.attempts >= OTP_MAX_ATTEMPTS ? "otp_too_many_attempts" : "otp_invalid");
      }
      // ใช้รหัสได้ครั้งเดียว — คำขอที่มาพร้อมกันจะมีเพียงคำขอเดียวที่ consume สำเร็จ
      if (!(await repo.consumeOtpRequest(row.request_id, t))) throw new HttpError(400, "otp_not_found");
      return true;
    },
  };
}

// ---------- ผู้ส่ง SMS ----------
// ThaiBulkSMS API v2: POST https://api-v2.thaibulksms.com/sms (Basic Auth: API key / secret, form: msisdn, message, sender)
export function createSmsClient({ provider, env, mock = false, fetchImpl = globalThis.fetch, logger = console }) {
  if (provider === "mock") {
    if (!mock) return null;                                 // ห้ามใช้ SMS จำลองนอกโหมดทดสอบในเครื่อง
    const sent = [];
    return {
      name: "mock",
      sent,
      async send(phone, message) {
        sent.push({ phone, message });
        // ในเครื่องเท่านั้น: แสดงรหัสใน console ของ dev server เพื่อทดสอบหน้าเว็บ (Production ใช้ mock ไม่ได้)
        if (env.MOCK_SMS_ECHO === "1") logger.log(`[mock-sms] ${maskPhone(phone)}: ${message}`);
        return { ok: true };
      },
    };
  }
  if (provider === "thaibulksms") {
    const key = env.THAIBULKSMS_API_KEY, secret = env.THAIBULKSMS_API_SECRET, sender = env.SMS_SENDER_NAME;
    if (!key || !secret || !sender) return null;
    return {
      name: "thaibulksms",
      async send(phone, message) {
        const body = new URLSearchParams({ msisdn: `0${phone.slice(3)}`, message, sender });
        const r = await fetchImpl("https://api-v2.thaibulksms.com/sms", {
          method: "POST",
          headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body,
        });
        if (!r.ok) throw Object.assign(new Error(`sms_${r.status}`), { status: r.status });
        return { ok: true };
      },
    };
  }
  return null;
}

// พร้อมใช้งานเมื่อมีผู้ส่ง SMS + secret สำหรับ hash ครบ
export function phoneLoginConfig(env, { mock = false } = {}) {
  const provider = env.SMS_PROVIDER || (mock ? "mock" : "");
  const secret = env.OTP_HASH_SECRET || (mock ? "mock-otp-hash-secret-0123456789abcdef" : "");
  const sms = createSmsClient({ provider, env, mock });
  const limits = env.OTP_DAILY_LIMIT ? { dailyTotal: Math.max(1, Number.parseInt(env.OTP_DAILY_LIMIT, 10) || DEFAULT_LIMITS.dailyTotal) } : {};
  return { ready: Boolean(sms && otpSecretOk(secret)), sms, secret, limits };
}
