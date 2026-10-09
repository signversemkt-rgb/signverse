// Vercel Serverless Function: POST /api/estimate-price
// ประเมินราคาป้ายจากสูตรจริงของร้าน (คำนวณฝั่ง Server เท่านั้น)
// ต้องตั้ง Environment Variable: PRICING_CONFIG (JSON จาก tools/extract-pricing-config.py)
// ตอบกลับเฉพาะราคาประเมิน + สเปก — ไม่ส่งต้นทุน ตัวคูณ หรือสูตรกลับไป

const { parseInput, describeSpec, estimate } = require("./_lib/pricing");

const NOTE = "ราคาประเมินอาจเปลี่ยนแปลงตามรายละเอียดงานจริง • ยังไม่รวมค่าจัดส่ง";
const REVIEW_MESSAGE = "งานรูปแบบนี้ต้องประเมินราคาเพิ่มเติม กรุณาส่งรายละเอียดให้ทีม SIGN VERSE ตรวจสอบ";

// จำกัดคำขอแบบต่อ instance (best-effort) — การคำนวณไม่มีค่าใช้จ่ายภายนอก
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 120;   // ราคาคำนวณทันทีเมื่อเปลี่ยนตัวเลือก (หน้าเว็บหน่วง 0.4 วิ + จำผลเดิม)
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // กันหน่วยความจำโต
  return recent.length > MAX_REQUESTS;
}

let cachedConfig;
function loadConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    cachedConfig = process.env.PRICING_CONFIG ? JSON.parse(process.env.PRICING_CONFIG) : null;
  } catch {
    console.error("[estimate-price] PRICING_CONFIG is not valid JSON");
    cachedConfig = null;
  }
  return cachedConfig;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", error: "รองรับเฉพาะ POST เท่านั้น" });
  }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ status: "error", error: "มีการขอราคาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }

  const { errors, spec } = parseInput(body || {});
  if (errors.length) {
    return res.status(400).json({ status: "error", error: "กรุณากรอกขนาดและตัวเลือกป้ายให้ถูกต้อง", fields: errors });
  }

  const config = loadConfig();
  if (!config) {
    console.error("[estimate-price] PRICING_CONFIG is missing");
  }

  const result = estimate(spec, config);
  const details = describeSpec(spec);

  if (result.status !== "estimated") {
    return res.status(200).json({ status: "needs_review", message: REVIEW_MESSAGE, spec: details, note: NOTE });
  }

  return res.status(200).json({
    status: "estimated",
    price: result.price,
    currency: "THB",
    spec: details,
    uvPrint: result.uvPrint,
    note: NOTE,
  });
};
