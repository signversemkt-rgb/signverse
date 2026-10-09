// เครื่องคำนวณราคาฝั่ง Server — จำลองสูตรจาก "Punch คำนวนราคา.xlsx" ทีละขั้น
// ไฟล์นี้ไม่มีตัวเลขต้นทุน/ตัวคูณ (repo เป็นสาธารณะ) ค่าทั้งหมดมาจาก PRICING_CONFIG
// ดูที่มาของแต่ละสูตรใน PRICING_AUDIT.md และ tools/extract-pricing-config.py
// โฟลเดอร์ขึ้นต้นด้วย "_" จึงไม่ถูก Vercel เปิดเป็น API endpoint

const MATERIALS = [
  "พลาสวูด",
  "ฟิวเจอร์บอร์ด",
  "อะคริลิก",
  "สแตนเลส / โลหะ",
  "ไม้",
  "ไวนิล",
  "ซิงค์ / อลูมิเนียมคอมโพสิต",
  "ยังไม่แน่ใจ ให้ช่วยแนะนำ",
];

const JOB_TYPES = {
  standard: "ป้ายแผ่นพิมพ์ลาย",
  diecut: "ไดคัทตัวอักษร",
  cutout: "ฉลุลาย",
  acrylic_overlay: "พลาสวูดประกบอะคริลิกใส",
};

const LIGHTING = {
  none: "ไม่ติดไฟ",
  white: "ไฟสีขาว (White)",
  warm: "ไฟวอร์มไวท์ (Warm White)",
};

// ข้อมูลที่เปิดเผยได้ของแต่ละสูตร (ไม่มีตัวเลข)
// uvPrint = ชีต Excel ระบุกระบวนการพิมพ์ UV ไว้ชัดเจน
const RULE_META = {
  plaswood_1layer: { uvPrint: false },
  plaswood_2layer: { uvPrint: false },
  plaswood_diecut_lit: { uvPrint: false },
  plaswood_cutout: { uvPrint: false },
  plaswood_acrylic_lit: { uvPrint: true },
  composite: { uvPrint: true },
  vinyl: { uvPrint: false },
};

const MIN_CM = 1;
const MAX_CM = 3000;

// จับคู่ข้อมูลลูกค้า → สูตรใน Excel (null = ยังไม่มีสูตรรองรับ)
function matchRule({ material, layers, jobType, lighting }) {
  const lit = lighting !== "none";
  if (material === "พลาสวูด") {
    if (jobType === "standard" && !lit) return layers === 2 ? "plaswood_2layer" : "plaswood_1layer";
    if (jobType === "diecut" && lit) return "plaswood_diecut_lit";
    if (jobType === "cutout" && !lit) return "plaswood_cutout";
    if (jobType === "acrylic_overlay" && lit) return "plaswood_acrylic_lit";
    return null;
  }
  if (material === "ซิงค์ / อลูมิเนียมคอมโพสิต" && jobType === "standard" && !lit && layers === 1) return "composite";
  if (material === "ไวนิล" && jobType === "standard" && !lit && layers === 1) return "vinyl";
  return null;
}

