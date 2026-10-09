// ทดสอบระบบสิทธิ์ AI + สถานะงาน (Mock repo / storage / AI — ไม่เรียกบริการจริง)
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryRepo } from "../api/_lib/repo-memory.mjs";
import { createMemoryStorage } from "../api/_lib/storage.mjs";
import { createMockProvider } from "../api/_lib/ai-mock.mjs";
import { createJob, runStep, resolveJob, grantCredits, quotaView, MAX_ATTEMPTS } from "../api/_lib/jobs.mjs";

const uuid = () => randomUUID().replace(/-/g, "");
const key = () => uuid();
const INPUT = { shopName: "บ้านสวน", signText: "CAFE", widthCm: 120, heightCm: 60, lighting: "none" };

function setup(fail = {}) {
  const repo = createMemoryRepo({ uuid });
  const storage = createMemoryStorage({ uuid });
  const provider = createMockProvider({ fail });
  const userId = uuid();
  repo._db.users.set(userId, { id: userId, name: "u", email: "u@x", role: "customer", accountStatus: "active" });
  const create = (k = key(), extra = {}) => createJob({ repo, userId, idempotencyKey: k, input: INPUT, dailyLimit: 0, defaultCredits: 1, uuid, ...extra });
  const step = (jobId, s, uid = userId) => runStep({ repo, storage, provider, userId: uid, jobId, step: s });
  const quota = async () => quotaView(await repo.getQuota(userId, 1));
  return { repo, storage, provider, userId, create, step, quota };
}

test("สร้างครบ 2 ภาพ = ใช้ 1 สิทธิ์", async () => {
  const s = setup();
  const { job } = await s.create();
  assert.deepEqual(await s.quota(), { total: 1, used: 0, reserved: 1, remaining: 0 });
  let j = await s.step(job.job_id, "artwork");
  assert.equal(j.status, "partial");
  j = await s.step(job.job_id, "mockup");
  assert.equal(j.status, "completed");
  assert.deepEqual(await s.quota(), { total: 1, used: 1, reserved: 0, remaining: 0 });
  assert.deepEqual(s.provider.calls, ["artwork", "mockup"]);
  // ภาพถูกเก็บใน private store เท่านั้น
  assert.equal(s.storage._priv.size, 2);
  assert.equal(s.storage._pub.size, 0);
});

test("ใช้สิทธิ์ครบแล้วสร้างใหม่ไม่ได้", async () => {
  const s = setup();
  const { job } = await s.create();
  await s.step(job.job_id, "artwork");
  await s.step(job.job_id, "mockup");
  await assert.rejects(s.create(), { code: "quota_exhausted" });
});

test("ส่งคำขอเดิมซ้ำ (idempotency key เดิม) ไม่หักสิทธิ์ซ้ำ", async () => {
  const s = setup();
  const k = key();
  const a = await s.create(k);
  const b = await s.create(k);
  assert.equal(a.job.job_id, b.job.job_id);
  assert.equal(b.created, false);
  assert.equal((await s.quota()).reserved, 1);
});

test("กดสร้างพร้อมกันหลายคำขอ ใช้สิทธิ์ได้ไม่เกิน 1", async () => {
  const s = setup();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => s.create()));
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => ["job_in_progress", "quota_exhausted"].includes(r.reason.code)));
  assert.deepEqual(await s.quota(), { total: 1, used: 0, reserved: 1, remaining: 0 });
});

test("คำขอพร้อมกันด้วย key เดียวกัน ได้งานเดียว", async () => {
  const s = setup();
  const k = key();
  const results = await Promise.all(Array.from({ length: 5 }, () => s.create(k)));
  assert.equal(new Set(results.map((r) => r.job.job_id)).size, 1);
  assert.equal((await s.quota()).reserved, 1);
});

test("ล้มเหลวก่อนมีภาพสำเร็จ → คืนสิทธิ์ และสร้างใหม่ได้", async () => {
  const s = setup({ artwork: "error" });
  const { job } = await s.create();
  const j = await s.step(job.job_id, "artwork");
  assert.equal(j.status, "failed");
  assert.equal(j.credit_state, "refunded");
  assert.deepEqual(await s.quota(), { total: 1, used: 0, reserved: 0, remaining: 1 });
  await assert.rejects(s.step(job.job_id, "artwork"), { code: "job_closed" });
  const again = await s.create();
  assert.equal(again.created, true);
});

