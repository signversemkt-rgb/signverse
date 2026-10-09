// GET /api/files — ส่งไฟล์จาก Private Blob หลังตรวจสิทธิ์ทุกครั้ง (ห้าม cache ที่ CDN)
//   ?job=ID&kind=artwork|mockup → เจ้าของงาน หรือพนักงาน
//   ?upload=ID                  → เจ้าของไฟล์ หรือพนักงาน
//   ?gallery=ID[&thumb=1]       → ต้นฉบับรูปผลงาน (พนักงานเท่านั้น)
import { route } from "./_lib/route.mjs";
import { query, HttpError, isId } from "./_lib/http.mjs";
import { need, requireUser, rateLimit } from "./_lib/context.mjs";
import { getIp } from "./_lib/http.mjs";
import { verifyFileSig } from "./_lib/line.mjs";

const isStaff = (u) => u.role === "staff" || u.role === "admin";

export default route(async (req, res, ctx) => {
  if (req.method !== "GET") throw new HttpError(405, "bad_request");
  need(ctx, "repo", "storage");
  const q = query(req);
  let key = null;

  // ลิงก์มีลายเซ็น + วันหมดอายุ (ส่งให้ LINE ดึงรูปเข้ากลุ่มพนักงาน) — ใช้ได้เฉพาะไฟล์งานที่ระบุเท่านั้น
  if (q.sig) {
    await rateLimit(ctx, `signed-file:${getIp(req)}`, 300, 3600);
    if (!isId(q.job) || !["artwork", "mockup"].includes(q.kind)) throw new HttpError(400, "bad_request");
    if (!verifyFileSig({ secret: ctx.config.fileSigningSecret, jobId: q.job, kind: q.kind, exp: q.exp, sig: q.sig })) throw new HttpError(403, "forbidden");
    const f = await ctx.repo.findJobFile(q.job, q.kind);
    if (!f) throw new HttpError(404, "not_found");
    return sendFile(res, await ctx.storage.getPrivate(f.key));
  }

  const user = await requireUser(ctx, req);

  if (q.job) {
    if (!isId(q.job)) throw new HttpError(400, "bad_request");
    const f = await ctx.repo.findJobFile(q.job, q.kind);
    if (f && (f.userId === user.id || isStaff(user))) key = f.key;
  } else if (q.upload) {
    if (!isId(q.upload)) throw new HttpError(400, "bad_request");
    const [u] = await ctx.repo.getUploads([q.upload]);
    if (u && (u.user_id === user.id || isStaff(user))) key = u.storage_key;
  } else if (q.gallery) {
    if (!isId(q.gallery)) throw new HttpError(400, "bad_request");
    if (!isStaff(user)) throw new HttpError(403, "forbidden");
    const img = await ctx.repo.getImage(q.gallery);
    if (img) key = q.thumb === "1" ? img.private_thumb_key : img.private_key;
  }
  // ไม่บอกว่าไฟล์มีอยู่แต่ไม่มีสิทธิ์ (กันการเดา ID)
  if (!key) throw new HttpError(404, "not_found");

  sendFile(res, await ctx.storage.getPrivate(key));
});

function sendFile(res, file) {
  res.statusCode = 200;
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // กันสคริปต์ในไฟล์ภาพ (เช่น SVG) ทำงาน
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.end(Buffer.from(file.bytes));
}
