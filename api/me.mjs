// GET /api/me → สถานะล็อกอิน + สิทธิ์ AI คงเหลือ + provider ที่เปิดใช้จริง
// (Mock เท่านั้น) POST /api/me?mock=login|logout ใช้ทดสอบในเครื่อง — ระบบปฏิเสธบน Production
import { route } from "./_lib/route.mjs";
import { sendJson, query, readJson, HttpError, assertSameOrigin } from "./_lib/http.mjs";
import { quotaView } from "./_lib/jobs.mjs";

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
  sendJson(res, 200, {
    user: user ? { id: user.id, name: user.name, role: user.role, image: user.image || null } : null,
    quota,
    providers: ctx.authReady ? ctx.providers : [],
    aiAvailable: (await import("./_lib/context.mjs")).canUseAi(ctx, user),
    turnstileSiteKey: ctx.config.turnstileSiteKey || null,
    liffId: ctx.config.liffId || null,
    lineOrders: (await import("./_lib/context.mjs")).canUseLineOrders(ctx, user),
    lineOaId: ctx.config.lineOaId,
    mock: ctx.mock,
  });
});
