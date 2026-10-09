// ระบบสิทธิ์ AI + สถานะงานสร้างภาพ
// 1 สิทธิ์ = 1 งาน (Artwork + Mockup) — ตรวจและเปลี่ยนสถานะภายใน transaction เท่านั้น
//
// การใช้สิทธิ์:
//   สร้างงาน            → จองสิทธิ์ (reserved + 1)
//   ภาพแรกสำเร็จ         → ใช้สิทธิ์จริง (used + 1, reserved - 1) — งาน partial ทำต่อได้โดยไม่ใช้สิทธิ์ใหม่
//   ล้มเหลวก่อนมีภาพสำเร็จ → คืนสิทธิ์ (reserved - 1) และปิดงาน
//   Timeout / ไม่แน่ใจผล  → ไม่คืนสิทธิ์อัตโนมัติ (step = unknown) ให้ลูกค้าลองใหม่ หรือพนักงานตรวจสอบ
import { HttpError } from "./http.mjs";

export const STEPS = ["artwork", "mockup"];
export const MAX_ATTEMPTS = 6;                 // รวมทุก step ต่องาน
export const STALE_MS = 10 * 60 * 1000;        // step ที่ค้าง processing นานกว่านี้ถือว่าไม่แน่ใจผล

export function quotaView(q) {
  const remaining = Math.max(0, q.free_credits_total - q.free_credits_used - q.reserved_credits);
  return { total: q.free_credits_total, used: q.free_credits_used, reserved: q.reserved_credits, remaining };
}

// ข้อมูลงานที่ส่งให้ Browser ได้ (ไม่มี storage key)
export function jobView(job) {
  const file = (step) => (job[`${step}_status`] === "done" ? `/api/files?job=${job.job_id}&kind=${step}` : null);
  return {
    jobId: job.job_id,
    status: job.status,
    artwork: { status: job.artwork_status, url: file("artwork") },
    mockup: { status: job.mockup_status, url: file("mockup") },
    errorCode: job.error_code || null,
    preview: job.input?.provider === "mock",            // true = ภาพตัวอย่างจาก Mock ไม่ใช่ผลจาก AI จริง
    createdAt: job.created_at,
    widthCm: job.input?.widthCm ?? null,
    heightCm: job.input?.heightCm ?? null,
  };
}