function isNum(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function validRuleConfig(rule) {
  if (!rule || typeof rule !== "object") return false;
  const base = ["variableCost", "fixedCost", "multiplier", "vatRate"].every((k) => isNum(rule[k]));
  const material = rule.formula === "board" ? isNum(rule.costPerCm2) : rule.formula === "vinyl" ? isNum(rule.materialPerM2) : false;
  const addons = Array.isArray(rule.addons) && rule.addons.every((a) => a && isNum(a.amount));
  return base && material && addons && rule.multiplier > 0;
}

// Excel CEILING(x, 1) — ปัดเศษทศนิยมลอยตัวก่อน เพื่อไม่ให้ 3636.0000000001 กลายเป็น 3637
function excelCeiling(x) {
  return Math.ceil(Number(x.toFixed(9)));
}

// คำนวณตามลำดับเดียวกับเซลล์ใน Excel
function computeTotal(rule, widthCm, heightCm) {
  const addons = rule.addons.reduce((sum, a) => sum + a.amount, 0);
  let preVat;
  if (rule.formula === "board") {
    // ต้นทุนแผ่น = A3*C5*D5 ; ราคาก่อน VAT = (แผ่น + ผันแปร + คงที่) * ตัวคูณ + ค่าขนส่ง
    const sheet = rule.costPerCm2 * widthCm * heightCm;
    preVat = (sheet + rule.variableCost + rule.fixedCost) * rule.multiplier + (rule.shipping || 0);
  } else {
    // ไวนิล: (กว้างม. * ยาวม.) * ค่าวัสดุ/ตรม. + (ผันแปร + คงที่) * ตัวคูณ  (ชีตไวนิลไม่บวกค่าขนส่ง)
    const area = (widthCm / 100) * (heightCm / 100);
    preVat = area * rule.materialPerM2 + (rule.variableCost + rule.fixedCost) * rule.multiplier;
  }
  const withVat = preVat + preVat * rule.vatRate; // รวม VAT
  return excelCeiling(withVat + addons); // บวกค่าบริการเพิ่มแล้วปัดขึ้น
}

// ตรวจและทำความสะอาดข้อมูลจาก Browser
function parseInput(body) {
  const errors = [];
  const widthCm = Number(body && body.widthCm);
  const heightCm = Number(body && body.heightCm);
  const layers = Number(body && body.layers);
  const material = typeof body?.material === "string" ? body.material.trim() : "";
  const jobType = typeof body?.jobType === "string" ? body.jobType.trim() : "";
  const lighting = typeof body?.lighting === "string" ? body.lighting.trim() : "";

  if (!Number.isFinite(widthCm) || widthCm < MIN_CM || widthCm > MAX_CM) errors.push("widthCm");
  if (!Number.isFinite(heightCm) || heightCm < MIN_CM || heightCm > MAX_CM) errors.push("heightCm");
  if (!MATERIALS.includes(material)) errors.push("material");
  if (![1, 2].includes(layers)) errors.push("layers");
  if (!Object.prototype.hasOwnProperty.call(JOB_TYPES, jobType)) errors.push("jobType");
  if (!Object.prototype.hasOwnProperty.call(LIGHTING, lighting)) errors.push("lighting");

  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    errors,
    spec: errors.length ? null : { widthCm: round1(widthCm), heightCm: round1(heightCm), material, layers, jobType, lighting },
  };
}

// ข้อมูลสเปกสำหรับแสดงผล (ไม่มีข้อมูลภายใน)
function describeSpec(spec) {
  return {
    widthCm: spec.widthCm,
    heightCm: spec.heightCm,
    sizeText: `${spec.widthCm} x ${spec.heightCm} ซม.`,
    material: spec.material,
    layers: spec.layers,
    jobType: JOB_TYPES[spec.jobType],
    lighting: LIGHTING[spec.lighting],
  };
}

// คืนค่า: { status: "estimated", price, uvPrint } หรือ { status: "needs_review", reason }
function estimate(spec, config) {
  const ruleId = matchRule(spec);
  if (!ruleId) return { status: "needs_review", reason: "unsupported" };

  const rule = config && config.rules && config.rules[ruleId];
  if (!rule || rule.enabled !== true) return { status: "needs_review", reason: "not_confirmed" };
  if (!validRuleConfig(rule)) return { status: "needs_review", reason: "config_invalid" };

  const maxDim = Math.max(spec.widthCm, spec.heightCm);
  if (isNum(rule.reviewIfMaxDimAbove) && rule.reviewIfMaxDimAbove > 0 && maxDim > rule.reviewIfMaxDimAbove) {
    return { status: "needs_review", reason: "size_review" };
  }

  const price = computeTotal(rule, spec.widthCm, spec.heightCm);
  if (!Number.isFinite(price) || price <= 0) return { status: "needs_review", reason: "calc_failed" };
  return { status: "estimated", price, uvPrint: RULE_META[ruleId].uvPrint };
}

module.exports = {
  MATERIALS,
  JOB_TYPES,
  LIGHTING,
  matchRule,
  computeTotal,
  parseInput,
  describeSpec,
  estimate,
};
