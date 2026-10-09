// LINE Messaging API — ตรวจลายเซ็น Webhook, ผูกกลุ่มพนักงาน, ส่งคำสั่งผลิต
// ใช้ Node crypto เท่านั้น (ไม่มี dependency เพิ่ม)
// หมายเหตุ: LINE_CHANNEL_SECRET ของ Messaging API คนละค่ากับ LINE_CLIENT_SECRET ของ LINE Login
import { createHmac, createHash, timingSafeEqual, randomInt, randomUUID } from "node:crypto";

export const BIND_CODE_TTL_MS = 10 * 60 * 1000;
export const SIGNED_URL_TTL_SEC = 30 * 24 * 60 * 60;     // LINE ดึงรูปตอนผู้ใช้เปิดดู จึงต้องอยู่ได้นานพอ

// ---------- ลายเซ็น Webhook (x-line-signature = base64(HMAC-SHA256(channelSecret, rawBody))) ----------
export function verifySignature(rawBody, signature, channelSecret) {
  if (!channelSecret || typeof signature !== "string" || !signature) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(signature, "base64"); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- รหัสผูกกลุ่ม (ใช้ครั้งเดียว + หมดอายุ) ----------
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";        // ไม่มี 0/O/1/I กันพิมพ์สับสน
export function generateBindCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `SV-${s}`;
}
export function hashCode(code) {
  return createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");
}
export function parseBindCommand(text) {
  const m = /^\s*ผูกกลุ่ม\s+(SV-[A-Z0-9]{8})\s*$/i.exec(String(text || ""));
  return m ? m[1].toUpperCase() : null;
}
export function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ---------- ลิงก์รูปแบบมีลายเซ็น (ให้ LINE ดึงรูปจาก Private Blob ผ่าน /api/files) ----------
function fileSig(secret, jobId, kind, exp) {
  return createHmac("sha256", secret).update(`line-file:${jobId}:${kind}:${exp}`).digest("base64url");
}
export const MIN_SIGNING_SECRET_LENGTH = 32;
export function signingSecretOk(secret) {
  return typeof secret === "string" && secret.length >= MIN_SIGNING_SECRET_LENGTH;
}
export function signedFileUrl({ baseUrl, secret, jobId, kind, now = Date.now(), ttlSec = SIGNED_URL_TTL_SEC }) {
  if (!signingSecretOk(secret)) return null;              // ไม่มี secret ที่ปลอดภัย → ไม่สร้างลิงก์
  const exp = Math.floor(now / 1000) + ttlSec;
  return `${baseUrl}/api/files?job=${jobId}&kind=${kind}&exp=${exp}&sig=${fileSig(secret, jobId, kind, exp)}`;
}
export function verifyFileSig({ secret, jobId, kind, exp, sig, now = Date.now() }) {
  if (!signingSecretOk(secret) || !/^\d{9,11}$/.test(String(exp || "")) || typeof sig !== "string") return false;
  if (Number(exp) * 1000 < now) return false;
  const expected = Buffer.from(fileSig(secret, jobId, kind, exp));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- ข้อความคำสั่งผลิต ----------
const LIGHT = { none: "ไม่ติดไฟ", white: "ไฟสีขาว (White)", warm: "ไฟวอร์มไวท์ (Warm White)" };
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export function buildOrderMessages({ job, customer, staff, note, agreedPrice, artworkUrl, mockupUrl }) {
  const i = job.input || {};
  const lines = [
    "🛠️ คำสั่งผลิตใหม่ — SIGN VERSE",
    `รหัสงาน: ${job.job_id.slice(0, 8).toUpperCase()}`,
    "",
    `ชื่อร้าน: ${clip(i.shopName, 120) || "-"}`,
    `ข้อความบนป้าย: ${clip(i.signText, 300) || "-"}`,
    `ขนาด: ${i.widthCm} x ${i.heightCm} ซม.`,
    `วัสดุ: ${clip(i.material, 60) || "-"} · ${i.layers === 2 ? "2 ชั้น" : "1 ชั้น"}`,
    `ประเภทงาน: ${clip(i.jobType, 60) || "-"}`,
    `ระบบไฟ: ${LIGHT[i.lighting] || "-"}`,
    `โทนสี / สไตล์: ${clip(i.colors, 120) || "-"} / ${clip(i.style, 120) || "-"}`,
    `รายละเอียดลูกค้า: ${clip(i.details, 600) || "-"}`,
  ];
  if (agreedPrice) lines.push(`ราคาที่ตกลง: ${Number(agreedPrice).toLocaleString("th-TH")} บาท`);
  if (note) lines.push(`หมายเหตุพนักงาน: ${clip(note, 500)}`);
  lines.push("", `ลูกค้า: ${clip(customer?.name, 80) || "-"}`, `ยืนยันโดย: ${clip(staff?.name, 80) || "-"}`);
  lines.push("", "⚠️ ภาพ AI เป็นแบบร่าง — ตรวจสอบข้อความ ขนาด และจัดทำไฟล์ผลิตจริงก่อนเข้ากระบวนการผลิต");

  const messages = [{ type: "text", text: lines.join("\n").slice(0, 4900) }];
  for (const url of [artworkUrl, mockupUrl]) {
    if (url) messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  return messages;   // สูงสุด 5 ข้อความต่อครั้งตามข้อกำหนด LINE (ใช้ 3)
}

// ---------- LINE client (จริง / mock) ----------
export function createLineClient({ accessToken, mock = false, fetchImpl = globalThis.fetch }) {
  if (mock) {
    const sent = [];
    return {
      mock: true,
      sent,
      async push(to, messages, retryKey = randomUUID()) { sent.push({ kind: "push", to, messages, retryKey }); return { ok: true }; },
      async reply(replyToken, messages) { sent.push({ kind: "reply", replyToken, messages }); return { ok: true, requestId: `mock-req-${sent.length}` }; },
    };
  }
  if (!accessToken) return null;
  async function call(path, body, extraHeaders = {}) {
    const r = await fetchImpl(`https://api.line.me/v2/bot/message/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...extraHeaders },
      body: JSON.stringify(body),
    });
    const requestId = r.headers && typeof r.headers.get === "function" ? r.headers.get("x-line-request-id") : null;
    if (r.status === 409) return { ok: true, duplicate: true, requestId };   // retry key เดิม = ส่งไปแล้ว
    if (!r.ok) throw Object.assign(new Error(`line_${r.status}`), { status: r.status, requestId });
    return { ok: true, requestId };
  }
  return {
    mock: false,
    // X-Line-Retry-Key: ส่งซ้ำด้วย key เดิม LINE จะไม่ส่งข้อความซ้ำ
    push: (to, messages, retryKey = randomUUID()) => call("push", { to, messages }, { "X-Line-Retry-Key": retryKey }),
    reply: (replyToken, messages) => call("reply", { replyToken, messages }),
  };
}
