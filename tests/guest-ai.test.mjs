// ทดสอบสร้างภาพ AI ฟรีโดยไม่ต้องสมัครสมาชิก (GUEST_AI_ENABLED)
// ใช้ผู้สร้างภาพจำลองที่ทำตัวเป็น "AI จริง" — ไม่เรียก AI / เครือข่ายจริง
import test from "node:test";
import assert from "node:assert/strict";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.GUEST_AI_ENABLED;
delete process.env.VERCEL_ENV;
globalThis.fetch = async () => { throw new Error("NETWORK CALL BLOCKED IN TESTS"); };

const ORIGIN = "http://localhost:3000";
const ai = (await import("../api/ai.mjs")).default;
const me = (await import("../api/me.mjs")).default;
const upload = (await import("../api/upload.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const cron = (await import("../api/cron-cleanup.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const { guestConfig, guestAiState } = await import("../api/_lib/guest.mjs");
const { createMockProvider } = await import("../api/_lib/ai-mock.mjs");
const ctx = await getContext();
const mockAi = ctx.ai;
const fakeReal = { ...createMockProvider(), name: "test-real" };       // ทำตัวเป็น AI จริง (ไม่มีค่าใช้จ่าย)
const FORM = { shopName: "ร้านทดสอบ Guest", signText: "GUEST", widthCm: 150, heightCm: 50, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function call(handler, { method = "GET", url = "/", body, cookie, origin = ORIGIN, ip = "9.9.9.9", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": ip }, body };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(d) { this.body = d; },
  };
  await handler(req, res);
  let json = null; try { json = JSON.parse(Buffer.isBuffer(res.body) ? "" : String(res.body)); } catch {}
  return { status: res.statusCode, json, headers: res.headers, isFile: Buffer.isBuffer(res.body) };
}
const guestCookie = (r) => {
  const c = [].concat(r.headers["set-cookie"] || []).find((x) => x.startsWith("sv_guest="));
  return c ? c.split(";")[0] : null;
};
const idem = () => ctx.uuid();
const create = (cookie, ip, extra = {}) => call(ai, { method: "POST", url: "/api/ai", cookie, ip, body: { action: "create", idempotencyKey: idem(), input: FORM, ...extra } });
const step = (cookie, jobId, s, ip) => call(ai, { method: "POST", url: "/api/ai", cookie, ip, body: { action: "step", jobId, step: s } });
async function finish(cookie, jobId, ip) { await step(cookie, jobId, "artwork", ip); return step(cookie, jobId, "mockup", ip); }
const login = async (role) => (await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } })).headers["set-cookie"].split(";")[0];

let ipSeq = 0;
const freshIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
function mode({ enabled, provider = fakeReal, limits = {} }) {
  ctx.ai = provider;
  ctx.aiMockStaffOnly = provider === mockAi;          // เหมือนเว็บจริง: Mock = เฉพาะพนักงาน
  ctx.config.guest = { ...guestConfig({ GUEST_AI_ENABLED: enabled ? "true" : "" }, { mock: true }), ...limits };
}

test("ปิด GUEST_AI_ENABLED (ค่าเริ่มต้น): ระบบสมาชิกเดิม — ไม่ล็อกอินสร้างภาพ/อัปโหลดไม่ได้", async () => {
  mode({ enabled: false });
  const m = (await call(me)).json;
  assert.equal(m.aiStatus, "login_required");
  assert.equal(m.guest, null);
  assert.equal((await create(null, freshIp())).status, 401);
  assert.equal((await call(upload, { method: "POST", url: "/api/upload", body: { kind: "reference", data: PNG } })).status, 401);
});

test("เปิด flag แต่ยังไม่มี AI จริง: 'กำลังเตรียมเปิดบริการ' · ห้ามใช้ Mock AI กับลูกค้า", async () => {
  mode({ enabled: true, provider: mockAi });
  const m = (await call(me)).json;
  assert.equal(m.aiStatus, "coming_soon");
  assert.equal(m.guest.state, "coming_soon");
  const r = await create(null, freshIp());
  assert.equal(r.status, 401, "ไม่สร้างภาพจำลองให้ลูกค้า");
  assert.equal(guestCookie(r), null);
  mode({ enabled: true, provider: null });
  assert.equal((await call(me)).json.aiStatus, "coming_soon");
});

