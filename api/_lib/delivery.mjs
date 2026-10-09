// ส่งคำสั่งผลิตเข้าแชต LINE OA ของลูกค้าคนนั้น (ไม่ใช้กลุ่ม ไม่ใช้ push)
//
// ทาง A (หลัก): ลูกค้ากด "สั่งผลิตป้ายนี้" → LINE เปิดแชต @signverse พร้อมข้อความ (มีเลขออร์เดอร์ + รหัสยืนยัน)
//   → ลูกค้ากดส่งเอง → Webhook (ตรวจลายเซ็น) → ตอบกลับ (reply, ฟรี) ด้วยรูป Artwork + Mockup ในแชตเดียวกัน
//   - reply ได้เฉพาะเมื่อมี replyToken (ลูกค้าส่งข้อความมาก่อน) และต้องใช้ภายใน ~1 นาที ครั้งเดียว
//   - ส่งแค่ครั้งเดียวต่อออร์เดอร์ (claim แบบ atomic) · ผูก LINE userId ที่ LINE ยืนยันแล้ว · คนอื่นใช้รหัสไม่ได้
// ทาง B (Rich Menu ในอนาคต): หน้า LIFF ที่เปิดจากแชต → ตรวจ ID token → liff.sendMessages ส่งในนามลูกค้า
import { signedFileUrl } from "./line.mjs";
import { parseOrderRef, orderView, buildLineText } from "./orders.mjs";
import { maskId, canUseLineOrders } from "./context.mjs";
import { timingSafeEqual } from "node:crypto";

export const STALE_SENDING_MS = 2 * 60 * 1000;
const LINE_USER = /^U[0-9a-f]{32}$/;

function sameCode(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// LINE รับรูปเฉพาะ JPEG/PNG ผ่าน HTTPS — ไฟล์ชนิดอื่น (เช่น SVG ของ Mock) จะไม่ถูกส่งเป็นรูป
function sendableImage(key) {
  return /\.(png|jpe?g)(\?|$)/i.test(String(key || ""));
}

export async function buildDeliveryMessages(ctx, order, { forCustomerSend = false } = {}) {
  const job = order.job_id ? await ctx.repo.getJob(order.job_id) : null;
  const images = [];
  const skipped = [];
  for (const [kind, label] of [["artwork", "Artwork"], ["mockup", "Mockup"]]) {
    const key = job && job[`${kind}_status`] === "done" ? job[`${kind}_storage_key`] : null;
    if (!key) continue;
    if (!sendableImage(key)) { skipped.push(label); continue; }
    const url = signedFileUrl({ baseUrl: ctx.config.baseUrl, secret: ctx.config.fileSigningSecret, jobId: job.job_id, kind, ttlSec: ctx.config.fileUrlTtlSec });
    if (!url) { skipped.push(label); continue; }            // ไม่มี FILE_SIGNING_SECRET ที่ปลอดภัย → ไม่ส่งรูป
    images.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  const head = forCustomerSend
    ? `แบบป้ายสำหรับออร์เดอร์ ${order.order_no}`
    : `✅ SIGN VERSE ได้รับคำสั่งผลิต ${order.order_no} แล้ว\nทีมงานจะตรวจสอบรายละเอียดและติดต่อกลับในแชตนี้`;
  const lines = [head];
  if (images.length) lines.push("ภาพแบบร่างจาก AI (Artwork / Mockup) อยู่ด้านล่าง");
  if (skipped.length) lines.push(`(ภาพ ${skipped.join(", ")} ทีมงานจะเปิดดูจากระบบ)`);
  return [{ type: "text", text: lines.join("\n") }, ...images].slice(0, 5);
}

async function finish(ctx, order, ok, error, channel, lineUserId, requestId = null) {
  await ctx.repo.finishLineDelivery(order.order_id, ok, error, requestId);
  await ctx.repo.audit(null, ok ? "line_order_delivered" : "line_order_delivery_failed", order.order_no, { channel, lineUser: maskId(lineUserId), error, requestId });
}

// LINE userId ของเจ้าของออร์เดอร์จาก LINE Login (ใช้ได้เฉพาะเมื่ออยู่ Provider เดียวกับ OA = รูปแบบ U + hex 32)
async function linkedLineId(ctx, userId) {
  const id = await ctx.repo.getUserLineId(userId);
  return LINE_USER.test(id || "") ? id : null;
}

// ---------- ทาง A: ข้อความจากลูกค้าในแชต 1-on-1 ----------
export async function handleOrderMessage(ctx, ev) {
  const ref = parseOrderRef(ev.message?.text);
  if (!ref) return "ignored";                                   // ข้อความทั่วไป → ปล่อยให้พนักงานตอบตามปกติ
  const lineUserId = ev.source?.userId;
  if (!LINE_USER.test(lineUserId || "") || !ev.replyToken) return "ignored";
  if (!ctx.line) return "not_configured";                        // ยังไม่ตั้ง token → ไม่จองสิทธิ์ ไม่ทำอะไร

  if (ctx.config.lineOrdersMode === "off") return "orders_disabled";   // ยังไม่เปิดใช้ → ไม่ตอบ ไม่จองสิทธิ์
  const order = await ctx.repo.getOrderByNo(ref.orderNo);
  if (order && !canUseLineOrders(ctx, await ctx.repo.getUser(order.user_id))) return "orders_disabled";
  if (!order || !sameCode(order.claim_code, ref.code)) {
    await ctx.repo.audit(null, "line_order_code_rejected", ref.orderNo, { lineUser: maskId(lineUserId) });
    return "rejected";                                          // ไม่ตอบ (ไม่บอกใบ้คนที่เดารหัส)
  }
  // ถ้าเจ้าของออร์เดอร์ล็อกอินเว็บด้วย LINE (provider เดียวกัน) ต้องเป็นบัญชี LINE เดียวกันเท่านั้น
  const linked = await linkedLineId(ctx, order.user_id);
  const mismatch = (linked && linked !== lineUserId) || (order.line_user_id && order.line_user_id !== lineUserId);
  if (mismatch) {
    await ctx.repo.audit(null, "line_order_user_mismatch", order.order_no, { lineUser: maskId(lineUserId) });
    await ctx.line.reply(ev.replyToken, [{ type: "text", text: "ไม่สามารถยืนยันออร์เดอร์นี้กับบัญชี LINE นี้ได้ ทีมงานจะตรวจสอบและติดต่อกลับค่ะ" }]).catch(() => {});
    return "mismatch";
  }
  const claimed = await ctx.repo.claimLineDelivery(order.order_id, lineUserId, "oa_reply", new Date(Date.now() - STALE_SENDING_MS));
  if (!claimed) return order.line_delivery_status === "sent" ? "duplicate" : "busy";   // ส่งไปแล้ว/กำลังส่ง → ไม่ส่งซ้ำ

  try {
    // reply ไปยัง replyToken ของข้อความนี้ = ห้องแชตของผู้ส่งเท่านั้น (ส่งผิดห้องไม่ได้)
    const r = await ctx.line.reply(ev.replyToken, await buildDeliveryMessages(ctx, claimed));
    await finish(ctx, claimed, true, null, "oa_reply", lineUserId, r && r.requestId);
    return "sent";
  } catch (err) {
    await finish(ctx, claimed, false, `reply_${err.status || "error"}`, "oa_reply", lineUserId, err.requestId || null);
    return "failed";
  }
}

// ---------- ทาง B: LIFF (เปิดจากแชต @signverse ผ่าน Rich Menu) ----------
// ตรวจ ID token กับ LINE (ห้ามเชื่อ userId ที่ Browser ส่งมาเอง)
export async function verifyLiffIdToken(ctx, idToken) {
  if (typeof idToken !== "string" || idToken.length < 10 || idToken.length > 4000) return null;
  if (ctx.mock) {                                               // Mock: "mock:<LINE userId>" ใช้ได้เฉพาะโหมดทดสอบ
    const m = /^mock:(U[0-9a-f]{32})$/.exec(idToken);
    return m ? m[1] : null;
  }
  if (!ctx.config.liffChannelId) return null;
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: ctx.config.liffChannelId }),
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  return LINE_USER.test(data.sub || "") ? data.sub : null;
}

