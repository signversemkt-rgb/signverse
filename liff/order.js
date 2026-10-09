/* SIGN VERSE — LIFF (ทางเลือก B: เปิดจาก Rich Menu ในแชต @signverse)
   - ใช้ liff.sendMessages() ได้เฉพาะเมื่อเปิดใน LIFF browser จากห้องแชต (context.type = "utou") และได้สิทธิ์ chat_message.write
   - ยืนยันตัวตนกับ Server ด้วย LINE ID token (Server ตรวจกับ LINE เอง) — ไม่เชื่อ userId จากหน้าเว็บ
   - Server จองการส่งก่อน (กันส่งซ้ำ) และสถานะ "ส่งสำเร็จ" บันทึกหลัง sendMessages สำเร็จจริงเท่านั้น */
(async () => {
  "use strict";
  const statusEl = document.getElementById("status");
  const list = document.getElementById("orders");
  const say = (t, err = false) => { statusEl.textContent = t; statusEl.className = "msg" + (err ? " err" : ""); statusEl.hidden = false; };

  async function post(body) {
    const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || "เกิดข้อผิดพลาด"), { code: data.code });
    return data;
  }

  let cfg = {};
  try { cfg = await (await fetch("/api/me")).json(); } catch { /* ignore */ }
  const oaUrl = `https://line.me/R/ti/p/${encodeURIComponent(cfg.lineOaId || "@signverse")}`;
  if (!cfg.liffId || !window.liff) return say("ระบบนี้ยังไม่เปิดใช้งาน กรุณาส่งข้อความหาทีมงานในแชต LINE", true);

  try {
    await liff.init({ liffId: cfg.liffId });
  } catch {
    return say("เปิดระบบไม่สำเร็จ กรุณาลองใหม่จากเมนูในแชต LINE", true);
  }
  if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }

  const context = liff.getContext();
  if (!liff.isInClient() || !context || context.type !== "utou") {
    say("กรุณาเปิดหน้านี้จากเมนูในห้องแชต LINE @signverse เพื่อส่งแบบเข้าแชตได้", true);
    list.innerHTML = "";
    const a = document.createElement("a");
    a.className = "btn"; a.href = oaUrl; a.textContent = "เปิดแชต @signverse";
    list.appendChild(a);
    return;
  }

  const idToken = liff.getIDToken();
  let orders = [];
  try { orders = (await post({ action: "liffOrders", idToken })).orders; }
  catch (e) { return say(e.message, true); }
  if (!orders.length) return say("ยังไม่พบออร์เดอร์ที่ผูกกับบัญชี LINE นี้ — สั่งผลิตจากเว็บไซต์ แล้วส่งข้อความที่ระบบเตรียมให้ในแชตนี้");
  statusEl.hidden = true;

  for (const o of orders) {
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("h2"); h.textContent = `${o.orderNo} · ${o.shopName || "-"}`;
    const p = document.createElement("p"); p.className = "muted"; p.textContent = o.size;
    const badge = document.createElement("span"); badge.className = "badge" + (o.lineDelivery.status === "sent" ? " sent" : ""); badge.textContent = o.lineDelivery.label;
    const btn = document.createElement("button"); btn.className = "btn"; btn.textContent = "ส่งแบบเข้าแชตนี้";
    btn.disabled = o.lineDelivery.status === "sent";
    btn.addEventListener("click", () => send(o, btn, badge));
    card.append(h, p, badge, btn);
    list.appendChild(card);
  }

  async function send(o, btn, badge) {
    btn.disabled = true;
    try {
      // ขอสิทธิ์ส่งข้อความเมื่อจำเป็น (LINE แสดงหน้ายืนยันเอง)
      const perm = await liff.permission.query("chat_message.write");
      if (perm.state === "prompt") await liff.permission.requestAll();
      else if (perm.state === "unavailable") throw new Error("บัญชี/อุปกรณ์นี้ไม่รองรับการส่งข้อความจากหน้านี้ กรุณาส่งข้อความหาทีมงานในแชตโดยตรง");

      const prep = await post({ action: "liffPrepare", idToken, orderId: o.orderId });
      try {
        await liff.sendMessages(prep.messages);
      } catch (err) {
        await post({ action: "liffResult", idToken, orderId: o.orderId, ok: false }).catch(() => {});
        throw new Error("ส่งเข้าแชตไม่สำเร็จ กรุณาลองใหม่ (ยังไม่มีการส่งซ้ำ)");
      }
      await post({ action: "liffResult", idToken, orderId: o.orderId, ok: true });
      badge.textContent = "ส่งผ่าน LINE สำเร็จ"; badge.className = "badge sent";
      say("ส่งแบบเข้าแชตแล้ว ทีมงานจะตอบกลับในแชตนี้");
    } catch (e) {
      btn.disabled = e.code === "already_sent";
      say(e.message, true);
    }
  }
})();