test("Guest สร้างภาพได้โดยไม่ล็อกอิน: cookie ลงลายเซ็น · Artwork + Mockup · ไม่ใช่ภาพจำลอง", async () => {
  mode({ enabled: true });
  const ip = freshIp();
  const m = (await call(me, { ip })).json;
  assert.equal(m.aiStatus, "guest_ready");
  assert.equal(m.guest.remainingToday, 2);
  const c = await create(null, ip);
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const setCookie = [].concat(c.headers["set-cookie"]).find((x) => x.startsWith("sv_guest="));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = guestCookie(c);
  const done = await finish(cookie, c.json.job.jobId, ip);
  assert.equal(done.json.job.status, "completed");
  assert.equal(done.json.job.preview, false);
  assert.equal(c.json.guest.remainingToday, 1);
  const file = await call(files, { url: `/api/files?job=${c.json.job.jobId}&kind=artwork`, cookie, ip });
  assert.equal(file.status, 200);
  assert.ok(file.isFile);
  const job = ctx.repo._db.jobs.get(c.json.job.jobId);
  assert.equal(job.user_id, null);
  assert.equal(job.credit_state, "guest");
  assert.ok(job.guest_ip_hash && !job.guest_ip_hash.includes(ip), "ไม่เก็บ IP จริง");
});

test("Guest เข้าถึงงาน/ไฟล์ของผู้อื่นไม่ได้ · cookie ปลอมใช้ไม่ได้", async () => {
  mode({ enabled: true });
  const ipA = freshIp(), ipB = freshIp();
  const a = await create(null, ipA);
  const cookieA = guestCookie(a);
  await finish(cookieA, a.json.job.jobId, ipA);
  const b = await create(null, ipB);
  const cookieB = guestCookie(b);
  const jobA = a.json.job.jobId;
  assert.equal((await call(files, { url: `/api/files?job=${jobA}&kind=artwork`, cookie: cookieB, ip: ipB })).status, 404);
  assert.equal((await call(files, { url: `/api/files?job=${jobA}&kind=artwork`, ip: ipB })).status, 401, "ไม่มี cookie");
  assert.equal((await call(ai, { url: `/api/ai?job=${jobA}`, cookie: cookieB, ip: ipB })).status, 404);
  assert.equal((await step(cookieB, jobA, "artwork", ipB)).status, 404);
  const forged = cookieA.replace(/\.[A-Za-z0-9_-]{32}$/, "." + "A".repeat(32));
  assert.equal((await call(files, { url: `/api/files?job=${jobA}&kind=artwork`, cookie: forged, ip: ipA })).status, 401, "ลายเซ็นไม่ถูก = ไม่ใช่ Guest คนเดิม");
  // สมาชิกคนอื่นก็ดูงาน Guest ไม่ได้ และ Guest ดูงานสมาชิกไม่ได้
  const member = await login("customer");
  assert.equal((await call(ai, { url: `/api/ai?job=${jobA}`, cookie: member })).status, 404);
  mode({ enabled: true });
  const mc = await call(ai, { method: "POST", url: "/api/ai", cookie: member, body: { action: "create", idempotencyKey: idem(), input: FORM } });
  assert.equal(mc.status, 201);
  assert.equal((await call(ai, { url: `/api/ai?job=${mc.json.job.jobId}`, cookie: cookieA, ip: ipA })).status, 404);
});

test("กันกดซ้ำ (Idempotency) และ 1 งานที่กำลังทำต่อ Guest", async () => {
  mode({ enabled: true });
  const ip = freshIp();
  const key = idem();
  const first = await call(ai, { method: "POST", url: "/api/ai", ip, body: { action: "create", idempotencyKey: key, input: FORM } });
  const cookie = guestCookie(first);
  const again = await call(ai, { method: "POST", url: "/api/ai", cookie, ip, body: { action: "create", idempotencyKey: key, input: FORM } });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);
  assert.equal(again.json.job.jobId, first.json.job.jobId);
  const busy = await create(cookie, ip);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, "job_in_progress");
});

