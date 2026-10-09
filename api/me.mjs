// GET /api/me → สถานะล็อกอิน + สิทธิ์ AI คงเหลือ + provider ที่เปิดใช้จริง
// (Mock เท่านั้น) POST /api/me?mock=login|logout ใช้ทดสอบในเครื่อง — ระบบปฏิเสธบน Production
import { route } from "./_lib/route.mjs";
import { sendJson, query, readJson, HttpError, assertSameOrigin } from "./_lib/http.mjs";
import { quotaView } from "./_lib/jobs.mjs";
import { canUseAi, canUseLineOrders, aiStatus, aiReadyForCustomers } from "./_lib/context.mjs";
import { getIp, isMissingSchema } from "./_lib/http.mjs";
import { guestAiState, guestUsage, readGuestId } from "./_lib/guest.mjs";
import { aiTestReady, readTestSession, testUsage } from "./_lib/aitest.mjs";

export default route(async (req, res, ctx) => {
  if (req.method === "POST" && ctx.mock) {
    const q = query(req);
    if (q.mock === "logout") {
      res.setHeader("Set-Cookie", "sv_mock_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const role = ["customer", "staff", "admin"].includes(body.role) ? body.role : "customer";
    const id = ctx.uuid();
    ctx.repo._db.users.set(id, { id, name: `ทดสอบ (${role})`, email: `${id.slice(0, 6)}@mock.local`, role, accountStatus: "active", createdAt: new Date().toISOString() });
    ctx.repo._db.identities.push({ userId: id, providerId: body.provider || "google", accountId: id });
    res.setHeader("Set-Cookie", `sv_mock_user=${id}; Path=/; HttpOnly; SameSite=Lax`);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "GET") throw new HttpError(405, "bad_request");

  const user = await ctx.getSession(req);
  let quota = null;
  if (user && ctx.repo) quota = quotaView(await ctx.repo.getQuota(user.id, ctx.config.defaultCredits));
  // Guest: สถานะ + สิทธิ์คงเหลือวันนี้ (ไม่ออก cookie ที่นี่ — ออกตอนสร้างงานจริง)
  let guest = null;
  const gState = user ? "off" : guestAiState(ctx);
  if (gState === "ready") guest = { state: gState, ...(await guestUsage(ctx, readGuestId(ctx, req), getIp(req))) };
  else if (gState === "coming_soon") guest = { state: gState, remainingToday: 0, paused: false };
  // โหมดทดสอบ AI ของเจ้าของเว็บ: แสดงเฉพาะว่ามีโหมดนี้ และสถานะเซสชันของผู้เรียกเอง (ไม่มีข้อมูลลับ)
  let aiTest = null;
  if (!user && aiTestReady(ctx)) {
    const session = readTestSession(ctx, req);
    if (session) {
      // ฐานข้อมูลยังไม่ได้รัน migration → แจ้งในกล่องทดสอบ แต่ /api/me ยังทำงานตามปกติ
      let usage;
      try { usage = await testUsage(ctx); } catch (err) { if (!isMissingSchema(err)) throw err; usage = { exhausted: true, error: "db_migration_required" }; }
      aiTest = { enabled: true, active: true, expiresAt: new Date(session.exp * 1000).toISOString(), ...usage };
    } else aiTest = { enabled: true, active: false };
  }
  const status = aiTest && aiTest.active ? (aiTest.exhausted ? "test_limit" : "test_ready") : aiStatus(ctx, user, guest);
  sendJson(res, 200, {
    user: user ? { id: user.id, name: user.name, role: user.role, image: user.image || null } : null,
    quota,
    providers: ctx.authReady ? ctx.providers : [],
    phoneLogin: ctx.authReady ? ctx.phoneLogin : "off",           // ready | coming_soon | off (coming_soon = ยังไม่มีผู้ส่ง SMS จริง)
    aiAvailable: canUseAi(ctx, user),
    aiStatus: status,
    guest,
    aiTest,
    aiReady: aiReadyForCustomers(ctx),
    turnstileSiteKey: ctx.config.turnstileSiteKey || null,
    liffId: ctx.config.liffId || null,
    lineOrders: canUseLineOrders(ctx, user),
    lineOaId: ctx.config.lineOaId,
    mock: ctx.mock,
  });
});
