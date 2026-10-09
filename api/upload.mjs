// POST /api/upload — ลูกค้า (สมาชิก หรือ Guest เมื่อ GUEST_AI_ENABLED) อัปโหลดภาพอ้างอิงหรือภาพหน้าร้าน → Private Blob เท่านั้น
// body: { kind: "reference" | "storefront", data: "<base64>" } (ย่อในเบราว์เซอร์ก่อนส่ง)
import { route } from "./_lib/route.mjs";
import { sendJson, readJson, HttpError, assertSameOrigin, getIp } from "./_lib/http.mjs";
import { need, rateLimit, canUseAi, resolveActor } from "./_lib/context.mjs";
import { decodeImage, LIMITS } from "./_lib/images.mjs";

export default route(async (req, res, ctx) => {
  if (req.method !== "POST") throw new HttpError(405, "bad_request");
  assertSameOrigin(req, ctx.config.origins);
  need(ctx, "repo", "storage");
  // Guest ผ่านได้เฉพาะเมื่อ AI จริงพร้อม (resolveActor ตรวจแล้ว) · สมาชิกต้องใช้ AI ได้
  const { user, guestId } = await resolveActor(ctx, req, res, { create: true });
  // รูปลูกค้าใช้เพื่อสร้างภาพ AI เท่านั้น → ระบบยังไม่เปิดให้ผู้ใช้นี้ = ไม่รับไฟล์ (ไม่เก็บรูปลูกค้าโดยไม่จำเป็น)
  if (user && !canUseAi(ctx, user)) throw new HttpError(403, "ai_unavailable");
  const owner = user ? user.id : `guest-${guestId}`;
  await rateLimit(ctx, `upload:user:${owner}`, 20, 3600);
  await rateLimit(ctx, `upload:ip:${getIp(req)}`, 40, 3600);

  const body = await readJson(req, 4_400_000);
  if (!["reference", "storefront"].includes(body.kind)) throw new HttpError(400, "bad_request");
  const img = decodeImage(body.data, LIMITS.customerBytes);

  const id = ctx.uuid();
  // ชื่อไฟล์สร้างใหม่ทั้งหมด ไม่ใช้ชื่อ/Metadata จากเครื่องลูกค้า
  const key = await ctx.storage.putPrivate(`customers/${owner}/${body.kind}/${id}.${img.ext}`, img.bytes, img.mime);
  const now = Date.now();
  // ไฟล์ของ Guest เก็บสั้นกว่า (GUEST_FILE_RETENTION_DAYS) แล้วลบอัตโนมัติด้วย cron
  const days = user ? ctx.config.retentionDays : ctx.config.guest.retentionDays;
  await ctx.repo.createUpload({
    upload_id: id, user_id: user ? user.id : null, guest_id: user ? null : guestId, kind: body.kind, storage_key: key, mime: img.mime, size_bytes: img.bytes.length,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + days * 86400000).toISOString(),
  });
  sendJson(res, 201, { uploadId: id, kind: body.kind, url: `/api/files?upload=${id}` });
});
