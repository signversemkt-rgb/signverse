// Mock AI Provider — สร้างภาพตัวอย่าง (SVG) โดยไม่เรียก API ที่มีค่าใช้จ่าย
// ภาพมีลายน้ำ "SIGN VERSE • PREVIEW" ฝังอยู่ในไฟล์จริง (ไม่ใช่ CSS overlay)
// options.fail = { artwork: "error" | "timeout", mockup: ... } ใช้จำลองความล้มเหลวในการทดสอบ
// options.format = "png" (ค่าเริ่มต้น: รูป PNG ตัวอย่าง 1536x1024 ที่มีลายน้ำ — ใช้ทดสอบการส่งเข้า LINE) | "svg" (ภาพตามข้อมูลฟอร์ม)
import { readFile } from "node:fs/promises";

const FIXTURES = {
  artwork: new URL("./fixtures/mock-artwork.png", import.meta.url),
  mockup: new URL("./fixtures/mock-mockup.png", import.meta.url),
};

const esc = (s) => String(s || "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

const WATERMARK = `
  <g opacity="0.2" transform="rotate(-24 768 512)" fill="#ffffff" font-family="Arial, sans-serif" font-weight="700" font-size="64" text-anchor="middle">
    <text x="768" y="380">SIGN VERSE • PREVIEW</text>
    <text x="768" y="560">SIGN VERSE • PREVIEW</text>
    <text x="768" y="740">SIGN VERSE • PREVIEW</text>
  </g>`;

function signGroup(input, x, y, w, h) {
  const name = esc(input.shopName || input.signText || "SIGN VERSE");
  const sub = esc(input.signText && input.shopName ? input.signText : "");
  const lit = input.lighting && input.lighting !== "none";
  const glow = lit ? (input.lighting === "warm" ? "#FFD9A0" : "#FFFFFF") : null;
  return `
    <g>
      ${glow ? `<rect x="${x - 12}" y="${y - 12}" width="${w + 24}" height="${h + 24}" rx="28" fill="${glow}" opacity="0.35"/>` : ""}
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="#123D88"/>
      <rect x="${x + 10}" y="${y + 10}" width="${w - 20}" height="${h - 20}" rx="14" fill="none" stroke="#35D7F5" stroke-width="4"/>
      <text x="${x + w / 2}" y="${y + h / 2 + (sub ? -6 : 22)}" fill="#FFFFFF" font-family="Arial, sans-serif" font-weight="700" font-size="${Math.min(72, w / Math.max(6, name.length) * 1.6)}" text-anchor="middle">${name}</text>
      ${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 52}" fill="#C9D8F2" font-family="Arial, sans-serif" font-size="34" text-anchor="middle">${sub}</text>` : ""}
    </g>`;
}

function svg(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024">${body}${WATERMARK}
  <text x="1500" y="1000" fill="#ffffff" opacity="0.6" font-family="Arial, sans-serif" font-size="22" text-anchor="end">MOCK — ไม่ได้สร้างด้วย AI จริง</text>
</svg>`;
}

function signBox(input) {
  const w = Number(input.widthCm) || 120;
  const h = Number(input.heightCm) || 60;
  const scale = Math.min(1000 / w, 560 / h);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

export function createMockProvider({ fail = {}, format = "png" } = {}) {
  const maybeFail = (step) => {
    if (fail[step] === "timeout") throw Object.assign(new Error("mock timeout"), { unknown: true });
    if (fail[step] === "error") throw new Error("mock failure");
  };
  const out = (text) => ({ bytes: new TextEncoder().encode(text), mime: "image/svg+xml", ext: "svg" });
  const png = async (kind) => ({ bytes: new Uint8Array(await readFile(FIXTURES[kind])), mime: "image/png", ext: "png" });
  return {
    name: "mock",
    calls: [],
    async generateArtwork(input) {
      this.calls.push("artwork");
      maybeFail("artwork");
      if (format === "png") return png("artwork");
      const { w, h } = signBox(input);
      // Artwork: หน้าตรง พื้นหลังเทาเรียบ ไม่มีตัวเลขขนาด (ใส่ด้วย Canvas ฝั่งหน้าเว็บ)
      return out(svg(`<rect width="1536" height="1024" fill="#8E9299"/>${signGroup(input, (1536 - w) / 2, (1024 - h) / 2, w, h)}`));
    },
    async generateMockup(input, artwork) {
      this.calls.push("mockup");
      maybeFail("mockup");
      if (!artwork || !artwork.bytes) throw new Error("artwork missing");
      if (format === "png") return png("mockup");
      const { w, h } = signBox(input);
      const sw = Math.round(w * 0.6), sh = Math.round(h * 0.6);
      return out(svg(`
        <rect width="1536" height="1024" fill="#2B3445"/>
        <rect x="0" y="760" width="1536" height="264" fill="#4A4F57"/>
        <rect x="268" y="300" width="1000" height="460" fill="#D9D4CC"/>
        <rect x="560" y="470" width="420" height="290" fill="#1F2937"/>
        <rect x="320" y="500" width="200" height="200" fill="#9DB7D5"/>
        <rect x="1020" y="500" width="200" height="200" fill="#9DB7D5"/>
        ${signGroup(input, (1536 - sw) / 2, 300 - sh - 20, sw, sh)}
        <text x="40" y="60" fill="#ffffff" font-family="Arial, sans-serif" font-size="28">ภาพจำลองหน้าร้าน</text>`));
    },
  };
}