function startOfDay(now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// เจ้าของงาน: สมาชิก (user_id) หรือ Guest (guest_id) — ตรวจทุกครั้งที่อ่าน/สร้างภาพ
export const isJobOwner = (job, { userId, guestId } = {}) =>
  Boolean(job && ((userId && job.user_id === userId) || (guestId && job.guest_id === guestId)));

// งบ AI ทั้งระบบ: ใช้จ่ายจริง (cost_usd จาก OpenAI) + ประมาณการของงานที่ยังไม่เสร็จ — ถึงวงเงิน = ไม่รับงานใหม่
// budget = { dailyThb, monthlyThb, estimateThb, usdThb, dayStart, monthStart } · ไม่ส่ง budget (Mock/ทดสอบ) = ไม่ตรวจ
async function assertBudget(t, budget) {
  if (!budget) return;
  const o = { estimateThb: budget.estimateThb, usdThb: budget.usdThb };
  if ((await t.aiSpendThbSince(budget.dayStart, o)) + budget.estimateThb > budget.dailyThb) throw new HttpError(503, "ai_budget_day");
  if ((await t.aiSpendThbSince(budget.monthStart, o)) + budget.estimateThb > budget.monthlyThb) throw new HttpError(503, "ai_budget_month");
}

// งานของ Guest (ไม่ต้องสมัครสมาชิก): ไม่ใช้โควตาสมาชิก แต่ผ่านเพดานทั้งหมดภายใน transaction ที่ล็อกไว้
//   ต่อ Guest/วัน · ต่อ IP/วัน · ทั้งระบบ/วัน · งบ AI ต่อเดือน (ถึงวงเงิน = ปิดอัตโนมัติ) · 1 งานที่กำลังทำต่อ Guest
async function createGuestJob({ repo, guestId, ipHash, idempotencyKey, input, uuid, now, limits, dayStart, budget }) {
  return repo.tx(async (t) => {
    await t.lockAiBudget();                           // คำขอที่ใช้ AI จริงเข้าคิวทีละรายการ → นับเพดาน/งบได้แม่นยำ
    const existing = await t.findGuestJobByIdem(guestId, idempotencyKey);
    if (existing) return { job: existing, created: false };
    if (await t.countGuestActiveJobs(guestId)) throw new HttpError(409, "job_in_progress");
    try { await assertBudget(t, budget); } catch (err) { throw err instanceof HttpError ? new HttpError(503, "guest_paused") : err; }
    if ((await t.countGuestJobsSince({ since: dayStart })) >= limits.dailyTotal) throw new HttpError(429, "guest_daily_full");
    if ((await t.countGuestJobsSince({ since: dayStart, guestId })) >= limits.perGuestDay) throw new HttpError(429, "guest_limit");
    if ((await t.countGuestJobsSince({ since: dayStart, ipHash })) >= limits.perIpDay) throw new HttpError(429, "guest_limit");
    const job = {
      job_id: uuid(), user_id: null, guest_id: guestId, guest_ip_hash: ipHash, idempotency_key: idempotencyKey,
      status: "pending", artwork_status: "pending", mockup_status: "pending", artwork_storage_key: null, mockup_storage_key: null,
      credit_state: "guest", attempts: 0, input, error_code: null,
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    };
    await t.insertJob(job);
    await t.audit(null, "ai_guest_job_created", job.job_id, {});
    return { job, created: true };
  });
}

// จองสิทธิ์และสร้างงาน (Idempotent ด้วย idempotencyKey)
export async function createJob({ repo, userId, guestId, ipHash, guestLimits, dayStart, budget, idempotencyKey, input, dailyLimit, defaultCredits, uuid, now = Date.now(), exempt = false }) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey || "")) throw new HttpError(400, "bad_request");
  if (!userId && guestId) return createGuestJob({ repo, guestId, ipHash, idempotencyKey, input, uuid, now, limits: guestLimits, dayStart, budget });
  return repo.tx(async (t) => {
    if (budget) await t.lockAiBudget();
    // ล็อกแถวโควตาของผู้ใช้ก่อน → คำขอพร้อมกันของคนเดียวกันต่อคิวกัน (กันใช้สิทธิ์เกิน/หักซ้ำ)
    const q = await t.getQuotaForUpdate(userId, defaultCredits);

    const existing = await t.findJobByIdem(userId, idempotencyKey);
    if (existing) return { job: existing, created: false };

    if (await t.countActiveJobs(userId)) throw new HttpError(409, "job_in_progress");
    await assertBudget(t, budget);                    // งบ AI รวมทั้งระบบ (รวมงานทดสอบของพนักงานด้วย)
    if (!exempt) {                                    // งานทดสอบของพนักงาน (Mock) ไม่ใช้เครดิตและไม่นับโควตารายวัน
      if (q.free_credits_used + q.reserved_credits >= q.free_credits_total) throw new HttpError(403, "quota_exhausted");
      if (dailyLimit > 0 && (await t.countJobsSince(startOfDay(now))) >= dailyLimit) throw new HttpError(429, "daily_limit");
      await t.updateQuota(userId, { reserved_credits: q.reserved_credits + 1 });
    }

    const job = {
      job_id: uuid(),
      user_id: userId,
      idempotency_key: idempotencyKey,
      status: "pending",
      artwork_status: "pending",
      mockup_status: "pending",
      artwork_storage_key: null,
      mockup_storage_key: null,
      credit_state: exempt ? "exempt" : "reserved",
      attempts: 0,
      input,
      error_code: null,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
    await t.insertJob(job);
    await t.audit(userId, "ai_job_created", job.job_id, { exempt });
    return { job, created: true };
  });
}

function isStale(job, now) {
  return now - new Date(job.updated_at).getTime() > STALE_MS;
}

// สร้างภาพทีละขั้น (artwork → mockup) — เรียกซ้ำได้ ภาพที่สำเร็จแล้วจะไม่ถูกสร้างใหม่
export async function runStep({ repo, storage, provider, userId, guestId, jobId, step, now = () => Date.now() }) {
  if (!STEPS.includes(step)) throw new HttpError(400, "bad_request");
  const statusKey = `${step}_status`;

  // 1) ล็อกงานและเปลี่ยนเป็น processing
  const started = await repo.tx(async (t) => {
    const job = await t.getJobForUpdate(jobId);
    if (!isJobOwner(job, { userId, guestId })) throw new HttpError(404, "not_found");
    if (job[statusKey] === "done") return { job, skip: true };
    if (job.status === "failed" && job.credit_state === "refunded") throw new HttpError(409, "job_closed");
    if (job[statusKey] === "processing" && !isStale(job, now())) throw new HttpError(409, "step_busy");
    if (step === "mockup" && job.artwork_status !== "done") throw new HttpError(409, "step_not_ready");
    if (job.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "retry_limit");
    const patch = { [statusKey]: "processing", status: "processing", attempts: job.attempts + 1, error_code: null, updated_at: new Date(now()).toISOString() };
    await t.updateJob(jobId, patch);
    return { job: { ...job, ...patch }, skip: false };
  });
  if (started.skip) return started.job;
  const job = started.job;

  // 2) เรียกผู้สร้างภาพ (นอก transaction)
  let result;
  try {
    result = step === "artwork"
      ? await provider.generateArtwork(job.input)
      : await provider.generateMockup(job.input, await storage.getPrivate(job.artwork_original_key || job.artwork_storage_key));
  } catch (err) {
    return finishFailure({ repo, jobId, step, unknown: Boolean(err && err.unknown), now });
  }

  // 3) เก็บไฟล์ใน Private Blob แล้วบันทึกผล + ใช้สิทธิ์ (ครั้งเดียวต่องาน)
  const base = `ai/${userId || `guest-${guestId}`}/${jobId}/${step}`;
  const key = await storage.putPrivate(`${base}.${result.ext}`, result.bytes, result.mime);
  // ต้นฉบับไม่มีลายน้ำ (AI จริง) → Private Blob เท่านั้น ไม่ส่งให้ลูกค้า (ใช้สร้าง Mockup / พนักงาน)
  const originalKey = result.original ? await storage.putPrivate(`${base}-original.${result.original.ext}`, result.original.bytes, result.original.mime) : null;
  return repo.tx(async (t) => {
    const cur = await t.getJobForUpdate(jobId);
    const patch = { [statusKey]: "done", [`${step}_storage_key`]: key, error_code: null, updated_at: new Date(now()).toISOString() };
    if (originalKey) patch[`${step}_original_key`] = originalKey;
    if (typeof result.costUsd === "number") patch.cost_usd = Number(cur.cost_usd || 0) + result.costUsd;
    if (cur.credit_state === "reserved") {
      const q = await t.getQuotaForUpdate(cur.user_id, 0);
      await t.updateQuota(cur.user_id, { free_credits_used: q.free_credits_used + 1, reserved_credits: Math.max(0, q.reserved_credits - 1) });
      patch.credit_state = "consumed";
    }
    const next = { ...cur, ...patch };
    patch.status = next.artwork_status === "done" && next.mockup_status === "done" ? "completed" : "partial";
    await t.updateJob(jobId, patch);
    await t.audit(cur.user_id, `ai_${step}_done`, jobId, {});
    return { ...cur, ...patch };
  });
}

