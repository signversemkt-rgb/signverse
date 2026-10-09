// OpenAI Image API (GPT Image 2) — สร้าง Artwork หน้าตรง และ Storefront Mockup
// ตรวจกับเอกสาร OpenAI (ต.ค. 2026):
//   - model ID: gpt-image-2 (snapshot gpt-image-2-2026-04-21) · endpoints: /v1/images/generations, /v1/images/edits
//   - ราคา: text input $5 · image input $8 · image output $30 ต่อ 1M tokens
//     ต่อภาพ 1536x1024: low $0.005 · medium $0.041 · high $0.165
//   - gpt-image-2 ประมวลผลภาพอ้างอิงที่ความละเอียดสูงเสมอ (ไม่ต้องส่ง input_fidelity)
// ค่าใช้จ่ายจริงคำนวณจาก usage ที่ API ส่งกลับ (ไม่มี usage → ใช้ราคาต่อภาพจากตาราง)
// API key อยู่ฝั่ง Server เท่านั้น · ห้ามเรียกในชุดทดสอบ (tests บล็อก fetch)
import { applyWatermark } from "./watermark.mjs";

const API = "https://api.openai.com/v1/images";
export const DEFAULT_RATES = { textIn: 5, imageIn: 8, imageOut: 30 };            // USD ต่อ 1M tokens (gpt-image-2)
const PER_IMAGE_1536 = { low: 0.005, medium: 0.041, high: 0.165 };               // USD ต่อภาพ (สำรองเมื่อไม่มี usage)
const LIGHT = { none: "no illumination", white: "lit with clean white LED light", warm: "lit with warm white LED light" };
const JOB = { standard: "printed flat sign board", diecut: "die-cut 3D letters", cutout: "cut-out pattern panel", acrylic_overlay: "PVC foam board with a clear acrylic overlay" };
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

export function costFromUsage(usage, rates = DEFAULT_RATES) {
  if (!usage || typeof usage.output_tokens !== "number") return null;
  const d = usage.input_tokens_details || {};
  const imageIn = d.image_tokens ?? 0;
  const textIn = d.text_tokens ?? Math.max(0, (usage.input_tokens || 0) - imageIn);
  return (textIn * rates.textIn + imageIn * rates.imageIn + usage.output_tokens * rates.imageOut) / 1e6;
}

// ข้อความสั่ง AI — ใช้ข้อมูลที่ตรวจแล้วจาก Server เท่านั้น · ไม่ให้ AI ใส่ตัวเลขขนาด (หน้าเว็บวาดเองจากข้อมูลจริง)
export function artworkPrompt(i, { withReferences = false } = {}) {
  const ratio = i.widthCm && i.heightCm ? `${i.widthCm}:${i.heightCm}` : "landscape";
  return [
    `Design a professional storefront sign for a Thai business. Show ONLY the sign, front-facing, flat, centered on a plain neutral gray background, aspect ratio about ${ratio}.`,
    i.shopName ? `The main text on the sign must read exactly: "${clip(i.shopName, 120)}".` : "",
    i.signText && i.signText !== i.shopName ? `Secondary text, exactly: "${clip(i.signText, 200)}".` : "",
    `Construction: ${JOB[i.jobType] || "sign board"}, material ${clip(i.material, 60) || "PVC foam board"}, ${i.layers === 2 ? "two layers" : "single layer"}, ${LIGHT[i.lighting] || LIGHT.none}.`,
    i.colors ? `Color scheme: ${clip(i.colors, 120)}.` : "",
    i.style ? `Style: ${clip(i.style, 120)}.` : "",
    i.details ? `Customer notes: ${clip(i.details, 400)}.` : "",
    withReferences ? "Use the attached reference images only as style inspiration; do not copy logos or text from them." : "",
    "Thai text must be spelled exactly as given, clear and legible. No dimension numbers, no watermark, no extra words, no people, no background scenery.",
  ].filter(Boolean).join(" ");
}

