// ทดสอบเครื่องคำนวณราคาเทียบกับ Excel
// รัน: node --test tests/   (ต้องมี private/pricing-config.json และ private/pricing-fixtures.json
// ซึ่งสร้างจาก tools/extract-pricing-config.py — ถ้าไม่มี ชุดที่ต้องใช้ข้อมูลลับจะถูกข้าม)

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const pricing = require("../api/_lib/pricing");

const PRIVATE = path.join(__dirname, "..", "private");
const hasPrivate = fs.existsSync(path.join(PRIVATE, "pricing-config.json"));
const load = (f) => JSON.parse(fs.readFileSync(path.join(PRIVATE, f), "utf8"));

const enableAll = (config) => {
  const copy = JSON.parse(JSON.stringify(config));
  Object.values(copy.rules).forEach((r) => { r.enabled = true; });
  return copy;
};

test("ราคาตรงกับ Excel ทุกขนาดตัวอย่าง", { skip: !hasPrivate }, () => {
  const config = load("pricing-config.json");
  for (const f of load("pricing-fixtures.json")) {
    const got = pricing.computeTotal(config.rules[f.rule], f.widthCm, f.heightCm);
    assert.strictEqual(got, f.expected, `${f.rule} ${f.widthCm}x${f.heightCm} (${f.source})`);
  }
});

test("สูตรที่ยังไม่ยืนยัน (enabled=false) ต้องไม่แสดงราคา", { skip: !hasPrivate }, () => {
  const config = load("pricing-config.json");
  const spec = { widthCm: 120, heightCm: 120, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" };
  assert.deepStrictEqual(pricing.estimate(spec, config), { status: "needs_review", reason: "not_confirmed" });
});

test("จับคู่สูตรตามวัสดุ/ชั้น/ประเภทงาน/ไฟ", () => {
  const m = (material, layers, jobType, lighting) => pricing.matchRule({ material, layers, jobType, lighting });
  assert.strictEqual(m("พลาสวูด", 1, "standard", "none"), "plaswood_1layer");
  assert.strictEqual(m("พลาสวูด", 2, "standard", "none"), "plaswood_2layer");
  assert.strictEqual(m("พลาสวูด", 1, "standard", "white"), null);
  assert.strictEqual(m("พลาสวูด", 2, "diecut", "warm"), "plaswood_diecut_lit");
  assert.strictEqual(m("พลาสวูด", 1, "diecut", "none"), null);
  assert.strictEqual(m("พลาสวูด", 1, "cutout", "none"), "plaswood_cutout");
  assert.strictEqual(m("พลาสวูด", 1, "acrylic_overlay", "white"), "plaswood_acrylic_lit");
  assert.strictEqual(m("ซิงค์ / อลูมิเนียมคอมโพสิต", 1, "standard", "none"), "composite");
  assert.strictEqual(m("ไวนิล", 1, "standard", "none"), "vinyl");
  for (const mat of ["ฟิวเจอร์บอร์ด", "อะคริลิก", "สแตนเลส / โลหะ", "ไม้", "ยังไม่แน่ใจ ให้ช่วยแนะนำ"]) {
    assert.strictEqual(m(mat, 1, "standard", "none"), null, mat);
  }
});

test("ไม่มี config → ไม่แสดงราคา (ไม่ใช่ 0 บาท)", () => {
  const spec = { widthCm: 120, heightCm: 120, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" };
  assert.strictEqual(pricing.estimate(spec, null).status, "needs_review");
  assert.strictEqual(pricing.estimate(spec, { rules: {} }).status, "needs_review");
});

test("งานติดไฟเกินขนาดที่กำหนด → ให้ทีมงานประเมิน", { skip: !hasPrivate }, () => {
  const config = enableAll(load("pricing-config.json"));
  const spec = { widthCm: 600, heightCm: 100, material: "พลาสวูด", layers: 2, jobType: "diecut", lighting: "white" };
  assert.strictEqual(pricing.estimate(spec, config).reason, "size_review");
});

test("ตรวจข้อมูลไม่ถูกต้อง", () => {
  const bad = [
    {},
    { widthCm: 0, heightCm: 100, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" },
    { widthCm: "abc", heightCm: 100, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" },
    { widthCm: 100, heightCm: 99999, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" },
    { widthCm: 100, heightCm: 100, material: "ฟิวเจอร์บอร์ด / พลาสวูด", layers: 1, jobType: "standard", lighting: "none" },
    { widthCm: 100, heightCm: 100, material: "พลาสวูด", layers: 3, jobType: "standard", lighting: "none" },
    { widthCm: 100, heightCm: 100, material: "พลาสวูด", layers: 1, jobType: "<script>", lighting: "none" },
  ];
  for (const b of bad) assert.ok(pricing.parseInput(b).errors.length > 0, JSON.stringify(b));
  const ok = pricing.parseInput({ widthCm: "120", heightCm: 80.25, material: "พลาสวูด", layers: "2", jobType: "standard", lighting: "warm" });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.spec.layers, 2);
});

test("ผลลัพธ์ไม่มีข้อมูลต้นทุนหรือส่วนลด", { skip: !hasPrivate }, () => {
  const config = enableAll(load("pricing-config.json"));
  const spec = { widthCm: 120, heightCm: 120, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" };
  const out = JSON.stringify(pricing.estimate(spec, config));
  for (const word of ["cost", "multiplier", "addons", "discount", "vat", "fixed", "variable"]) {
    assert.ok(!out.toLowerCase().includes(word), word);
  }
});