test("Artwork สำเร็จแต่ Mockup ล้มเหลว → partial, ทำต่อได้โดยไม่ใช้สิทธิ์ใหม่ และไม่สร้าง Artwork ซ้ำ", async () => {
  const s = setup({ mockup: "error" });
  const { job } = await s.create();
  await s.step(job.job_id, "artwork");
  let j = await s.step(job.job_id, "mockup");
  assert.equal(j.status, "partial");
  assert.equal(j.mockup_status, "failed");
  assert.deepEqual(await s.quota(), { total: 1, used: 1, reserved: 0, remaining: 0 });
  // แก้ provider ให้สำเร็จ แล้ว retry
  const ok = createMockProvider();
  j = await runStep({ repo: s.repo, storage: s.storage, provider: ok, userId: s.userId, jobId: job.job_id, step: "artwork" });
  assert.deepEqual(ok.calls, [], "artwork ที่สำเร็จแล้วต้องไม่ถูกสร้างซ้ำ");
  j = await runStep({ repo: s.repo, storage: s.storage, provider: ok, userId: s.userId, jobId: job.job_id, step: "mockup" });
  assert.equal(j.status, "completed");
  assert.deepEqual(ok.calls, ["mockup"]);
  assert.deepEqual(await s.quota(), { total: 1, used: 1, reserved: 0, remaining: 0 });
});

test("Timeout / ไม่แน่ใจผล → ไม่คืนสิทธิ์อัตโนมัติ, ลองใหม่ได้", async () => {
  const s = setup({ artwork: "timeout" });
  const { job } = await s.create();
  let j = await s.step(job.job_id, "artwork");
  assert.equal(j.artwork_status, "unknown");
  assert.equal(j.credit_state, "reserved");
  assert.equal((await s.quota()).reserved, 1);
  const ok = createMockProvider();
  j = await runStep({ repo: s.repo, storage: s.storage, provider: ok, userId: s.userId, jobId: job.job_id, step: "artwork" });
  assert.equal(j.artwork_status, "done");
  assert.equal(j.credit_state, "consumed");
});

test("เข้าถึงงานของคนอื่นไม่ได้ / Mockup ก่อน Artwork ไม่ได้", async () => {
  const s = setup();
  const { job } = await s.create();
  await assert.rejects(s.step(job.job_id, "artwork", uuid()), { code: "not_found" });
  await assert.rejects(s.step(job.job_id, "mockup"), { code: "step_not_ready" });
});

test("จำกัดจำนวนครั้งที่ลองใหม่", async () => {
  const s = setup({ artwork: "timeout" });
  const { job } = await s.create();
  for (let i = 0; i < MAX_ATTEMPTS; i++) await s.step(job.job_id, "artwork");
  await assert.rejects(s.step(job.job_id, "artwork"), { code: "retry_limit" });
});

test("พนักงานปิดงานค้างแบบคืนสิทธิ์ + เพิ่มสิทธิ์ (บันทึก Audit)", async () => {
  const s = setup({ artwork: "timeout" });
  const { job } = await s.create();
  await s.step(job.job_id, "artwork");
  await resolveJob({ repo: s.repo, actorId: "admin1", jobId: job.job_id, action: "refund" });
  assert.deepEqual(await s.quota(), { total: 1, used: 0, reserved: 0, remaining: 1 });
  const q = await grantCredits({ repo: s.repo, actorId: "admin1", userId: s.userId, amount: 2, note: "ลูกค้า VIP", defaultCredits: 1 });
  assert.equal(q.total, 3);
  const actions = s.repo._db.audit.map((a) => a.action);
  assert.ok(actions.includes("ai_job_refund") && actions.includes("ai_credits_granted"));
  await assert.rejects(grantCredits({ repo: s.repo, actorId: "a", userId: s.userId, amount: 999, defaultCredits: 1 }), { code: "bad_request" });
});

test("จำกัดงานรวมต่อวัน", async () => {
  const s2 = setup();
  const other = uuid();
  s2.repo._db.users.set(other, { id: other, role: "customer" });
  await s2.create(key(), { dailyLimit: 1 });
  await assert.rejects(createJob({ repo: s2.repo, userId: other, idempotencyKey: key(), input: INPUT, dailyLimit: 1, defaultCredits: 1, uuid }), { code: "daily_limit" });
});
