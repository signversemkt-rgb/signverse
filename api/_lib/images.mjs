// ตรวจไฟล์รูปจาก "เนื้อไฟล์จริง" (magic bytes) — ไม่เชื่อนามสกุลหรือ Content-Type จาก Browser
import { HttpError } from "./http.mjs";

export const LIMITS = {
  customerBytes: 3 * 1024 * 1024,     // รูปลูกค้า (ย่อในเบราว์เซอร์แล้ว)
  galleryBytes: 3 * 1024 * 1024,      // รูปผลงาน (ย่อในเบราว์เซอร์แล้ว)
  thumbBytes: 400 * 1024,
  maxReferenceUploads: 3,
  maxReferences: 3,                   // รวมทุกแหล่ง (อัลบั้ม + อัปโหลดเอง)
  maxDimension: 4096,
};

export function detectImage(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: "image/png", ext: "png" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", ext: "webp" };
  return null;
}

// อ่านขนาดภาพจาก header (PNG/JPEG/WebP) เพื่อกันไฟล์ขนาดผิดปกติ
export function imageSize(bytes, mime) {
  const b = bytes;
  const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (mime === "image/png") return { width: u32(16), height: u32(20) };
  if (mime === "image/webp") {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// base64 (data URL หรือ base64 ล้วน) → ตรวจชนิด/ขนาด
export function decodeImage(base64, maxBytes) {
  if (typeof base64 !== "string" || base64.length === 0) throw new HttpError(400, "invalid_file");
  const raw = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new HttpError(400, "invalid_file");
  if (raw.length * 0.75 > maxBytes + 4) throw new HttpError(413, "file_too_large");
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.length > maxBytes) throw new HttpError(413, "file_too_large");
  const type = detectImage(bytes);
  if (!type) throw new HttpError(400, "invalid_file");
  const size = imageSize(bytes, type.mime);
  if (!size || !size.width || !size.height || size.width > LIMITS.maxDimension || size.height > LIMITS.maxDimension) {
    throw new HttpError(400, "invalid_file");
  }
  return { bytes, ...type, ...size };
}