test("เพดาน: ต่อ Guest / ต่อ IP (ล้าง cookie ก็ไม่รอด) / ทั้งระบบต่อวัน / งบรายวัน+รายเดือน → ปิดอัตโนมัติ", async () => {
  mode({ enabled: true, limits: { perGuestDay: 2, perIpDay: 3 } });
  const ip = freshIp();
  const c1 = await create(null, ip);
  const cookie = guestCookie(c1);
  await finish(cookie, c1.json.job.jobId, ip);
  const c2 = await create(cookie, ip);
  await finish(cookie, c2.json.job.jobId, ip);
  const c3 = await create(cookie, ip);
  assert.equal(c3.status, 429);
  assert.equal(c3.json.code, "guest_limit");
  assert.equal((await call(me, { cookie, ip })).json.aiStatus, "guest_limit");
  // ล้าง cookie (Guest ใหม่) แต่ IP เดิม → ได้อีกแค่ถึงเพดานต่อ IP
  const n1 = await create(null, ip);
  assert.equal(n1.status, 201);
  await finish(guestCookie(n1), n1.json.job.jobId, ip);
  const n2 = await create(null, ip);
  assert.equal(n2.status, 429, "เกินเพดานต่อ IP");

  const totalNow = await ctx.repo.countGuestJobsSince({ since: new Date(Date.now() - 86400000) });
  mode({ enabled: true, limits: { dailyTotal: totalNow } });
  const full = await create(null, freshIp());
  assert.equal(full.status, 429);
  assert.equal(full.json.code, "guest_daily_full");

  // งบ AI รายวัน / รายเดือน (ค่าใช้จ่ายจริง + ประมาณการ) ถึงวงเงิน → ปิด Guest อัตโนมัติ
  const o = { estimateThb: 8, usdThb: 36 };
  const spent = await ctx.repo.aiSpendThbSince(new Date(Date.now() - 86400000), o);
  assert.ok(spent > 0, "นับค่าใช้จ่ายงาน AI จริง");
  mode({ enabled: true });
  ctx.config.aiBudget = { dailyThb: Math.floor(spent), monthlyThb: 100000, ...o };
  const dayStop = await create(null, freshIp());
  assert.equal(dayStop.status, 503);
  assert.equal(dayStop.json.code, "guest_paused");
  ctx.config.aiBudget = { dailyThb: 100000, monthlyThb: Math.floor(spent), ...o };
  const monthStop = await create(null, freshIp());
  assert.equal(monthStop.status, 503);
  const m = (await call(me, { ip: freshIp() })).json;
  assert.equal(m.aiStatus, "guest_limit");
  assert.equal(m.guest.paused, true);
  ctx.config.aiBudget = { dailyThb: 200, monthlyThb: 1500, ...o };
});

test("อัปโหลด Reference / รูปหน้าร้านของ Guest: เก็บ 7 วัน · ใช้ไฟล์ของ Guest คนอื่นไม่ได้ · ตรวจชนิดไฟล์", async () => {
  mode({ enabled: true });
  const ipA = freshIp(), ipB = freshIp();
  const upA = await call(upload, { method: "POST", url: "/api/upload", ip: ipA, body: { kind: "storefront", data: PNG } });
  assert.equal(upA.status, 201);
  const cookieA = guestCookie(upA);
  const row = ctx.repo._db.uploads.get(upA.json.uploadId);
  assert.equal(row.user_id, null);
  const days = (new Date(row.expires_at) - new Date(row.created_at)) / 86400000;
  assert.equal(Math.round(days), 7);
  const upB = await call(upload, { method: "POST", url: "/api/upload", ip: ipB, body: { kind: "reference", data: PNG } });
  const cookieB = guestCookie(upB);
  const steal = await create(cookieB, ipB, { uploads: [upA.json.uploadId] });
  assert.equal(steal.status, 400);
  assert.equal(steal.json.code, "invalid_reference");
  const bad = await call(upload, { method: "POST", url: "/api/upload", cookie: cookieA, ip: ipA, body: { kind: "reference", data: "data:text/html;base64,PHNjcmlwdD4=" } });
  assert.equal(bad.status, 400);
  const ok = await create(cookieA, ipA, { storefront: upA.json.uploadId });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await call(files, { url: `/api/files?upload=${upA.json.uploadId}`, cookie: cookieB, ip: ipB })).status, 404);
});

