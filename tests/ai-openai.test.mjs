// ทดสอบผู้สร้างภาพ OpenAI (GPT Image 2) + การเก็บต้นฉบับ + งบ AI — ไม่เรียก OpenAI จริง (fetch จำลอง)
import test from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const { createOpenAIProvider, costFromUsage, artworkPrompt, mockupPrompt } = await import("../api/_lib/ai-openai.mjs");
const { runStep, createJob } = await import("../api/_lib/jobs.mjs");
const { createMemoryRepo } = await import("../api/_lib/repo-memory.mjs");
const { createMemoryStorage } = await import("../api/_lib/storage.mjs");
const { getContext, loadReferenceImage, canUseAi, aiStatus, isCreditExempt } = await import("../api/_lib/context.mjs");
const { guestAiState } = await import("../api/_lib/guest.mjs");

const KEY = "sk-test-key-never-sent";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const INPUT = { shopName: "ร้านกาแฟบ้านสวน", signText: "Baan Suan Café", widthCm: 180, heightCm: 60, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "warm", colors: "เขียว ครีม", style: "มินิมอล" };
let seq = 0;
const uuid = () => `id${String(++seq).padStart(8, "0")}`;

// fetch จำลอง: บันทึกคำขอและตอบแบบ OpenAI
function fakeOpenAI({ status = 200, usage = { input_tokens: 120, input_tokens_details: { text_tokens: 120, image_tokens: 0 }, output_tokens: 1372 }, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throwErr) throw throwErr;
    const body = status === 200 ? { data: [{ b64_json: PNG.toString("base64") }], usage } : { error: { code: "moderation_blocked", message: "secret prompt text" } };
    return { ok: status === 200, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
const stubWatermark = async (bytes) => ({ bytes: new Uint8Array([...bytes, 0x57]), mime: "image/png", ext: "png" });   // ภาพ "มีลายน้ำ" ต่างจากต้นฉบับ

test("Artwork (ไม่มีรูปอ้างอิง) → /v1/images/generations · gpt-image-2 · 1536x1024 · medium · PNG", async () => {
  const f = fakeOpenAI();
  const p = createOpenAIProvider({ apiKey: KEY, fetchImpl: f, watermark: stubWatermark, loadImage: async () => null });
  const r = await p.generateArtwork(INPUT);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(f.calls[0].init.body);
  assert.deepEqual({ model: body.model, size: body.size, quality: body.quality, n: body.n, output_format: body.output_format }, { model: "gpt-image-2", size: "1536x1024", quality: "medium", n: 1, output_format: "png" });
  assert.ok(body.prompt.includes("ร้านกาแฟบ้านสวน") && body.prompt.includes("No dimension numbers"));
  assert.ok(!body.prompt.includes(KEY));
  assert.equal(r.bytes.at(-1), 0x57, "ภาพที่คืนให้ระบบเป็นภาพมีลายน้ำ");
  assert.deepEqual([...r.original.bytes], [...PNG], "ต้นฉบับแยกเก็บ");
  assert.ok(Math.abs(r.costUsd - (120 * 5 + 1372 * 30) / 1e6) < 1e-9);
});

test("Artwork มีรูปอ้างอิง + Mockup มีรูปหน้าร้าน → /v1/images/edits แบบ multipart (image[])", async () => {
  const f = fakeOpenAI();
  const loads = [];
  const loadImage = async (ref) => { loads.push(ref); return { bytes: PNG, mime: "image/png" }; };
  const p = createOpenAIProvider({ apiKey: KEY, fetchImpl: f, watermark: stubWatermark, loadImage });
  const input = { ...INPUT, references: [{ imageId: "g1", url: "https://abc.public.blob.vercel-storage.com/x.png" }], referenceUploads: [{ uploadId: "u1", key: "k1" }], storefront: { uploadId: "s1", key: "k2" } };
  await p.generateArtwork(input);
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/images/edits");
  const fd = f.calls[0].init.body;
  assert.equal(fd.getAll("image[]").length, 2);
  assert.equal(fd.get("model"), "gpt-image-2");
  assert.equal(fd.get("input_fidelity"), null, "gpt-image-2 ไม่ต้องส่ง input_fidelity");
  await p.generateMockup(input, { bytes: PNG, mime: "image/png" });
  const fd2 = f.calls[1].init.body;
  assert.equal(f.calls[1].url, "https://api.openai.com/v1/images/edits");
  assert.equal(fd2.getAll("image[]").length, 2, "รูปหน้าร้าน + Artwork");
  assert.match(fd2.get("prompt"), /customer's real storefront/);
  assert.deepEqual(loads.map((l) => l.key || l.url), ["https://abc.public.blob.vercel-storage.com/x.png", "k1", "k2"]);
});

test("ข้อผิดพลาด: ถูกปฏิเสธ (400) = ล้มเหลวปกติ · 5xx/หมดเวลา = ไม่แน่ใจผล · ไม่มีข้อความ prompt ใน error", async () => {
  const p400 = createOpenAIProvider({ apiKey: KEY, fetchImpl: fakeOpenAI({ status: 400 }), watermark: stubWatermark, loadImage: async () => null });
  await assert.rejects(p400.generateArtwork(INPUT), (e) => e.status === 400 && e.unknown === false && e.code === "moderation_blocked" && !e.message.includes("secret"));
  const p500 = createOpenAIProvider({ apiKey: KEY, fetchImpl: fakeOpenAI({ status: 502 }), watermark: stubWatermark, loadImage: async () => null });
  await assert.rejects(p500.generateArtwork(INPUT), (e) => e.unknown === true);
  const pNet = createOpenAIProvider({ apiKey: KEY, fetchImpl: fakeOpenAI({ throwErr: new Error("socket") }), watermark: stubWatermark, loadImage: async () => null });
  await assert.rejects(pNet.generateArtwork(INPUT), (e) => e.unknown === true && e.message === "openai_network");
  assert.throws(() => createOpenAIProvider({ apiKey: "" }), /openai_key_missing/);
});

test("ค่าใช้จ่าย: คำนวณจาก usage จริง · ไม่มี usage ใช้ราคาต่อภาพทางการ", async () => {
  assert.ok(Math.abs(costFromUsage({ input_tokens: 2100, input_tokens_details: { text_tokens: 100, image_tokens: 2000 }, output_tokens: 1372 }) - (100 * 5 + 2000 * 8 + 1372 * 30) / 1e6) < 1e-9);
  assert.equal(costFromUsage(null), null);
  const p = createOpenAIProvider({ apiKey: KEY, fetchImpl: fakeOpenAI({ usage: null }), watermark: stubWatermark, loadImage: async () => null });
  assert.equal((await p.generateArtwork(INPUT)).costUsd, 0.041);
  const ph = createOpenAIProvider({ apiKey: KEY, quality: "high", fetchImpl: fakeOpenAI({ usage: null }), watermark: stubWatermark, loadImage: async () => null });
  assert.equal((await ph.generateArtwork(INPUT)).costUsd, 0.165);
});

test("ข้อความสั่ง AI: ใช้ข้อความตามที่ลูกค้ากรอก · ไม่มีตัวเลขขนาด · Mockup ไม่มีรูปหน้าร้านใช้ตึกแถวทั่วไป", () => {
  const a = artworkPrompt(INPUT);
  assert.match(a, /must read exactly: "ร้านกาแฟบ้านสวน"/);
  assert.match(a, /Baan Suan Café/);
  assert.match(a, /warm white LED/);
  assert.match(mockupPrompt(INPUT), /typical Thai shophouse/);
});

test("runStep กับ AI จริง: ลูกค้าได้เฉพาะภาพมีลายน้ำ · ต้นฉบับเก็บแยก · Mockup ใช้ต้นฉบับ · บันทึกค่าใช้จ่ายจริง", async () => {
  const repo = createMemoryRepo({ uuid });
  const storage = createMemoryStorage({ uuid });
  repo._db.users.set("u1", { id: "u1", name: "x", email: "x@x", role: "customer", accountStatus: "active" });
  const mockupInputs = [];
  const provider = {
    name: "openai",
    async generateArtwork() { return { bytes: new Uint8Array([1, 1]), mime: "image/png", ext: "png", original: { bytes: new Uint8Array([9, 9]), mime: "image/png", ext: "png" }, costUsd: 0.05 }; },
    async generateMockup(input, art) { mockupInputs.push([...art.bytes]); return { bytes: new Uint8Array([2, 2]), mime: "image/png", ext: "png", original: { bytes: new Uint8Array([8, 8]), mime: "image/png", ext: "png" }, costUsd: 0.07 }; },
  };
  const { job } = await createJob({ repo, userId: "u1", idempotencyKey: "k".repeat(20), input: { ...INPUT, provider: "openai" }, dailyLimit: 0, defaultCredits: 1, uuid });
  await runStep({ repo, storage, provider, userId: "u1", jobId: job.job_id, step: "artwork" });
  const done = await runStep({ repo, storage, provider, userId: "u1", jobId: job.job_id, step: "mockup" });
  assert.equal(done.status, "completed");
  assert.deepEqual(mockupInputs[0], [9, 9], "Mockup สร้างจากต้นฉบับ (ไม่มีลายน้ำซ้อน)");
  const row = repo._db.jobs.get(job.job_id);
  assert.deepEqual([...(await storage.getPrivate(row.artwork_storage_key)).bytes], [1, 1], "ไฟล์ที่ /api/files ส่งให้ลูกค้า = มีลายน้ำ");
  assert.deepEqual([...(await storage.getPrivate(row.artwork_original_key)).bytes], [9, 9]);
  assert.ok(row.mockup_original_key);
  assert.ok(Math.abs(row.cost_usd - 0.12) < 1e-9);
  assert.equal(await repo.findJobFile(job.job_id, "artwork").then((f) => f.key), row.artwork_storage_key, "ลิงก์ไฟล์ชี้ภาพมีลายน้ำเท่านั้น");
});

test("งบ AI รวมทั้งระบบใช้กับสมาชิกด้วย: ถึงงบรายวัน/รายเดือน → ไม่รับงานใหม่ และไม่จองเครดิต", async () => {
  const repo = createMemoryRepo({ uuid });
  for (const id of ["a", "b"]) repo._db.users.set(id, { id, name: id, email: `${id}@x`, role: "customer", accountStatus: "active" });
  const now = Date.now();
  const budget = { dailyThb: 20, monthlyThb: 1500, estimateThb: 8, usdThb: 36, dayStart: new Date(now - 3600e3), monthStart: new Date(now - 86400e3 * 10) };
  const mk = (userId) => createJob({ repo, userId, idempotencyKey: uuid().padEnd(20, "x"), input: { ...INPUT, provider: "openai" }, dailyLimit: 0, defaultCredits: 1, uuid, budget });
  const first = await mk("a");
  repo._db.jobs.get(first.job.job_id).cost_usd = 0.4;                      // ใช้จริง 14.4 บาท
  await assert.rejects(mk("b"), (e) => e.code === "ai_budget_day");
  assert.equal((await repo.getQuota("b", 1)).reserved_credits, 0, "ไม่จองเครดิตเมื่อถูกปฏิเสธ");
  await assert.rejects(createJob({ repo, userId: "b", idempotencyKey: uuid().padEnd(20, "y"), input: { ...INPUT, provider: "openai" }, dailyLimit: 0, defaultCredits: 1, uuid, budget: { ...budget, dailyThb: 1000, monthlyThb: 20 } }), (e) => e.code === "ai_budget_month");
  // งาน Mock ไม่นับในงบ
  const mockJob = await createJob({ repo, userId: "b", idempotencyKey: uuid().padEnd(20, "z"), input: { ...INPUT, provider: "mock" }, dailyLimit: 0, defaultCredits: 1, uuid });
  assert.ok(mockJob.created);
  assert.equal(await repo.aiSpendThbSince(budget.monthStart, budget), 0.4 * 36);
});

test("AI_PROVIDER=openai: ค่าเริ่มต้นเฉพาะพนักงาน (AI_ACCESS=staff) · ลูกค้า/Guest ยังใช้ไม่ได้จนกว่าจะเปิด members", async () => {
  const { getContext: fresh } = await import("../api/_lib/context.mjs?openai=" + Date.now());
  const env = { AI_PROVIDER: "openai", OPENAI_API_KEY: KEY, BETTER_AUTH_URL: "https://signverse-azure.vercel.app", GUEST_AI_ENABLED: "true", BETTER_AUTH_SECRET: "x".repeat(40) };
  const c = await fresh(env);
  assert.equal(c.ai.name, "openai");
  assert.equal(c.ai.model, "gpt-image-2");
  assert.equal(c.ai.quality, "medium");
  assert.equal(c.aiStaffOnly, true);
  c.repo = {}; c.storage = {};
  assert.equal(canUseAi(c, { role: "customer" }), false);
  assert.equal(canUseAi(c, { role: "staff" }), true);
  assert.equal(isCreditExempt(c, { role: "staff" }), true, "พนักงานทดสอบไม่ใช้เครดิตลูกค้า");
  assert.equal(aiStatus(c, { role: "customer" }), "coming_soon");
  assert.equal(guestAiState(c), "coming_soon", "Guest ยังปิดช่วงพนักงานทดสอบ");
  const open = await (await import("../api/_lib/context.mjs?openai2=" + Date.now())).getContext({ ...env, AI_ACCESS: "members", OPENAI_IMAGE_MODEL: "gpt-image-2", AI_IMAGE_QUALITY: "high" });
  open.repo = {}; open.storage = {};
  assert.equal(open.aiStaffOnly, false);
  assert.equal(open.ai.quality, "high");
  assert.equal(canUseAi(open, { role: "customer" }), true);
  assert.equal(guestAiState(open), "coming_soon", "ยังไม่ตั้ง Turnstile = Guest ยังไม่เปิด");
  const withTs = await (await import("../api/_lib/context.mjs?openai4=" + Date.now())).getContext({ ...env, AI_ACCESS: "members", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" });
  withTs.repo = {}; withTs.storage = {};
  assert.equal(guestAiState(withTs), "ready");
  const noKey = await (await import("../api/_lib/context.mjs?openai3=" + Date.now())).getContext({ AI_PROVIDER: "openai" });
  assert.equal(noKey.ai, null, "ไม่มี API key = ไม่เปิด");
});

test("รูปอ้างอิงที่ส่งให้ AI: เฉพาะไฟล์ private ของเจ้าของ หรือ Public Blob ของร้าน (กัน SSRF)", async () => {
  const ctx = await getContext();
  for (const url of ["http://abc.public.blob.vercel-storage.com/x.png", "https://evil.example.com/x.png", "https://169.254.169.254/latest", "https://abc.private.blob.vercel-storage.com/x.png"]) {
    await assert.rejects(loadReferenceImage(ctx, { url }), /reference_host_not_allowed/, url);
  }
  await assert.rejects(loadReferenceImage(ctx, {}), /no_reference/);
});

test("งบ: งานที่ยังไม่จบนับอย่างน้อยค่าประมาณ · ครั้งที่หมดเวลา (ไม่รู้ค่าจริง) ถูกนับ · งานเสร็จใช้ค่าจริง", async () => {
  const repo = createMemoryRepo({ uuid });
  const o = { estimateThb: 8, usdThb: 36 };
  const since = new Date(Date.now() - 3600e3);
  const base = { user_id: "u", input: { provider: "openai" }, created_at: new Date().toISOString(), credit_state: "reserved" };
  const put = (id, j) => repo._db.jobs.set(id, { job_id: id, ...base, ...j });
  put("partial", { status: "partial", artwork_status: "done", mockup_status: "pending", attempts: 1, cost_usd: 0.05 });       // Artwork เสร็จ Mockup ยังไม่ทำ
  assert.equal(await repo.aiSpendThbSince(since, o), 8, "ยังไม่จบ → อย่างน้อยค่าประมาณทั้งงาน (ไม่ใช่แค่ค่า Artwork 1.8 บาท)");
  repo._db.jobs.clear();
  put("timeout", { status: "processing", artwork_status: "unknown", mockup_status: "pending", attempts: 3, cost_usd: null });  // หมดเวลา 3 ครั้ง
  assert.equal(await repo.aiSpendThbSince(since, o), 12, "หมดเวลา 3 ครั้ง × 4 บาท");
  repo._db.jobs.clear();
  put("done", { status: "completed", artwork_status: "done", mockup_status: "done", attempts: 2, cost_usd: 0.12 });
  assert.ok(Math.abs((await repo.aiSpendThbSince(since, o)) - 0.12 * 36) < 1e-9, "งานเสร็จ = ค่าจริง");
  put("retry", { status: "completed", artwork_status: "done", mockup_status: "done", attempts: 3, cost_usd: 0.12 });            // มี 1 ครั้งที่หมดเวลาก่อนสำเร็จ
  assert.ok(Math.abs((await repo.aiSpendThbSince(since, o)) - (0.12 * 36 * 2 + 4)) < 1e-9);
});

test("คำขอพร้อมกัน: สั่งสร้างภาพขั้นเดียวกันซ้ำระหว่างกำลังทำ → ปฏิเสธ (ไม่เรียก AI ซ้ำ = ไม่เสียเงินซ้ำ)", async () => {
  const repo = createMemoryRepo({ uuid });
  const storage = createMemoryStorage({ uuid });
  repo._db.users.set("u2", { id: "u2", name: "x", email: "y@x", role: "customer", accountStatus: "active" });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const provider = { name: "openai", async generateArtwork() { calls++; await gate; return { bytes: new Uint8Array([1]), mime: "image/png", ext: "png", costUsd: 0.04 }; } };
  const { job } = await createJob({ repo, userId: "u2", idempotencyKey: "c".repeat(20), input: { ...INPUT, provider: "openai" }, dailyLimit: 0, defaultCredits: 1, uuid });
  const first = runStep({ repo, storage, provider, userId: "u2", jobId: job.job_id, step: "artwork" });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(runStep({ repo, storage, provider, userId: "u2", jobId: job.job_id, step: "artwork" }), (e) => e.code === "step_busy");
  release();
  await first;
  assert.equal(calls, 1);
});
