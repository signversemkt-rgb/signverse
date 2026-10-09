/* =========================================================
   SIGN VERSE — บัญชีลูกค้า / Social Login / Modal
   สถานะล็อกอินและสิทธิ์มาจาก Server (/api/me) เท่านั้น
   ========================================================= */

(() => {
  "use strict";

  const PROVIDER_LABELS = {
    google: "ดำเนินการต่อด้วย Google",
    line: "ดำเนินการต่อด้วย LINE",
    facebook: "ดำเนินการต่อด้วย Facebook",
  };

  const state = { loaded: false, user: null, quota: null, providers: [], aiAvailable: false, aiStatus: "login_required", aiReady: false, turnstileSiteKey: null, mock: false, lineOrders: false };
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
        aiAvailable: Boolean(data.aiAvailable),
        aiStatus: typeof data.aiStatus === "string" ? data.aiStatus : (data.user ? "coming_soon" : "login_required"),
        aiReady: Boolean(data.aiReady),
        turnstileSiteKey: data.turnstileSiteKey || null,
        mock: Boolean(data.mock),
        lineOrders: Boolean(data.lineOrders),
      });
    } catch {
      Object.assign(state, { loaded: true, user: null, quota: null, providers: [], aiAvailable: false, aiStatus: "login_required", aiReady: false });
    }
    renderHeader();
    listeners.forEach((fn) => fn(state));
    return state;
  }

  function renderHeader() {
    const btn = document.getElementById("authBtn");
    if (!btn) return;
    if (state.user) {
      btn.textContent = "ออกจากระบบ";
      btn.title = `เข้าสู่ระบบเป็น ${state.user.name || "สมาชิก"}`;
      btn.dataset.mode = "logout";
    } else {
      btn.textContent = "เข้าสู่ระบบ";
      btn.title = "";
      btn.dataset.mode = "login";
    }
    // ซ่อนปุ่มเมื่อยังไม่มี provider ที่ใช้งานได้จริง
    btn.hidden = !state.user && state.providers.length === 0;
  }

  // ---------- Login ----------
  function renderProviders() {
    const box = document.getElementById("loginProviders");
    const pending = document.getElementById("loginPending");
    box.replaceChildren();
    state.providers.forEach((p) => {
      if (!PROVIDER_LABELS[p]) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `provider provider--${p}`;
      b.dataset.provider = p;
      b.textContent = PROVIDER_LABELS[p];
      box.appendChild(b);
    });
    pending.hidden = state.providers.length > 0;
  }

  function openLogin() {
    renderProviders();
    document.getElementById("loginError").hidden = true;
    openModal("loginModal");
  }

  async function signIn(provider) {
    const err = document.getElementById("loginError");
    err.hidden = true;
    for (const fn of beforeLogin) await fn();      // เก็บข้อมูลฟอร์มก่อนออกไปหน้า Provider
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
        body: JSON.stringify({ provider, callbackURL, errorCallbackURL: callbackURL }),
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
      if (state.mock) await fetch("/api/me?mock=logout", { method: "POST" });
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

  refresh();
})();