async function finishFailure({ repo, jobId, step, unknown, now }) {
  const statusKey = `${step}_status`;
  return repo.tx(async (t) => {
    const cur = await t.getJobForUpdate(jobId);
    const patch = { [statusKey]: unknown ? "unknown" : "failed", error_code: unknown ? "timeout_unknown" : "ai_failed", updated_at: new Date(now()).toISOString() };
    const anyDone = cur.artwork_status === "done" || cur.mockup_status === "done";
    if (anyDone) {
      patch.status = "partial";                       // ทำภาพที่เหลือต่อได้โดยไม่ใช้สิทธิ์ใหม่
    } else if (unknown) {
      patch.status = "processing";                    // ไม่แน่ใจผล → ไม่คืนสิทธิ์อัตโนมัติ
    } else if (cur.credit_state === "reserved") {
      const q = await t.getQuotaForUpdate(cur.user_id, 0);
      await t.updateQuota(cur.user_id, { reserved_credits: Math.max(0, q.reserved_credits - 1) });
      patch.credit_state = "refunded";
      patch.status = "failed";
    } else {
      patch.status = "failed";
    }
    await t.updateJob(jobId, patch);
    await t.audit(cur.user_id, `ai_${step}_${patch[statusKey]}`, jobId, { refunded: patch.credit_state === "refunded" });
    return { ...cur, ...patch };
  });
}

// พนักงานปิดงานที่ค้าง/ไม่แน่ใจผล: refund = คืนสิทธิ์, close = ปิดงานโดยถือว่าใช้สิทธิ์แล้ว
export async function resolveJob({ repo, actorId, jobId, action, now = Date.now() }) {
  if (!["refund", "close"].includes(action)) throw new HttpError(400, "bad_request");
  return repo.tx(async (t) => {
    const cur = await t.getJobForUpdate(jobId);
    if (!cur) throw new HttpError(404, "not_found");
    if (cur.status === "completed" || cur.credit_state !== "reserved") throw new HttpError(409, "job_closed");
    const q = await t.getQuotaForUpdate(cur.user_id, 0);
    const patch = { status: "failed", error_code: "resolved_by_staff", updated_at: new Date(now).toISOString() };
    if (action === "refund") {
      await t.updateQuota(cur.user_id, { reserved_credits: Math.max(0, q.reserved_credits - 1) });
      patch.credit_state = "refunded";
    } else {
      await t.updateQuota(cur.user_id, { free_credits_used: q.free_credits_used + 1, reserved_credits: Math.max(0, q.reserved_credits - 1) });
      patch.credit_state = "consumed";
    }
    await t.updateJob(jobId, patch);
    await t.audit(actorId, `ai_job_${action}`, jobId, { userId: cur.user_id });
    return { ...cur, ...patch };
  });
}

// พนักงาน (admin) เพิ่มสิทธิ์ให้ลูกค้า
export async function grantCredits({ repo, actorId, userId, amount, note, defaultCredits }) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new HttpError(400, "bad_request");
  return repo.tx(async (t) => {
    if (!(await t.userExists(userId))) throw new HttpError(404, "not_found");
    const q = await t.getQuotaForUpdate(userId, defaultCredits);
    await t.updateQuota(userId, { free_credits_total: q.free_credits_total + n });
    await t.audit(actorId, "ai_credits_granted", userId, { amount: n, note: String(note || "").slice(0, 200) });
    return quotaView({ ...q, free_credits_total: q.free_credits_total + n });
  });
}
