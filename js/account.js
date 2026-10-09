/* =========================================================
   SIGN VERSE — บัญชีลูกค้า / เข้าสู่ระบบด้วย LINE หรือเบอร์โทร + OTP / Modal
   สถานะล็อกอินและสิทธิ์มาจาก Server (/api/me) เท่านั้น
   วิธีเข้าสู่ระบบที่แสดง = วิธีที่ Server เปิดใช้จริง (providers)
   ========================================================= */

(() => {
  "use strict";

  const PROVIDER_LABELS = {
    facebook: "ดำเนินการต่อด้วย Facebook",
    phone: "เข้าสู่ระบบด้วยเบอร์โทรศัพท์",
    line: "ดำเนินการต่อด้วย LINE",
  };
  const PROVIDER_NAMES = { facebook: "Facebook", line: "LINE", google: "Google" };
  const PROVIDER_ICONS = { facebook: "#i-facebook", line: "#i-line", phone: "#i-phone" };
  const RESEND_SEC = 60;

  const state = { loaded: false, user: null, quota: null, providers: [], phoneLogin: "off", aiAvailable: false, aiStatus: "login_required", aiReady: false, turnstileSiteKey: null, mock: false, lineOrders: false };
  const listeners = [];
  const beforeLogin = [];
  let lastFocus = null;

  // ---------- Modal ----------
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    lastFocus = document.activeElement;
    m.hidden = false;
    document.body.classList.add("has-modal");
    const focusable = m.querySelector("button, a[href], input");
    if (focusable) focusable.focus();
  }
  function closeModal(m) {
    m.hidden = true;
    if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("has-modal");
    if (lastFocus) lastFocus.focus();
  }
  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) closeModal(closer.closest(".modal"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".modal:not([hidden])")].pop();
    if (open) closeModal(open);
  });

  // ---------- สถานะจาก Server ----------
  async function refresh() {
    try {
      const r = await fetch("/api/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
      const data = r.ok ? await r.json() : {};
      Object.assign(state, {
        loaded: true,
        user: data.user || null,
        quota: data.quota || null,
        providers: Array.isArray(data.providers) ? data.providers : [],
        phoneLogin: ["ready", "coming_soon"].includes(data.phoneLogin) ? data.phoneLogin : "off",
        aiAvailable: Boolean(data.aiAvailable),
        aiStatus: typeof data.aiStatus === "string" ? data.aiStatus : (data.user ? "coming_soon" : "login_required"),
        aiReady: Boolean(data.aiReady),
        guest: data.guest && typeof data.guest === "object" ? data.guest : null,     // Guest: { state, remainingToday, paused }
        turnstileSiteKey: data.turnstileSiteKey || null,
        mock: Boolean(data.mock),
        lineOrders: Boolean(data.lineOrders),
      });
    } catch {
      Object.assign(state, { loaded: true, user: null, quota: null, providers: [], phoneLogin: "off", aiAvailable: false, aiStatus: "login_required", aiReady: false });
    }
    renderHeader();
    listeners.forEach((fn) => fn(state));
    return state;
  }

  function renderHeader() {
    const btn = document.getElementById("authBtn");
    if (!btn) return;
    const who = document.getElementById("authUser");
    if (who) {
      // ชื่อ LINE หรือเบอร์ที่ปิดบังแล้ว (Server ส่งมาแบบปิดบัง ไม่มีเบอร์เต็ม)
      who.textContent = state.user ? `สวัสดี ${state.user.name || "สมาชิก"}` : "";
      who.title = who.textContent;
      who.hidden = !state.user;
    }
    if (state.user) {
      btn.textContent = "ออกจากระบบ";
      btn.title = `เข้าสู่ระบบเป็น ${state.user.name || "สมาชิก"}`;
      btn.dataset.mode = "logout";
    } else {
      btn.textContent = "เข้าสู่ระบบ";
      btn.title = "";
      btn.dataset.mode = "login";
    }
    // ซ่อนปุ่มเมื่อยังไม่มีวิธีเข้าสู่ระบบที่ใช้งานได้จริง
    btn.hidden = !state.user && state.providers.length === 0 && state.phoneLogin !== "ready";
  }

  // ---------- Login ----------
  function renderProviders() {
    const box = document.getElementById("loginProviders");
    const pending = document.getElementById("loginPending");
    box.replaceChildren();
    // Social (Facebook) + เบอร์โทร — เบอร์โทรที่ยังไม่มีผู้ส่ง SMS จริงแสดงเป็น "กำลังเตรียมเปิดใช้งาน" (กดไม่ได้)
    const methods = [...state.providers, ...(state.phoneLogin !== "off" ? ["phone"] : [])];
    methods.forEach((p) => {
      if (!PROVIDER_LABELS[p]) return;
      const soon = p === "phone" && state.phoneLogin !== "ready";
      const b = document.createElement("button");
      b.type = "button";
      b.className = `provider provider--${p}${soon ? " provider--soon" : ""}`;
      b.dataset.provider = p;
      if (soon) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
      if (PROVIDER_ICONS[p]) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "icon provider__icon");
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", PROVIDER_ICONS[p]);
        svg.appendChild(use);
        b.appendChild(svg);
      }
      b.appendChild(document.createTextNode(PROVIDER_LABELS[p]));
      if (soon) {
        const tag = document.createElement("span");
        tag.className = "provider__soon";
        tag.textContent = "กำลังเตรียมเปิดใช้งาน";
        b.appendChild(tag);
      }
      box.appendChild(b);
    });
    pending.hidden = state.providers.length > 0 || state.phoneLogin === "ready";
  }

  function showLoginError(msg) {
    const err = document.getElementById("loginError");
    err.textContent = msg || "";
    err.hidden = !msg;
  }

  function openLogin() {
    renderProviders();
    showPhoneForm(false);
    showLoginError("");
    openModal("loginModal");
  }

  // ---------- เบอร์โทรศัพท์ + OTP ----------
  const otp = { phone: null, timer: null, busy: false, widget: null, turnstile: null };
  const $id = (id) => document.getElementById(id);

  // รูปแบบเดียวกับ Server: 06/08/09 + 8 หลัก → +66…
  function normalizePhone(v) {
    const d = String(v || "").replace(/[\s\-().]/g, "");
    if (/^0[689]\d{8}$/.test(d)) return `+66${d.slice(1)}`;
    if (/^\+66[689]\d{8}$/.test(d)) return d;
    if (/^66[689]\d{8}$/.test(d)) return `+${d}`;
    return null;
  }
  const maskPhone = (e164) => { const l = `0${e164.slice(3)}`; return `${l.slice(0, 3)}-xxx-${l.slice(6)}`; };

  function showPhoneForm(on) {
    $id("loginChoose").hidden = on;
    $id("phoneForm").hidden = !on;
    if (!on) { $id("codeStep").hidden = true; $id("phoneStep").hidden = false; stopCountdown(); }
  }

  function stopCountdown() { clearInterval(otp.timer); otp.timer = null; }
  function startCountdown(sec) {
    stopCountdown();
    const btn = $id("otpResend");
    let left = Math.max(1, Math.round(sec));
    const tick = () => {
      if (left <= 0) { stopCountdown(); btn.disabled = false; btn.textContent = "ขอรหัสใหม่"; return; }
      btn.disabled = true;
      btn.textContent = `ขอรหัสใหม่ได้ใน ${left} วินาที`;
      left -= 1;
    };
    tick();
    otp.timer = setInterval(tick, 1000);
  }

  // Cloudflare Turnstile (เฉพาะเมื่อ Server เปิดใช้) — กันบอทยิง SMS
  function ensureTurnstile() {
    if (!state.turnstileSiteKey) return Promise.resolve(null);
    if (!otp.turnstile) {
      otp.turnstile = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.async = true;
        s.onload = () => {
          const box = $id("otpTurnstile");
          box.hidden = false;
          resolve(window.turnstile.render(box, { sitekey: state.turnstileSiteKey }));
        };
        document.head.appendChild(s);
      });
    }
    return otp.turnstile;
  }

  const FALLBACK = {
    429: "มีการขอรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
    400: "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่",
  };
  async function postAuth(path, body, headers = {}) {
    const r = await fetch(`/api/auth/phone-number/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // ข้อความภาษาไทยจาก Server (error) — ข้อความภาษาอังกฤษของไลบรารีใช้ข้อความสำรองแทน
      const thai = /[\u0E00-\u0E7F]/;
      const msg = [data.error, data.message].find((m) => typeof m === "string" && thai.test(m)) || FALLBACK[r.status] || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
      throw Object.assign(new Error(msg), { status: r.status, code: data.code, retryAfter: Number(r.headers.get("Retry-After")) || 0 });
    }
    return data;
  }

  async function sendOtp() {
    if (otp.busy) return;
    showLoginError("");
    const phone = normalizePhone($id("phoneInput").value);
    if (!phone) { showLoginError("กรุณากรอกเบอร์มือถือไทยให้ถูกต้อง (ขึ้นต้นด้วย 06, 08 หรือ 09 และมี 10 หลัก)"); $id("phoneInput").focus(); return; }
    otp.busy = true;
    const btn = $id("otpSend");
    btn.disabled = true;
    try {
      const widget = await ensureTurnstile();
      const token = widget != null ? window.turnstile.getResponse(widget) : "";
      if (widget != null && !token) throw new Error("กรุณายืนยันว่าไม่ใช่บอทก่อนขอรหัส");
      const r = await postAuth("send-otp", { phoneNumber: phone }, token ? { "x-turnstile-token": token } : {});
      otp.phone = phone;
      $id("phoneStep").hidden = true;
      $id("codeStep").hidden = false;
      $id("otpSentTo").textContent = `ส่งรหัสไปที่ ${maskPhone(phone)} แล้ว (รหัสใช้ได้ 5 นาที)`;
      $id("otpInput").value = "";
      $id("otpInput").focus();
      startCountdown(r.resendAfter || RESEND_SEC);
    } catch (err) {
      showLoginError(err.message);
      if (err.code === "otp_resend_wait" && otp.phone === phone) { $id("phoneStep").hidden = true; $id("codeStep").hidden = false; startCountdown(err.retryAfter || RESEND_SEC); }
    } finally {
      otp.busy = false;
      btn.disabled = false;
      if (window.turnstile && otp.turnstile) otp.turnstile.then((w) => w != null && window.turnstile.reset(w));
    }
  }

  async function verifyOtp() {
    if (otp.busy || !otp.phone) return;
    showLoginError("");
    const code = $id("otpInput").value.replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) { showLoginError("กรุณากรอกรหัส OTP 6 หลัก"); return; }
    otp.busy = true;
    const btn = $id("otpVerify");
    btn.disabled = true;
    btn.textContent = "กำลังยืนยัน…";
    try {
      await postAuth("verify", { phoneNumber: otp.phone, code });
      stopCountdown();
      closeModal(document.getElementById("loginModal"));
      await refresh();                              // ข้อมูลฟอร์มยังอยู่ในหน้าเดิม (ไม่มีการเปลี่ยนหน้า)
    } catch (err) {
      showLoginError(err.message);
      if (["otp_expired", "otp_too_many_attempts", "otp_not_found"].includes(err.code)) { stopCountdown(); $id("otpResend").disabled = false; $id("otpResend").textContent = "ขอรหัสใหม่"; }
    } finally {
      otp.busy = false;
      btn.disabled = false;
      btn.textContent = "ยืนยันและเข้าสู่ระบบ";
    }
  }

  document.addEventListener("submit", (e) => {
    if (e.target.id !== "phoneForm") return;
    e.preventDefault();
    if (!$id("codeStep").hidden) verifyOtp();
    else sendOtp();
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("#otpResend")) { $id("phoneStep").hidden = true; sendOtp(); }
    if (e.target.closest("#otpChange")) { stopCountdown(); otp.phone = null; $id("codeStep").hidden = true; $id("phoneStep").hidden = false; showLoginError(""); $id("phoneInput").focus(); }
    if (e.target.closest("#phoneBack")) { showLoginError(""); showPhoneForm(false); }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "otpInput") e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });

  async function signIn(provider) {
    if (provider === "phone") {
      if (state.phoneLogin !== "ready") return;           // ยังไม่มีผู้ส่ง SMS จริง → ไม่เปิดฟอร์ม OTP
      showLoginError(""); showPhoneForm(true); $id("phoneInput").focus(); return;
    }
    try { sessionStorage.setItem("sv_login_provider", provider); } catch { /* โหมดส่วนตัว */ }
    const err = document.getElementById("loginError");
    err.hidden = true;
    for (const fn of beforeLogin) await fn();      // เก็บข้อมูลฟอร์มก่อนออกไปหน้า LINE (กลับมาแล้วข้อมูลไม่หาย)
    try {
      if (state.mock) {
        await fetch("/api/me?mock=login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "customer", provider }) });
        location.reload();
        return;
      }
      const callbackURL = `${location.origin}${location.pathname}#ai-design`;
      const r = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        // LINE: bot_prompt=normal → หน้ายินยอมของ LINE แสดงตัวเลือกเพิ่มเพื่อน LINE OA @signverse (ต้องเชื่อม OA กับ LINE Login Channel)
        body: JSON.stringify({ provider, callbackURL, errorCallbackURL: callbackURL, ...(provider === "line" ? { additionalParams: { bot_prompt: "normal" } } : {}) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) throw new Error();
      location.assign(data.url);
    } catch {
      err.textContent = "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
      err.hidden = false;
    }
  }

  async function signOut() {
    try {
      if (state.mock) await fetch("/api/me?mock=logout", { method: "POST" });   // ล้าง cookie จำลองทุกแบบ (LINE / เบอร์โทร)
      else await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      location.reload();
    }
  }

  document.addEventListener("click", (e) => {
    const p = e.target.closest("#loginProviders [data-provider]");
    if (p) signIn(p.dataset.provider);
    if (e.target.closest("#authBtn")) {
      if (e.target.closest("#authBtn").dataset.mode === "logout") signOut();
      else openLogin();
    }
  });

  window.SVAccount = {
    state,
    refresh,
    openLogin,
    openModal,
    closeModal: (id) => { const m = document.getElementById(id); if (m) closeModal(m); },
    onChange: (fn) => listeners.push(fn),
    beforeLogin: (fn) => beforeLogin.push(fn),
  };

  // กลับจาก LINE แบบไม่สำเร็จ (Better Auth เติม ?error=… ใน URL) → แจ้งเป็นภาษาไทย แล้วลบพารามิเตอร์ออกจาก URL
  function takeLoginError() {
    const url = new URL(location.href);
    const code = url.searchParams.get("error");
    if (!code) return null;
    let via = "";
    try { via = PROVIDER_NAMES[sessionStorage.getItem("sv_login_provider")] || ""; sessionStorage.removeItem("sv_login_provider"); } catch { /* ไม่มี */ }
    const LOGIN_ERRORS = {
      access_denied: `คุณยกเลิกการเข้าสู่ระบบ${via ? `ด้วย ${via}` : ""} — กดปุ่มอีกครั้งเมื่อพร้อม ข้อมูลที่กรอกไว้ยังอยู่`,
      account_not_linked: "บัญชีนี้เชื่อมกับช่องทางอื่นอยู่แล้ว กรุณาเข้าสู่ระบบด้วยช่องทางเดิม หรือติดต่อทีมงานทาง LINE",
    };
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    url.searchParams.delete("error_reason");
    history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    return LOGIN_ERRORS[code] || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
  }

  // ลิงก์ /#login (เช่น จากหน้าหลังบ้าน) → เปิดหน้าต่างเข้าสู่ระบบ
  refresh().then(() => {
    const loginError = takeLoginError();
    if (loginError && !state.user) { openLogin(); showLoginError(loginError); return; }
    if (location.hash === "#login" && !state.user) openLogin();
  });
})();
