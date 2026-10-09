// POST /api/line/webhook — LINE Messaging API Webhook (LINE OA @signverse)
// 1) ตรวจ x-line-signature ด้วย LINE_CHANNEL_SECRET จาก raw body ก่อนทำอย่างอื่น
// 2) แชต 1-on-1: ตอบเฉพาะข้อความที่มี "เลขออร์เดอร์ + รหัสยืนยัน" ที่ถูกต้อง → reply รูป Artwork/Mockup (ส่งครั้งเดียวต่อออร์เดอร์)
//    ข้อความอื่นทั้งหมดไม่ตอบ → พนักงานตอบแชตใน LINE OA Manager ได้ตามปกติ
// 3) เหตุการณ์กลุ่ม (ระบบเดิม) ทำงานเฉพาะเมื่อ LINE_GROUP_ORDERS_ENABLED=true
// 4) ไม่บันทึกข้อความแชตหรือ userId เต็มลง log
import { route } from "../_lib/route.mjs";
import { sendJson, HttpError } from "../_lib/http.mjs";
import { need, maskId } from "../_lib/context.mjs";
import { verifySignature, parseBindCommand, hashCode, sameHash } from "../_lib/line.mjs";
import { handleOrderMessage } from "../_lib/delivery.mjs";

const MAX_BODY = 1_000_000;

async function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "bad_request");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function tryBind(ctx, ev) {
  const code = parseBindCommand(ev.message?.text);
  if (!code) return "ignored";
  const raw = await ctx.repo.getSetting("line_bind_code");
  const saved = raw ? JSON.parse(raw) : null;
  if (!saved || saved.exp < Date.now() || !sameHash(saved.hash, hashCode(code))) {
    await ctx.repo.audit(null, "line_bind_rejected", maskId(ev.source.groupId), {});
    return "rejected";                                   // ไม่ตอบกลับ (ไม่บอกใบ้คนที่เดารหัส)
  }
  await ctx.repo.deleteSetting("line_bind_code");        // ใช้ครั้งเดียว
  await ctx.repo.setSetting("line_staff_group_id", ev.source.groupId, saved.createdBy || null);
  await ctx.repo.upsertLineGroup(ev.source.groupId, "staff");
  await ctx.repo.audit(saved.createdBy || null, "line_group_bound", maskId(ev.source.groupId), {});
  if (ctx.line && ev.replyToken) {
    await ctx.line.reply(ev.replyToken, [{ type: "text", text: "✅ ผูกกลุ่มนี้เป็นกลุ่มพนักงาน SIGN VERSE แล้ว คำสั่งผลิตจากเว็บไซต์จะถูกส่งเข้ากลุ่มนี้" }]).catch(() => {});
  }
  return "bound";
}

export default route(async (req, res, ctx) => {
  if (req.method !== "POST") throw new HttpError(405, "bad_request");
  if (!ctx.config.lineChannelSecret) throw new HttpError(503, "not_configured");

  const body = await rawBody(req);
  if (!verifySignature(body, req.headers["x-line-signature"], ctx.config.lineChannelSecret)) {
    throw new HttpError(401, "bad_signature");
  }
  let payload;
  try { payload = JSON.parse(body.toString("utf8")); } catch { throw new HttpError(400, "bad_request"); }
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 50) : [];
  if (!events.length) return sendJson(res, 200, { ok: true });   // คำขอ Verify จาก LINE Console

  need(ctx, "repo");
  const results = [];
  for (const ev of events) {
    // แชต 1-on-1 กับ OA → ระบบสั่งผลิต (ทาง A)
    if (ev.source?.type === "user") {
      results.push(ev.type === "message" && ev.message?.type === "text" ? await handleOrderMessage(ctx, ev) : "ignored");
      continue;
    }
    // กลุ่ม → ระบบเดิม (ปิดเป็นค่าเริ่มต้น)
    if (!ctx.config.lineGroupOrdersEnabled) { results.push("group_disabled"); continue; }
    const groupId = ev.source?.type === "group" ? ev.source.groupId : null;
    if (!groupId || !/^C[0-9a-f]{32}$/.test(groupId)) { results.push("ignored"); continue; }

    if (ev.type === "join") {
      await ctx.repo.upsertLineGroup(groupId, "joined");
      await ctx.repo.audit(null, "line_group_joined", maskId(groupId), {});
      results.push("joined");
    } else if (ev.type === "leave") {
      if ((await ctx.repo.getSetting("line_staff_group_id")) === groupId) await ctx.repo.deleteSetting("line_staff_group_id");
      await ctx.repo.upsertLineGroup(groupId, "left");
      await ctx.repo.audit(null, "line_group_left", maskId(groupId), {});
      results.push("left");
    } else if (ev.type === "message" && ev.message?.type === "text") {
      results.push(await tryBind(ctx, ev));
    } else {
      results.push("ignored");
    }
  }
  console.log("[line-webhook]", events.length, "events:", results.join(","));   // ไม่มีเนื้อหาข้อความ
  sendJson(res, 200, { ok: true });
});
