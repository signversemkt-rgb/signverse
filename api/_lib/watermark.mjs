// ลายน้ำ SIGN VERSE • PREVIEW ฝั่ง Server (sharp, Apache-2.0)
// - วางภาพลายน้ำ PNG ที่เตรียมไว้ (fixtures/watermark.png) ทับทั้งภาพ → ไม่ต้องพึ่งฟอนต์บน Server
// - ผลลัพธ์เป็น PNG (LINE รับได้) และไม่มี metadata/EXIF ติดไป
// - ลูกค้าได้รับเฉพาะภาพที่มีลายน้ำ · ต้นฉบับไม่มีลายน้ำเก็บใน Private Blob สำหรับพนักงาน/สร้าง Mockup เท่านั้น
import { readFile } from "node:fs/promises";

const WATERMARK = new URL("./fixtures/watermark.png", import.meta.url);
let sharpPromise = null;
let overlayCache = null;

export function loadSharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then((m) => m.default || m);
  return sharpPromise;
}

export async function applyWatermark(bytes, { sharp } = {}) {
  const s = sharp || (await loadSharp());
  const input = Buffer.from(bytes);
  const meta = await s(input).metadata();
  if (!meta.width || !meta.height) throw new Error("watermark_bad_image");
  const key = `${meta.width}x${meta.height}`;
  if (!overlayCache || overlayCache.key !== key) {
    const tile = await readFile(WATERMARK);
    overlayCache = { key, buf: await s(tile).resize(meta.width, meta.height, { fit: "fill" }).png().toBuffer() };
  }
  const out = await s(input).composite([{ input: overlayCache.buf, blend: "over" }]).png({ compressionLevel: 8 }).toBuffer();
  return { bytes: new Uint8Array(out), mime: "image/png", ext: "png", width: meta.width, height: meta.height };
}