export function mockupPrompt(i, { withStorefront = false } = {}) {
  return withStorefront
    ? `The first image is the customer's real storefront; the last image is the approved sign design. Install this exact sign on the storefront facade above the entrance, realistic scale and perspective, matching the photo's lighting. Keep the sign design, text and colors unchanged. Do not alter other parts of the building. ${LIGHT[i.lighting] ? `The sign is ${LIGHT[i.lighting]}.` : ""}`
    : `Create a realistic photo mockup of this exact sign installed above the entrance of a typical Thai shophouse storefront, eye-level street view, daytime. Keep the sign design, text and colors exactly unchanged. ${LIGHT[i.lighting] ? `The sign is ${LIGHT[i.lighting]}.` : ""}`;
}

// loadImage(ref) → { bytes, mime } สำหรับไฟล์ private (storage key) หรือรูปผลงานสาธารณะของร้าน
export function createOpenAIProvider({
  apiKey, model = "gpt-image-2", quality = "medium", size = "1536x1024", rates = DEFAULT_RATES,
  loadImage, fetchImpl = globalThis.fetch, watermark = applyWatermark, timeoutMs = 170000,
}) {
  if (!apiKey) throw new Error("openai_key_missing");
  if (!["low", "medium", "high"].includes(quality)) quality = "medium";

  async function call(path, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(`${API}/${path}`, { ...init, signal: ctrl.signal, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) } });
    } catch (err) {
      // หมดเวลา/เครือข่ายหลุด = ไม่แน่ใจว่า OpenAI สร้างภาพแล้วหรือยัง → ไม่คืนสิทธิ์อัตโนมัติ (ให้ลองใหม่ได้)
      throw Object.assign(new Error("openai_network"), { unknown: true, cause: err && err.name });
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // ไม่ log ข้อความ prompt หรือ key — เก็บแค่รหัสสถานะ/ประเภท
      throw Object.assign(new Error(`openai_${r.status}`), { status: r.status, code: data?.error?.code || data?.error?.type || null, unknown: r.status >= 500 });
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error("openai_empty");
    const fallback = PER_IMAGE_1536[quality];
    return { bytes: Buffer.from(b64, "base64"), costUsd: costFromUsage(data.usage, rates) ?? fallback };
  }

  const generations = (prompt) => call("generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size, quality, n: 1, output_format: "png" }),
  });

  function edits(prompt, images) {
    const fd = new FormData();
    fd.append("model", model);
    fd.append("prompt", prompt);
    fd.append("size", size);
    fd.append("quality", quality);
    fd.append("n", "1");
    fd.append("output_format", "png");
    images.forEach((img, i) => fd.append("image[]", new Blob([img.bytes], { type: img.mime || "image/png" }), `input-${i}.${(img.mime || "image/png").split("/")[1]}`));
    return call("edits", { method: "POST", body: fd });
  }

  async function finish(raw) {
    const marked = await watermark(raw.bytes);
    return { ...marked, original: { bytes: new Uint8Array(raw.bytes), mime: "image/png", ext: "png" }, costUsd: raw.costUsd };
  }

  return {
    name: "openai",
    model,
    quality,
    async generateArtwork(input) {
      const refs = [];
      for (const r of [...(input.references || []), ...(input.referenceUploads || [])].slice(0, 3)) {
        const img = await loadImage(r).catch(() => null);
        if (img) refs.push(img);
      }
      const prompt = artworkPrompt(input, { withReferences: refs.length > 0 });
      return finish(refs.length ? await edits(prompt, refs) : await generations(prompt));
    },
    // artwork = ต้นฉบับไม่มีลายน้ำ (ใช้เป็นแบบ) · มีรูปหน้าร้าน = วางป้ายลงบนรูปจริงของลูกค้า
    async generateMockup(input, artwork) {
      if (!artwork || !artwork.bytes) throw new Error("artwork missing");
      const store = input.storefront ? await loadImage(input.storefront).catch(() => null) : null;
      const images = store ? [store, artwork] : [artwork];
      return finish(await edits(mockupPrompt(input, { withStorefront: Boolean(store) }), images));
    },
  };
}
