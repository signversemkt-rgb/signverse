// Better Auth endpoint: /api/auth/* (sign-in/social, callback/:provider, sign-out, get-session,
//   phone-number/send-otp, phone-number/verify …)
// ทุก path ใต้ /api/auth/ ถูก rewrite มาที่ function นี้ใน vercel.json (ไฟล์ [...all] ของ Vercel รับได้แค่ path ชั้นเดียว)
// req.url ยังเป็น path เดิมที่ลูกค้าเรียก → Better Auth แยกเส้นทางได้ถูกต้อง
// โหมดทดสอบในเครื่อง (MOCK_SERVICES=1): เบอร์โทร + OTP จำลองที่นี่ (SMS ไม่ถูกส่งจริง · ใช้ไม่ได้บน Production)
import { getAuth } from "../_lib/auth.mjs";
import { sendJson, errorBody, readJson, assertSameOrigin, HttpError, getIp } from "../_lib/http.mjs";
import { getContext } from "../_lib/context.mjs";
import { maskPhone } from "../_lib/phone.mjs";

async function mockPhone(req, res, ctx, path) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "bad_request");
    assertSameOrigin(req, ctx.config.origins);
    if (!ctx.phone) throw new HttpError(503, "not_configured");
    const body = await readJson(req);
    if (path === "send-otp") {
      const r = await ctx.phone.send({ phone: body.phoneNumber, ip: getIp(req) });
      return sendJson(res, 200, { message: "code sent", ...r });
    }
    await ctx.phone.verify({ phone: body.phoneNumber, code: body.code });
    // สมาชิกเดิม = เบอร์เดิม → บัญชีเดิม (ไม่สร้างซ้ำ) · สมาชิกใหม่ = สร้างบัญชีอัตโนมัติ
    let user = await ctx.repo.findUserByPhone(body.phoneNumber);
    if (!user) {
      const id = ctx.uuid();
      user = { id, name: maskPhone(body.phoneNumber), email: `${id}@phone.mock`, role: "customer", accountStatus: "active", phoneNumber: body.phoneNumber, phoneNumberVerified: true, createdAt: new Date().toISOString() };
      ctx.repo._db.users.set(id, user);
      ctx.repo._db.identities.push({ userId: id, providerId: "phone", accountId: id });
    }
    res.setHeader("Set-Cookie", `sv_mock_user=${user.id}; Path=/; HttpOnly; SameSite=Lax`);
    return sendJson(res, 200, { status: true, user: { id: user.id, name: user.name } });
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.retryAfter) res.setHeader("Retry-After", String(err.retryAfter));
      return sendJson(res, err.status, errorBody(err.code));
    }
    return sendJson(res, 500, errorBody("server_error"));
  }
}

export default async function handler(req, res) {
  const auth = await getAuth(process.env);
  if (!auth) {
    const ctx = await getContext();
    const m = /^\/api\/auth\/phone-number\/(send-otp|verify)(?:\?|$)/.exec(req.url || "");
    if (ctx.mock && m) return mockPhone(req, res, ctx, m[1]);
    if (ctx.mock && /^\/api\/auth\/sign-out/.test(req.url || "")) {
      res.setHeader("Set-Cookie", "sv_mock_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
      return sendJson(res, 200, { success: true });
    }
    return sendJson(res, 503, errorBody("not_configured"));
  }
  const { toNodeHandler } = await import("better-auth/node");
  return toNodeHandler(auth)(req, res);
}
