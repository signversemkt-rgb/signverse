// HTTP helpers สำหรับ Vercel Node functions (ไม่มี dependency ภายนอก)

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// ข้อความ error ภาษาไทยตามรหัส (ไม่เปิดเผยรายละเอียดภายใน)
const MESSAGES = {
  unauthenticated: "กรุณาเข้าสู่ระบบก่อนใช้งาน",
  forbidden: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้",
  suspended: "บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อทีมงานทาง LINE",
  bad_request: "ข้อมูลไม่ถูกต้อง",
  bad_origin: "คำขอไม่ได้มาจากเว็บไซต์ SIGN VERSE",
  not_found: "ไม่พบข้อมูล",
  rate_limited: "มีการใช้งานบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
  quota_exhausted: "คุณใช้สิทธิ์ทดลองออกแบบฟรีครบแล้ว",
  job_in_progress: "มีงานออกแบบที่กำลังประมวลผลอยู่ กรุณารอให้เสร็จก่อน",
  daily_limit: "วันนี้มีผู้ใช้สิทธิ์ทดลองครบตามจำนวนแล้ว กรุณาลองใหม่พรุ่งนี้ หรือทักทีมงานทาง LINE",
  step_busy: "ภาพนี้กำลังถูกสร้างอยู่ กรุณารอสักครู่",
  step_not_ready: "ต้องสร้าง Artwork ให้สำเร็จก่อนสร้าง Mockup",
  retry_limit: "ลองใหม่ครบจำนวนครั้งแล้ว กรุณาทักทีมงานทาง LINE",
  job_closed: "งานนี้ปิดแล้ว",
  invalid_file: "ไฟล์รูปไม่ถูกต้อง รองรับเฉพาะ JPG, PNG และ WebP",
  file_too_large: "ไฟล์รูปมีขนาดใหญ่เกินกำหนด",
  too_many_files: "จำนวนรูปเกินกำหนด",
  invalid_reference: "ภาพอ้างอิงบางภาพไม่สามารถใช้งานได้",
  bot_check_failed: "ยืนยันว่าไม่ใช่บอทไม่สำเร็จ กรุณาลองใหม่",
  ai_unavailable: "ระบบสร้างภาพ AI ยังไม่เปิดใช้งาน",
  ai_failed: "สร้างภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
  not_configured: "ระบบนี้ยังไม่ได้ตั้งค่าบนเซิร์ฟเวอร์",
  bad_signature: "ลายเซ็นไม่ถูกต้อง",
  feature_disabled: "ฟีเจอร์นี้ปิดใช้งานอยู่",
  line_failed: "ส่งข้อความเข้า LINE ไม่สำเร็จ กรุณาลองใหม่ (ระบบจะไม่ส่งซ้ำ)",
  server_error: "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง",
};

export function errorBody(code) {
  return { error: MESSAGES[code] || MESSAGES.server_error, code };
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  if (err instanceof HttpError) return sendJson(res, err.status, errorBody(err.code));
  console.error("[api] unexpected error:", err && err.name, err && err.message);
  return sendJson(res, 500, errorBody("server_error"));
}

// อ่าน JSON body พร้อมจำกัดขนาด (Vercel จำกัด 4.5 MB อยู่แล้ว)
export async function readJson(req, maxBytes = 1_000_000) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return parseOrThrow(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "file_too_large");
    chunks.push(chunk);
  }
  return parseOrThrow(Buffer.concat(chunks).toString("utf8") || "{}");
}

function parseOrThrow(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") throw new Error("not object");
    return v;
  } catch {
    throw new HttpError(400, "bad_request");
  }
}

export function getIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

// กัน CSRF: คำขอที่แก้ไขข้อมูลต้องมาจาก origin ของเว็บเราเท่านั้น
export function assertSameOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) throw new HttpError(403, "bad_origin");
}

export function allowedOrigins(env) {
  const list = [env.BETTER_AUTH_URL, env.APP_ORIGIN].filter(Boolean).map((u) => u.replace(/\/$/, ""));
  return list;
}

export function method(req, ...allowed) {
  if (!allowed.includes(req.method)) {
    throw new HttpError(405, "bad_request");
  }
}

export function query(req) {
  const url = new URL(req.url, "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  // ตัดอักขระควบคุมที่ไม่ใช่ขึ้นบรรทัด
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

export function isId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}
