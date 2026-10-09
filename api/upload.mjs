// POST /api/upload — ลูกค้า (ต้องล็อกอิน) อัปโหลดภาพอ้างอิงหรือภาพหน้าร้าน → Private Blob เท่านั้น
// body: { kind: "reference" | "storefront", data: "<base64>" } (ย่อในเบราว์เซอร์ก่อนส่ง)
import { route } from "./_lib/route.mjs";
import { sendJson, readJson, HttpError, assertSameOrigin, getIp } from "./_lib/http.mjs";
import { need, requireUser, rateLimit } from "./_lib/context.mjs";
import { decodeImage, LIMITS } from "./_lib/images.mjs";

export default route(async (req, res, ctx) => {
  if (req.method !== "POST") throw new HttpError(405, "bad_request");
  assertSameOrigin(req, ctx.config.origins);
  need(ctx, "repo", "storage");
  const user = await requireUser(ctx, req);
  await rateLimit(ctx, `upload:user:${user.id}`, 20, 3600);
  await rateLimit(ctx, `upload:ip:${getIp(req)}`, 40, 3600);

  const body = await readJson(req, 4_400_000);
  if (!["reference", "storefront"].includes(body.kind)) throw new HttpError(400, "bad_request");
  const img = decodeImage(body.data, LIMITS.customerBytes);

  const id = ctx.uuid();
  // ชื่อไฟล์สร้างใหม่ทั้งหมด ไม่ใช้ชื่อ/Metadata จากเครื่องลูกค้า
  const key = await ctx.storage.putPrivate(`customers/${user.id}/${body.kind}/${id}.${img.ext}`, img.bytes, img.mime);
  const now = Date.now();
  await ctx.repo.createUpload({
    upload_id: id, user_id: user.id, kind: body.kind, storage_key: key, mime: img.mime, size_bytes: img.bytes.length,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + ctx.config.retentionDays * 86400000).toISOString(),
  });
  sendJson(res, 201, { uploadId: id, kind: body.kind, url: `/api/files?upload=${id}` });
});
