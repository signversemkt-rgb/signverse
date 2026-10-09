// Vercel Cron (วันละครั้ง): ลบไฟล์ลูกค้า/ภาพ AI ที่เกินระยะเก็บรักษา รูปในถังขยะที่เกินกำหนด และคำขอ OTP เก่า
// ป้องกันด้วย CRON_SECRET (Vercel ส่ง Authorization: Bearer <CRON_SECRET>)
import { route } from "./_lib/route.mjs";
import { sendJson, HttpError } from "./_lib/http.mjs";
import { need } from "./_lib/context.mjs";

export default route(async (req, res, ctx) => {
  const secret = ctx.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, "unauthenticated");
  need(ctx, "repo", "storage");
  const now = new Date();
  const out = { uploads: 0, jobs: 0, trash: 0 };

  for (const u of await ctx.repo.listExpiredUploads(now)) {
    await ctx.storage.delPrivate(u.storage_key).catch(() => {});
    await ctx.repo.deleteUpload(u.upload_id);
    out.uploads++;
  }
  const jobCutoff = new Date(now - ctx.config.retentionDays * 86400000);
  for (const j of await ctx.repo.listExpiredJobs(jobCutoff)) {
    for (const k of [j.artwork_storage_key, j.mockup_storage_key, j.artwork_original_key, j.mockup_original_key]) if (k) await ctx.storage.delPrivate(k).catch(() => {});
    await ctx.repo.clearJobFiles(j.job_id);
    out.jobs++;
  }
  const guestCutoff = new Date(now - ctx.config.guest.retentionDays * 86400000);
  for (const j of await ctx.repo.listExpiredGuestJobs(guestCutoff)) {
    for (const k of [j.artwork_storage_key, j.mockup_storage_key, j.artwork_original_key, j.mockup_original_key]) if (k) await ctx.storage.delPrivate(k).catch(() => {});
    await ctx.repo.clearJobFiles(j.job_id);
    out.jobs++;
  }
  const trashCutoff = new Date(now - ctx.config.trashDays * 86400000);
  for (const img of await ctx.repo.listTrashBefore(trashCutoff)) {
    await ctx.storage.delPrivate(img.private_key).catch(() => {});
    await ctx.storage.delPrivate(img.private_thumb_key).catch(() => {});
    await ctx.repo.purgeImage(img.image_id);
    out.trash++;
  }
  // คำขอ OTP (มีแต่ hash) เก็บไว้ 7 วันเพื่อใช้นับเพดานการส่ง แล้วลบทิ้ง
  await ctx.repo.deleteOtpRequestsBefore(new Date(now - 7 * 86400000).toISOString());
  await ctx.repo.audit(null, "cleanup_run", null, out);
  sendJson(res, 200, out);
});
