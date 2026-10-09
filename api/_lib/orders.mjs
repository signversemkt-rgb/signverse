// คำขอสั่งผลิต ("สั่งผลิตป้ายนี้") → บันทึกใน Neon + เตรียมข้อความให้ลูกค้าส่งเองใน LINE OA ของร้าน
// - ราคาประเมินคำนวณใหม่ฝั่ง Server จากสูตรร้าน (ไม่เชื่อราคาที่ Browser ส่งมา)
// - ลิงก์ LINE: https://line.me/R/oaMessage/{%40id}/?{ข้อความ} — เติมข้อความในช่องพิมพ์ ลูกค้าต้องกดส่งเอง
//   (รองรับ LINE บน iOS/Android เท่านั้น ไม่รองรับ LINE PC → หน้าเว็บมีปุ่มคัดลอกข้อความเป็นทางสำรอง)
import { randomInt } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pricing = require("./pricing.js");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIGHT = { none: "ไม่ติดไฟ", white: "ไฟสีขาว (White)", warm: "ไฟวอร์มไวท์ (Warm White)" };
const JOB = { standard: "ป้ายแผ่นพิมพ์ลาย", diecut: "ไดคัทตัวอักษร", cutout: "ฉลุลาย", acrylic_overlay: "พลาสวูดประกบอะคริลิกใส" };
export const STATUSES = ["new", "contacted", "confirmed", "in_production", "completed", "cancelled"];
export const MAX_LINE_TEXT = 900;    // ข้อความยาวเกินทำให้ลิงก์ยาวเกินที่แอปบางรุ่นรับได้

// เลขออร์เดอร์: SV + ปีเดือนวัน (เวลาไทย) + รหัสสุ่ม 4 ตัว เช่น SV261009-7KQ4
export function generateOrderNo(now = Date.now()) {
  const th = new Date(now + 7 * 3600 * 1000);
  const ymd = th.toISOString().slice(2, 10).replace(/-/g, "");
  let r = "";
  for (let i = 0; i < 4; i++) r += ALPHABET[randomInt(ALPHABET.length)];
  return `SV${ymd}-${r}`;
}

let cached = { raw: undefined, config: null };
function pricingConfig(env) {
  const raw = env.PRICING_CONFIG || "";
  if (cached.raw === raw) return cached.config;
  let config = null;
  try { config = raw ? JSON.parse(raw) : null; } catch { config = null; }
  cached = { raw, config };
  return config;
}

// คืนราคาเป็นจำนวนเต็ม หรือ null (= รอทีมงานประเมิน) — ไม่คืนต้นทุน/สูตร
export function estimateFromForm(form, env) {
  const { errors, spec } = pricing.parseInput({
    widthCm: form.widthCm, heightCm: form.heightCm, material: form.material,
    layers: form.layers, jobType: form.jobType, lighting: form.lighting,
  });
  if (errors.length) return null;
  const r = pricing.estimate(spec, pricingConfig(env));
  return r.status === "estimated" ? r.price : null;
}

const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

// รหัสยืนยันออร์เดอร์ (ลูกค้าส่งในแชต LINE) — 8 ตัว ~40 bit เดายาก, แสดงเฉพาะเจ้าของออร์เดอร์
export function generateClaimCode() {
  let r = "";
  for (let i = 0; i < 8; i++) r += ALPHABET[randomInt(ALPHABET.length)];
  return `${r.slice(0, 4)}-${r.slice(4)}`;
}

// อ่านเลขออร์เดอร์ + รหัสยืนยันจากข้อความในแชต (ต้องมีทั้งสองอย่าง)
export function parseOrderRef(text) {
  const t = String(text || "").toUpperCase();
  const no = /\bSV\d{6}-[A-Z0-9]{4}\b/.exec(t);
  const code = /รหัสยืนยัน\s*[:：]?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(t);
  return no && code ? { orderNo: no[0], code: code[1] } : null;
}

export const DELIVERY_LABELS = {
  awaiting_customer: "รอส่งผ่าน LINE",
  sending: "กำลังส่งผ่าน LINE",
  sent: "ส่งผ่าน LINE สำเร็จ",
  failed: "ส่งผ่าน LINE ไม่สำเร็จ",
};