test("Guest สั่งผลิตผ่านระบบออร์เดอร์ไม่ได้ (ติดต่อ LINE OA แทน) · โควตาสมาชิกไม่ถูกแตะ", async () => {
  mode({ enabled: true });
  const ip = freshIp();
  const c = await create(null, ip);
  const cookie = guestCookie(c);
  const order = await call(ai, { method: "POST", url: "/api/ai", cookie, ip, body: { action: "order", idempotencyKey: idem(), input: FORM } });
  assert.equal(order.status, 401);
  const member = await login("customer");
  const before = (await call(me, { cookie: member })).json.quota;
  assert.deepEqual(before, { total: 1, used: 0, reserved: 0, remaining: 1 });
  assert.equal((await call(me, { cookie: member })).json.aiStatus, "ready", "สมาชิกใช้ระบบโควตาเดิม");
});

test("ปิด flag อีกครั้ง → cookie Guest ใช้ไม่ได้ทันที และระบบสมาชิกกลับมาทำงาน", async () => {
  mode({ enabled: true });
  const ip = freshIp();
  const c = await create(null, ip);
  const cookie = guestCookie(c);
  mode({ enabled: false });
  assert.equal((await create(cookie, ip)).status, 401);
  assert.equal((await call(files, { url: `/api/files?job=${c.json.job.jobId}&kind=artwork`, cookie, ip })).status, 401);
  assert.equal((await call(me, { cookie, ip })).json.aiStatus, "login_required");
  const member = await login("customer");
  const mc = await call(ai, { method: "POST", url: "/api/ai", cookie: member, body: { action: "create", idempotencyKey: idem(), input: FORM } });
  assert.equal(mc.status, 201);
  assert.equal(ctx.repo._db.jobs.get(mc.json.job.jobId).credit_state, "reserved", "สมาชิกใช้เครดิตตามเดิม");
});

test("Cron ลบภาพของ Guest ที่เกินระยะเก็บรักษา", async () => {
  mode({ enabled: true });
  const ip = freshIp();
  const c = await create(null, ip);
  const cookie = guestCookie(c);
  await finish(cookie, c.json.job.jobId, ip);
  const j = ctx.repo._db.jobs.get(c.json.job.jobId);
  j.created_at = new Date(Date.now() - 8 * 86400000).toISOString();
  process.env.CRON_SECRET = "cron-test-secret";
  ctx.env.CRON_SECRET = "cron-test-secret";
  const r = await call(cron, { url: "/api/cron-cleanup", headers: { authorization: "Bearer cron-test-secret" }, origin: null });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(ctx.repo._db.jobs.get(c.json.job.jobId).artwork_storage_key, null);
});

test("Guest ไม่เปิดจนกว่าจะตั้ง Cloudflare Turnstile จริง (นอกโหมดทดสอบในเครื่อง)", async () => {
  mode({ enabled: true });
  const prev = { mock: ctx.mock, secret: ctx.config.turnstileSecret, site: ctx.config.turnstileSiteKey };
  try {
    ctx.mock = false;
    ctx.config.turnstileSecret = ""; ctx.config.turnstileSiteKey = "";
    assert.equal(guestAiState(ctx), "coming_soon");
    assert.equal((await create(null, freshIp())).status, 401, "ยังไม่มี Turnstile = สร้างภาพแบบ Guest ไม่ได้");
    ctx.config.turnstileSecret = "secret-set"; ctx.config.turnstileSiteKey = "";
    assert.equal(guestAiState(ctx), "coming_soon", "ต้องมีครบทั้ง Site Key และ Secret");
    ctx.config.turnstileSiteKey = "site-set";
    assert.equal(guestAiState(ctx), "ready");
  } finally {
    ctx.mock = prev.mock; ctx.config.turnstileSecret = prev.secret; ctx.config.turnstileSiteKey = prev.site;
  }
});