async function ownsOrder(ctx, order, lineUserId) {
  if (order.line_user_id) return order.line_user_id === lineUserId;
  const linked = await linkedLineId(ctx, order.user_id);
  return linked === lineUserId;            // ยังไม่ผูก → ต้องเป็นบัญชี LINE ที่เจ้าของออร์เดอร์ใช้ล็อกอินเว็บ
}

export async function liffListOrders(ctx, lineUserId) {
  const userId = await ctx.repo.findUserIdByLineId(lineUserId);
  const rows = await ctx.repo.listLineOrdersForUser(lineUserId, userId, 10);
  return rows.map((o) => {
    const v = orderView(o);
    return { orderId: v.orderId, orderNo: v.orderNo, shopName: v.form.shopName, size: `${v.form.widthCm} x ${v.form.heightCm} ซม.`, lineDelivery: v.lineDelivery };
  });
}

// จองการส่ง + คืนข้อความให้หน้า LIFF ส่งด้วย liff.sendMessages (ในนามลูกค้า)
export async function liffPrepare(ctx, lineUserId, orderId) {
  const order = await ctx.repo.getOrder(orderId);
  if (!order || !(await ownsOrder(ctx, order, lineUserId))) return { error: "not_found" };
  const claimed = await ctx.repo.claimLineDelivery(order.order_id, lineUserId, "liff", new Date(Date.now() - STALE_SENDING_MS));
  if (!claimed) return { error: order.line_delivery_status === "sent" ? "already_sent" : "busy" };
  const text = { type: "text", text: buildLineText(claimed).slice(0, 4900) };
  const rest = (await buildDeliveryMessages(ctx, claimed, { forCustomerSend: true })).filter((m) => m.type === "image");
  return { messages: [text, ...rest] };
}

export async function liffResult(ctx, lineUserId, orderId, ok) {
  const order = await ctx.repo.getOrder(orderId);
  if (!order || order.line_user_id !== lineUserId || order.line_delivery_status !== "sending") return { error: "not_found" };
  await finish(ctx, order, Boolean(ok), ok ? null : "liff_send_failed", "liff", lineUserId);
  return { ok: true };
}