export function buildLineText(order) {
  const f = order.form;
  const lines = [
    "สั่งผลิตงานป้ายตามฟอร์มที่ลูกค้ากรอก",
    `เลขออร์เดอร์: ${order.order_no}`,
    `ชื่อร้าน: ${clip(f.shopName, 80) || "-"}`,
    `ข้อความบนป้าย: ${clip(f.signText, 120) || "-"}`,
    `ขนาด: ${f.widthCm} x ${f.heightCm} ซม.`,
    `วัสดุ: ${clip(f.material, 40) || "-"} (${Number(f.layers) === 2 ? "2 ชั้น" : "1 ชั้น"})`,
    `ประเภทงาน: ${JOB[f.jobType] || "-"}`,
    `ระบบไฟ: ${LIGHT[f.lighting] || "-"}`,
    `ราคาประเมิน: ${order.price_estimate ? `${Number(order.price_estimate).toLocaleString("th-TH")} บาท (ยังไม่รวมค่าจัดส่ง)` : "รอทีมงานประเมิน"}`,
  ];
  if (f.colors || f.style) lines.push(`โทน/สไตล์: ${clip(f.colors, 60) || "-"} / ${clip(f.style, 40) || "-"}`);
  if (f.details) lines.push(`รายละเอียด: ${clip(f.details, 200)}`);
  lines.push(order.job_id ? "มีภาพ Artwork และ Mockup ในระบบ" : "ยังไม่มีภาพจาก AI");
  const body = lines.join("\n").slice(0, MAX_LINE_TEXT - 40);
  // รหัสยืนยันต้องอยู่ท้ายเสมอ (ไม่ถูกตัด) — ใช้ยืนยันออร์เดอร์และให้ระบบส่งภาพกลับในแชตนี้
  return `${body}\nรหัสยืนยัน: ${order.claim_code}`;
}

export function lineOaUrls(oaId, text) {
  const id = encodeURIComponent(oaId.startsWith("@") ? oaId : `@${oaId}`);
  return {
    chatWithText: `https://line.me/R/oaMessage/${id}/?${encodeURIComponent(text)}`,   // มือถือ
    profile: `https://line.me/R/ti/p/${id}`,                                            // คอมพิวเตอร์: หน้า OA / QR
  };
}

// ตรวจฟอร์มที่ใช้สั่งผลิต (ไม่รับราคา/สถานะใด ๆ จาก Browser)
export function cleanOrderForm(src, cleanText) {
  const f = {
    shopName: cleanText(src.shopName, 120), signText: cleanText(src.signText, 300),
    colors: cleanText(src.colors, 120), style: cleanText(src.style, 120), details: cleanText(src.details, 1500),
    budget: cleanText(src.budget, 80), deadline: cleanText(src.deadline, 40),
    material: cleanText(src.material, 60), jobType: Object.keys(JOB).includes(src.jobType) ? src.jobType : "standard",
    lighting: Object.keys(LIGHT).includes(src.lighting) ? src.lighting : "none",
    layers: Number(src.layers) === 2 ? 2 : 1,
  };
  const w = Number(src.widthCm), h = Number(src.heightCm);
  if (!(w >= 1 && w <= 3000 && h >= 1 && h <= 3000)) return null;
  if (!f.shopName && !f.signText) return null;
  f.widthCm = Math.round(w * 10) / 10;
  f.heightCm = Math.round(h * 10) / 10;
  return f;
}

export function orderView(o, { lineText = false, oaId } = {}) {
  const v = {
    orderId: o.order_id, orderNo: o.order_no, status: o.status, createdAt: o.created_at, jobId: o.job_id,
    priceEstimate: o.price_estimate, form: o.form, staffNote: o.staff_note ?? "",
    // สถานะการส่งผ่าน LINE (แยกจากสถานะการผลิต) — "sent" = LINE API รับข้อความแล้ว ไม่ได้แปลว่าพนักงานเห็นแล้ว
    lineDelivery: {
      status: o.line_delivery_status || "awaiting_customer",
      label: DELIVERY_LABELS[o.line_delivery_status || "awaiting_customer"],
      channel: o.line_delivery_channel || null,
      deliveredAt: o.line_delivered_at || null,
      attempts: o.line_delivery_attempts || 0,
      error: o.line_delivery_error || null,
      requestId: o.line_request_id || null,
      lineUserLinked: Boolean(o.line_user_id),
    },
  };
  if (lineText) {
    v.lineText = buildLineText(o);
    v.line = lineOaUrls(oaId, v.lineText);
  }
  return v;
}
