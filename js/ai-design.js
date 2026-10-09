/* =========================================================
   SIGN VERSE — AI ออกแบบภาพป้าย (Artwork + Mockup)
   - ใช้ข้อมูลจากฟอร์มบรีฟเดิม (#briefForm) ไม่ต้องกรอกซ้ำ
   - ต้องล็อกอิน + ตรวจสิทธิ์ที่ Server ก่อนสร้างภาพ
   - เก็บข้อมูลฟอร์ม/ภาพที่เลือกไว้ระหว่างไปหน้าล็อกอิน (sessionStorage + IndexedDB ในเครื่อง, หมดอายุ 24 ชม.)
   - ตัวเลขขนาดบน Artwork วาดด้วย Canvas จากข้อมูลจริงที่ลูกค้ากรอก
   ========================================================= */

(() => {
  "use strict";

  const root = document.getElementById("ai-design");
  const form = document.getElementById("briefForm");
  if (!root || !form || !window.SVAccount) return;

  const $ = (id) => document.getElementById(id);
  const MAX_REFS = 3;
  const PENDING_KEY = "sv_ai_pending";
  const PENDING_TTL = 24 * 60 * 60 * 1000;
  const MAX_RAW_BYTES = 15 * 1024 * 1024;
  const OK_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const LIGHT_LABELS = { none: "ไม่ติดไฟ", white: "ไฟสีขาว", warm: "ไฟวอร์มไวท์" };

  const state = {
    refs: [],            // [{ id, title, thumbUrl, url }] จากอัลบั้ม SIGN VERSE
    refFiles: [],        // File[] ที่ลูกค้าเลือก (ยังอยู่ในเครื่อง จนกว่าจะกดสร้าง)
    storefront: null,    // File | null
    job: null,
    busy: false,
    images: {},          // { artwork: HTMLImageElement, mockup: blobUrl }
  };

  const errBox = $("aiError");
  const notice = $("aiNotice");
  const genBtn = $("aiGenerate");
  const genLabel = genBtn.querySelector("span");

  const statusBox = $("aiStatus");
  const GEN_LABEL = "สร้างภาพป้ายด้วย AI ฟรี";
  const GEN_LABEL_GUEST = "สร้างภาพป้ายด้วย AI ฟรี ไม่ต้องสมัครสมาชิก";
  const isGuestMode = (acc) => ["guest_ready", "guest_limit"].includes(acc.aiStatus);
  const genLabelFor = (acc) => (isGuestMode(acc) ? GEN_LABEL_GUEST : GEN_LABEL);

  const showError = (msg) => { errBox.textContent = msg || ""; errBox.hidden = !msg; };
  const showNotice = (msg) => { notice.textContent = msg || ""; notice.hidden = !msg; };

  // ---------- อ่านฟอร์มเดิม ----------
  function readForm() {
    const fd = new FormData(form);
    const g = (k) => String(fd.get(k) || "").trim();
    return {
      shopName: g("shopName"), signText: g("signText"), widthCm: g("widthCm"), heightCm: g("heightCm"),
      material: g("material"), layers: g("layers"), jobType: g("jobType"), lighting: g("lighting") || "none",
      colors: g("colors"), style: g("style"), details: g("details"),
    };
  }

  // ---------- Gallery ผลงาน ----------
  async function loadAlbums() {
    const box = $("refGallery");
    try {
      const r = await fetch("/api/gallery");
      if (!r.ok) throw new Error();
      const { albums } = await r.json();
      if (!albums.length) throw new Error("empty");
      box.replaceChildren();
      const chips = document.createElement("div");
      chips.className = "refgal__albums";
      albums.forEach((a, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "refgal__album" + (i === 0 ? " is-active" : "");
        b.dataset.album = a.id;
        b.textContent = `${a.title} (${a.imageCount})`;
        chips.appendChild(b);
      });
      const grid = document.createElement("div");
      grid.className = "refgal__grid";
      grid.id = "refGrid";
      const more = document.createElement("button");
      more.type = "button";
      more.className = "btn btn--outline refgal__more";
      more.id = "refMore";
      more.textContent = "โหลดเพิ่ม";
      more.hidden = true;
      box.append(chips, grid, more);
      loadImages(albums[0].id, 0);
    } catch {
      $("refEmpty").textContent = "กำลังเพิ่มผลงานตัวอย่าง — ระหว่างนี้อัปโหลดภาพอ้างอิงของคุณเองได้";
    }
  }

  let currentAlbum = null;
  async function loadImages(albumId, page) {
    currentAlbum = albumId;
    const grid = $("refGrid");
    const more = $("refMore");
    if (page === 0) grid.replaceChildren();
    try {
      const r = await fetch(`/api/gallery?album=${encodeURIComponent(albumId)}&page=${page}`);
      const data = await r.json();
      if (currentAlbum !== albumId) return;
      data.images.forEach((img) => grid.appendChild(refCard(img)));
      more.hidden = !data.hasMore;
      more.dataset.page = String(page + 1);
    } catch {
      more.hidden = true;
    }
  }

  function refCard(img) {
    const card = document.createElement("div");
    card.className = "refcard";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "refcard__pick";
    pick.dataset.ref = img.id;
    pick.setAttribute("aria-pressed", String(state.refs.some((r) => r.id === img.id)));
    pick.setAttribute("aria-label", `เลือก ${img.title || "ผลงาน"} เป็นภาพอ้างอิง`);
    const im = document.createElement("img");
    im.src = img.thumbUrl;
    im.alt = img.alt || img.title || "ผลงาน SIGN VERSE";
    im.loading = "lazy";
    im.width = 240;
    im.height = 180;
    im.onerror = () => card.remove();               // ซ่อนรูปที่เสีย
    pick.appendChild(im);
    pick._data = img;
    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "refcard__zoom";
    zoom.textContent = "ขยาย";
    zoom.dataset.zoom = img.url;
    zoom.dataset.cap = img.title || "";
    const cap = document.createElement("span");
    cap.className = "refcard__cap";
    cap.textContent = img.title || "";
    card.append(pick, zoom, cap);
    return card;
  }

  function totalRefs() { return state.refs.length + state.refFiles.length; }

  function renderPicked() {
    $("refCount").textContent = `(เลือกแล้ว ${totalRefs()}/${MAX_REFS})`;
    document.querySelectorAll("#refGrid .refcard__pick").forEach((b) => {
      b.setAttribute("aria-pressed", String(state.refs.some((r) => r.id === b.dataset.ref)));
    });
    const box = $("refPicked");
    box.replaceChildren();
    box.hidden = state.refs.length === 0;
    if (!state.refs.length) return;
    const label = document.createElement("span");
    label.textContent = "ภาพที่เลือก:";
    box.appendChild(label);
    state.refs.forEach((r) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "refpicked__chip";
      chip.dataset.unref = r.id;
      chip.textContent = `${r.title || "ผลงาน"} ×`;
      box.appendChild(chip);
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "refpicked__clear";
    clear.dataset.clearRefs = "1";
    clear.textContent = "ล้างการเลือก";
    box.appendChild(clear);
  }

  // ---------- ไฟล์ที่ลูกค้าเลือก ----------
  function renderFiles() {
    const list = (el, files, kind) => {
      el.replaceChildren();
      files.forEach((f, i) => {
        const wrap = document.createElement("div");
        wrap.className = "thumbs__item";
        const im = document.createElement("img");
        im.src = URL.createObjectURL(f);
        im.alt = kind === "storefront" ? "รูปหน้าร้าน" : "ภาพอ้างอิงที่อัปโหลด";
        im.onload = () => URL.revokeObjectURL(im.src);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "×";
        rm.setAttribute("aria-label", "ลบรูปนี้");
        rm.dataset.remove = kind;
        rm.dataset.index = String(i);
        wrap.append(im, rm);
        el.appendChild(wrap);
      });
    };
    list($("refUploadList"), state.refFiles, "reference");
    list($("storefrontList"), state.storefront ? [state.storefront] : [], "storefront");
    renderPicked();
  }

  function acceptFile(f) {
    if (!OK_TYPES.includes(f.type)) { showError("รองรับเฉพาะไฟล์ JPG, PNG และ WebP"); return false; }
    if (f.size > MAX_RAW_BYTES) { showError("ไฟล์รูปใหญ่เกิน 15 MB"); return false; }
    return true;
  }

  $("refUpload").addEventListener("change", (e) => {
    showError("");
    for (const f of e.target.files) {
      if (totalRefs() >= MAX_REFS) { showError(`เลือกภาพอ้างอิงได้สูงสุด ${MAX_REFS} ภาพรวมทุกแหล่ง`); break; }
      if (acceptFile(f)) state.refFiles.push(f);
    }
    e.target.value = "";
    renderFiles();
  });
  $("storefrontUpload").addEventListener("change", (e) => {
    showError("");
    const f = e.target.files[0];
    if (f && acceptFile(f)) state.storefront = f;
    e.target.value = "";
    renderFiles();
  });

  root.addEventListener("click", (e) => {
    const pick = e.target.closest(".refcard__pick");
    if (pick) {
      showError("");
      const i = state.refs.findIndex((r) => r.id === pick.dataset.ref);
      if (i >= 0) state.refs.splice(i, 1);
      else if (totalRefs() >= MAX_REFS) showError(`เลือกภาพอ้างอิงได้สูงสุด ${MAX_REFS} ภาพรวมทุกแหล่ง`);
      else state.refs.push({ id: pick._data.id, title: pick._data.title, thumbUrl: pick._data.thumbUrl, url: pick._data.url });
      return renderPicked();
    }
    const album = e.target.closest(".refgal__album");
    if (album) {
      document.querySelectorAll(".refgal__album").forEach((b) => b.classList.toggle("is-active", b === album));
      return loadImages(album.dataset.album, 0);
    }
    if (e.target.closest("#refMore")) return loadImages(currentAlbum, Number($("refMore").dataset.page));
    const un = e.target.closest("[data-unref]");
    if (un) { state.refs = state.refs.filter((r) => r.id !== un.dataset.unref); return renderPicked(); }
    if (e.target.closest("[data-clear-refs]")) { state.refs = []; return renderPicked(); }
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      if (rm.dataset.remove === "storefront") state.storefront = null;
      else state.refFiles.splice(Number(rm.dataset.index), 1);
      return renderFiles();
    }
    const z = e.target.closest("[data-zoom]");
    if (z) return zoom(z.dataset.zoom, z.dataset.cap);
  });

  function zoom(src, cap) {
    $("zoomImg").src = src;
    $("zoomImg").alt = cap || "ภาพขนาดใหญ่";
    $("zoomCap").textContent = cap || "";
    window.SVAccount.openModal("zoomModal");
  }

  // ---------- เก็บ/คืนข้อมูลระหว่าง OAuth redirect ----------
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("sv-pending", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(value) {
    const db = await idb();
    await new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(value, "pending"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function idbTake() {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction("files", "readwrite");
      const store = tx.objectStore("files");
      const get = store.get("pending");
      get.onsuccess = () => { store.delete("pending"); res(get.result || null); };
      tx.onerror = () => rej(tx.error);
    });
  }

  async function savePending() {
    const fields = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "radio") { if (el.checked) fields[el.name] = el.value; } else fields[el.name] = el.value;
    }
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ts: Date.now(), fields, refs: state.refs }));
      if (state.refFiles.length || state.storefront) await idbSet({ ts: Date.now(), refFiles: state.refFiles, storefront: state.storefront });
    } catch { /* โหมดส่วนตัว/พื้นที่เต็ม — ลูกค้าอาจต้องเลือกไฟล์ใหม่ */ }
  }

  async function restorePending() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); sessionStorage.removeItem(PENDING_KEY); } catch { saved = null; }
    if (!saved || Date.now() - saved.ts > PENDING_TTL) return false;
    for (const [name, value] of Object.entries(saved.fields || {})) {
      const els = form.elements[name];
      if (!els) continue;
      if (els instanceof RadioNodeList) [...els].forEach((r) => { r.checked = r.value === value; });
      else els.value = value;
    }
    state.refs = Array.isArray(saved.refs) ? saved.refs.slice(0, MAX_REFS) : [];
    let filesRestored = true;
    try {
      const files = await idbTake();
      if (files && Date.now() - files.ts <= PENDING_TTL) {
        state.refFiles = (files.refFiles || []).slice(0, MAX_REFS - state.refs.length);
        state.storefront = files.storefront || null;
      }
    } catch { filesRestored = false; }
    renderFiles();
    state.restored = filesRestored ? "ok" : "no_files";
    renderRestoredNotice(window.SVAccount.state);
    root.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }

  // ข้อความหลังกลับจากหน้าล็อกอิน — ไม่ชวนกดปุ่มถ้าระบบยังไม่เปิดให้ผู้ใช้นี้
  function renderRestoredNotice(acc) {
    if (!state.restored || !acc.loaded) return;
    const canGo = acc.aiAvailable;
    showNotice(state.restored === "ok"
      ? (canGo ? "ข้อมูลที่กรอกไว้ยังอยู่ครบ กด \"สร้างภาพป้ายด้วย AI ฟรี\" เพื่อเริ่มได้เลย" : "ข้อมูลที่กรอกไว้ยังอยู่ครบ")
      : "ข้อมูลที่กรอกไว้ยังอยู่ แต่ระบบเก็บรูปที่อัปโหลดไว้ไม่ได้ กรุณาเลือกรูปอีกครั้ง");
  }

  window.SVAccount.beforeLogin(savePending);

  // ---------- ย่อรูปก่อนอัปโหลด (ลบ EXIF/GPS ไปในตัว) ----------
  async function resizeToBase64(file, maxSide = 1600, quality = 0.85) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  }

  async function api(url, body) {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"), { code: data.code, status: r.status });
    return data;
  }

  // ---------- สถานะขั้นตอน (ไม่แสดง % ปลอม) ----------
  function setStep(step) {
    const order = ["check", "style", "artwork", "mockup", "done"];
    const list = $("aiSteps");
    list.hidden = !step;
    const idx = order.indexOf(step);
    list.querySelectorAll("li").forEach((li) => {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle("is-done", i < idx || step === "done");
      li.classList.toggle("is-active", i === idx && step !== "done");
    });
  }

  function setBusy(b) {
    state.busy = b;
    genBtn.disabled = b || ["coming_soon", "guest_limit"].includes(window.SVAccount.state.aiStatus);
    genLabel.textContent = b ? "กำลังสร้างภาพ…" : genLabelFor(window.SVAccount.state);
  }

  // ---------- สถานะ AI (มาจาก Server: /api/me → aiStatus) ----------
  // ส่วนนี้แสดงเสมอ แต่ไม่สร้างภาพปลอมให้ลูกค้า และไม่อัปโหลดรูปจนกว่าระบบพร้อมและลูกค้ากดสร้างเอง
  function renderStatus(acc) {
    const st = acc.aiStatus || (acc.user ? "coming_soon" : "login_required");
    const text = {
      ready: "✔ ระบบสร้างภาพ AI พร้อมใช้งาน",
      mock_test: "โหมดทดสอบระบบ (เฉพาะทีมงาน) — ผลลัพธ์เป็นภาพตัวอย่าง ไม่ใช่ภาพจาก AI จริง และไม่ใช้สิทธิ์ของลูกค้า",
      login_required: acc.aiReady
        ? "เข้าสู่ระบบด้วย Facebook หรือเบอร์โทรศัพท์ เพื่อใช้สิทธิ์สร้างภาพป้ายฟรี 1 ครั้ง (Artwork + Mockup)"
        : "ระบบสร้างภาพ AI กำลังเตรียมเปิดบริการ — กรอกข้อมูลและเลือกรูปไว้ก่อนได้ หรือเข้าสู่ระบบไว้รอรับสิทธิ์ฟรี 1 ครั้ง",
      coming_soon: "ระบบสร้างภาพ AI กำลังเตรียมเปิดบริการ — ยังไม่มีการอัปโหลดรูปหรือใช้สิทธิ์ของคุณ ระหว่างนี้ทักทีมงานทาง LINE เพื่อออกแบบป้ายได้เลย",
      guest_ready: "✔ สร้างภาพป้ายด้วย AI ได้ฟรีทันที ไม่ต้องสมัครสมาชิก",
      guest_limit: acc.guest && acc.guest.paused
        ? "ระบบสร้างภาพฟรีปิดชั่วคราว ระหว่างนี้ทักทีมงานทาง LINE เพื่อออกแบบป้ายได้เลย"
        : "วันนี้คุณสร้างภาพฟรีครบจำนวนแล้ว ลองใหม่พรุ่งนี้ หรือทักทีมงานทาง LINE เพื่อออกแบบต่อได้เลย",
    }[st] || "";
    statusBox.textContent = text;
    statusBox.dataset.state = st;
    statusBox.hidden = !text;
    if (!state.busy) {
      genBtn.disabled = st === "coming_soon" || st === "guest_limit";
      genLabel.textContent = genLabelFor(acc);
    }
    genBtn.title = st === "coming_soon" ? "ระบบกำลังเตรียมเปิดบริการ" : "";
  }

  function renderQuota() {
    const acc = window.SVAccount.state;
    const q = acc.quota;
    const el = $("aiQuota");
    if (!acc.user && acc.aiStatus === "guest_ready" && acc.guest) {
      el.hidden = false;
      el.textContent = `ฟรี ไม่ต้องสมัครสมาชิก · วันนี้สร้างได้อีก ${acc.guest.remainingToday} ครั้ง`;
      return;
    }
    if (!acc.user || !q) { el.hidden = true; return; }
    el.hidden = false;
    const who = window.SVAccount.state.user.name ? `${window.SVAccount.state.user.name} · ` : "";   // ชื่อ LINE หรือเบอร์ที่ปิดบัง
    el.textContent = who + (q.remaining > 0 ? `สิทธิ์ทดลองฟรีคงเหลือ ${q.remaining} ครั้ง` : "ใช้สิทธิ์ทดลองฟรีครบแล้ว");
  }

  // ---------- Turnstile (ถ้าเปิดใช้) ----------
  let turnstileReady = null;
  function ensureTurnstile() {
    const key = window.SVAccount.state.turnstileSiteKey;
    if (!key) return Promise.resolve(null);
    if (!turnstileReady) {
      turnstileReady = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.async = true;
        s.onload = () => {
          const box = $("turnstileBox");
          box.hidden = false;
          resolve(window.turnstile.render(box, { sitekey: key }));
        };
        document.head.appendChild(s);
      });
    }
    return turnstileReady;
  }
  // ---------- สร้างภาพ ----------
  function validate(d) {
    if (!d.shopName && !d.signText) return "กรุณากรอกชื่อร้าน หรือข้อความบนป้าย ในฟอร์มด้านบน";
    if (!(Number(d.widthCm) > 0 && Number(d.heightCm) > 0)) return "กรุณากรอกความกว้างและความสูงของป้าย (เซนติเมตร) ในฟอร์มด้านบน";
    return "";
  }

  function idemKey() {
    // ใช้ key เดิมถ้ากดซ้ำหลังเน็ตหลุด → Server ไม่หักสิทธิ์ซ้ำ
    let k = sessionStorage.getItem("sv_ai_idem");
    if (!k) { k = crypto.randomUUID().replace(/-/g, ""); sessionStorage.setItem("sv_ai_idem", k); }
    return k;
  }

  async function runSteps(job) {
    let current = job;
    for (const step of ["artwork", "mockup"]) {
      if (current[step].status === "done") continue;
      setStep(step);
      const r = await api("/api/ai", { action: "step", jobId: current.jobId, step });
      current = r.job;
      if (r.quota) window.SVAccount.state.quota = r.quota;
      renderQuota();
      showJob(current);
      if (current[step].status !== "done") throw Object.assign(new Error(step === "artwork" ? "สร้าง Artwork ไม่สำเร็จ" : "สร้าง Mockup ไม่สำเร็จ"), { code: current.errorCode });
    }
    setStep("done");
    return current;
  }

  genBtn.addEventListener("click", async () => {
    if (state.busy) return;
    showError("");
    showNotice("");
    const d = readForm();
    const invalid = validate(d);
    if (invalid) { showError(invalid); form.scrollIntoView({ behavior: "smooth" }); return; }

    const acc = await window.SVAccount.refresh();
    const guest = !acc.user && isGuestMode(acc);          // โหมด Guest: ไม่ต้องล็อกอิน (Server ตรวจสิทธิ์อีกชั้น)
    if (!acc.user && !guest) { await savePending(); window.SVAccount.openLogin(); return; }
    renderStatus(acc);
    if (acc.aiStatus === "guest_limit") return;
    if (!acc.aiAvailable) { showNotice("ระบบสร้างภาพ AI กำลังเตรียมเปิดบริการ ยังไม่มีการอัปโหลดรูปหรือใช้สิทธิ์ของคุณ ระหว่างนี้ทักทีมงานทาง LINE ได้เลย"); return; }
    if (state.job && ["partial", "processing"].includes(state.job.status)) return resume();   // ทำภาพที่เหลือต่อ ไม่ใช้สิทธิ์ใหม่
    if (!guest && acc.quota && acc.quota.remaining <= 0) { window.SVAccount.openModal("quotaModal"); return; }

    setBusy(true);
    try {
      setStep("check");
      const widget = await ensureTurnstile();
      const turnstileToken = widget != null ? window.turnstile.getResponse(widget) : undefined;
      if (widget != null && !turnstileToken) throw new Error("กรุณายืนยันว่าไม่ใช่บอทก่อนสร้างภาพ");

      setStep("style");
      const uploads = [];
      for (const f of state.refFiles) uploads.push((await api("/api/upload", { kind: "reference", data: await resizeToBase64(f) })).uploadId);
      const storefront = state.storefront ? (await api("/api/upload", { kind: "storefront", data: await resizeToBase64(state.storefront) })).uploadId : null;

      const created = await api("/api/ai", {
        action: "create",
        idempotencyKey: idemKey(),
        input: d,
        references: state.refs.map((r) => r.id),
        uploads,
        storefront,
        turnstileToken,
      });
      state.job = created.job;
      if (created.quota) window.SVAccount.state.quota = created.quota;
      if (created.guest) window.SVAccount.state.guest = { ...window.SVAccount.state.guest, ...created.guest };
      renderQuota();
      state.job = await runSteps(created.job);
      sessionStorage.removeItem("sv_ai_idem");
    } catch (err) {
      setStep(null);
      if (err.code === "quota_exhausted") { window.SVAccount.openModal("quotaModal"); }
      else if (err.code === "unauthenticated" && !guest) { await savePending(); window.SVAccount.openLogin(); }
      else if (["guest_limit", "guest_daily_full", "guest_paused"].includes(err.code)) { showError(err.message); window.SVAccount.refresh(); }
      else showError(err.message);
      if (window.turnstile && turnstileReady) turnstileReady.then((w) => w != null && window.turnstile.reset(w));
    } finally {
      setBusy(false);
    }
  });

  async function resume() {
    setBusy(true);
    showError("");
    try {
      state.job = await runSteps(state.job);
    } catch (err) {
      setStep(null);
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // ---------- แสดงผล ----------
  async function loadArtwork(url, widthCm, heightCm) {
    const blob = await (await fetch(url, { credentials: "same-origin" })).blob();
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    state.images.artwork = img;
    drawArtwork(img, widthCm, heightCm);
  }

  // กรอบ + ตัวเลขขนาด (กว้างด้านบน / สูงด้านขวา) จากข้อมูลจริง — ไม่ให้ AI สร้างตัวเลขเอง
  function drawArtwork(img, widthCm, heightCm) {
    const c = $("artworkCanvas");
    const ctx = c.getContext("2d");
    const pad = { left: 40, top: 100, right: 124, bottom: 26 };
    const w = 1536, h = 1024;
    c.width = pad.left + w + pad.right;
    c.height = pad.top + h + pad.bottom;
    ctx.fillStyle = "#8E9299";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, pad.left, pad.top, w, h);
    ctx.strokeStyle = "#FFFFFF";
    ctx.fillStyle = "#FFFFFF";
    ctx.lineWidth = 2;
    const fmt = (n) => `${Number(n).toLocaleString("th-TH", { maximumFractionDigits: 1 })} ซม.`;
    // ความกว้าง (บน)
    const y = 62;
    ctx.beginPath();
    ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + w, y);
    ctx.moveTo(pad.left, y - 14); ctx.lineTo(pad.left, y + 14);
    ctx.moveTo(pad.left + w, y - 14); ctx.lineTo(pad.left + w, y + 14);
    ctx.stroke();
    ctx.font = "600 34px Prompt, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(fmt(widthCm), pad.left + w / 2, y - 12);
    // ความสูง (ขวา)
    const x = pad.left + w + 62;
    ctx.beginPath();
    ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + h);
    ctx.moveTo(x - 14, pad.top); ctx.lineTo(x + 14, pad.top);
    ctx.moveTo(x - 14, pad.top + h); ctx.lineTo(x + 14, pad.top + h);
    ctx.stroke();
    ctx.save();
    ctx.translate(x + 16, pad.top + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "top";
    ctx.fillText(fmt(heightCm), 0, 0);
    ctx.restore();
  }

  async function showJob(job) {
    if (!job) return;
    state.job = job;
    const anyDone = job.artwork.status === "done" || job.mockup.status === "done";
    $("aiResult").hidden = !anyDone;
    // ผลจาก Mock (ทดสอบระบบ) ต้องบอกชัดว่าไม่ใช่ AI จริง
    $("aiPreviewBadge").hidden = !job.preview;
    const retryArt = root.querySelector('[data-act="retry"][data-target="artwork"]');
    const retryMock = root.querySelector('[data-act="retry"][data-target="mockup"]');
    retryArt.hidden = !["failed", "unknown"].includes(job.artwork.status) || job.status === "failed";
    retryMock.hidden = !(job.artwork.status === "done" && ["failed", "unknown", "pending"].includes(job.mockup.status));
    if (job.artwork.url && !state.images.artwork) await loadArtwork(job.artwork.url, job.widthCm, job.heightCm).catch(() => {});
    if (job.mockup.url && !state.images.mockup) {
      try {
        const blob = await (await fetch(job.mockup.url, { credentials: "same-origin" })).blob();
        state.images.mockup = URL.createObjectURL(blob);
        $("mockupImg").src = state.images.mockup;
      } catch { /* แสดงปุ่มลองใหม่ */ }
    }
  }

  root.addEventListener("click", async (e) => {
    const tab = e.target.closest(".airesult__tab");
    if (tab) {
      root.querySelectorAll(".airesult__tab").forEach((t) => { t.classList.toggle("is-active", t === tab); t.setAttribute("aria-selected", String(t === tab)); });
      root.querySelectorAll(".airesult__panel").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const target = act.dataset.target;
    if (act.dataset.act === "zoom") {
      if (target === "artwork") zoom($("artworkCanvas").toDataURL("image/png"), "Artwork หน้าตรง");
      else if (state.images.mockup) zoom(state.images.mockup, "Mockup หน้าร้าน (ภาพจำลอง)");
    }
    if (act.dataset.act === "download") {
      const a = document.createElement("a");
      if (target === "artwork") {
        a.href = $("artworkCanvas").toDataURL("image/png");    // PNG รวมกรอบและตัวเลขขนาด
        a.download = "signverse-artwork.png";
      } else if (state.images.mockup) {
        a.href = state.images.mockup;
        a.download = "signverse-mockup";
      } else return;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    if (act.dataset.act === "retry" && state.job && !state.busy) {
      if (target === "artwork") state.images.artwork = null;
      resume();
    }
  });

  // ---------- สั่งผลิตป้ายนี้ → บันทึกออร์เดอร์ + เปิดแชต LINE OA ให้ลูกค้ากดส่งเอง ----------
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  let currentOrder = null;

  async function copyOrderText() {
    if (!currentOrder) return false;
    try { await navigator.clipboard.writeText(currentOrder.lineText); return true; } catch { return false; }
  }

  // สถานะตามผลจริงจาก Server: บันทึกแล้ว → รอส่งผ่าน LINE → ส่งผ่าน LINE สำเร็จ (= LINE รับข้อความแล้ว)
  function renderDeliveryStatus(order) {
    const d = order.lineDelivery || { status: "awaiting_customer" };
    const el = $("orderStatus");
    el.dataset.state = d.status;
    el.textContent = {
      awaiting_customer: "✔ บันทึกออร์เดอร์แล้ว · ⏳ รอส่งผ่าน LINE (กรุณากดส่งข้อความในแชต @signverse)",
      sending: "✔ บันทึกออร์เดอร์แล้ว · ⏳ กำลังส่งแบบเข้าแชต LINE…",
      sent: "✔ บันทึกออร์เดอร์แล้ว · ✔ ส่งผ่าน LINE สำเร็จ — ภาพ Artwork และ Mockup ถูกส่งเข้าแชตของคุณแล้ว ทีมงานจะตอบกลับในแชตนี้",
      failed: "✔ บันทึกออร์เดอร์แล้ว · ⚠️ ส่งแบบเข้าแชตไม่สำเร็จ กรุณาส่งข้อความเดิมในแชตอีกครั้ง",
    }[d.status] || "✔ บันทึกออร์เดอร์แล้ว";
    if (d.status === "sent") {
      $("orderNote").textContent = "ข้อความของคุณและภาพแบบป้ายอยู่ในแชต LINE @signverse แล้ว ไม่ต้องส่งซ้ำ";
      $("orderSteps").hidden = true;
    }
  }

  let pollTimer = null;
  function pollDelivery() {
    clearInterval(pollTimer);
    const started = Date.now();
    pollTimer = setInterval(async () => {
      if (!currentOrder || Date.now() - started > 5 * 60 * 1000) return clearInterval(pollTimer);
      try {
        const { orders } = await api("/api/ai?orders=1");
        const fresh = orders.find((o) => o.orderId === currentOrder.orderId);
        if (fresh) { currentOrder = fresh; renderDeliveryStatus(fresh); if (fresh.lineDelivery.status === "sent") clearInterval(pollTimer); }
      } catch { /* ลองใหม่รอบถัดไป */ }
    }, 5000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && currentOrder && currentOrder.lineDelivery?.status !== "sent") pollDelivery(); });

  function renderOrder(order) {
    currentOrder = order;
    $("orderBox").hidden = false;
    $("orderNo").textContent = order.orderNo;
    renderDeliveryStatus(order);
    $("orderText").textContent = order.lineText;
    const steps = isMobile
      ? ["กด \"เปิดแชต LINE @signverse\" — ระบบเติมข้อความให้ในช่องพิมพ์", "กดส่งข้อความในแชตเพื่อยืนยันคำสั่งผลิต (ห้ามลบบรรทัด รหัสยืนยัน)", "LINE OA จะส่งภาพ Artwork และ Mockup กลับมาในแชตเดียวกัน แล้วทีมงานจะตอบกลับในแชตนั้น"]
      : ["LINE บนคอมพิวเตอร์ไม่รองรับการเติมข้อความอัตโนมัติ — กด \"คัดลอกข้อความ\"", "เปิดแชต LINE @signverse (บนมือถือหรือ LINE PC) แล้ววางข้อความ จากนั้นกดส่ง (ห้ามลบบรรทัด รหัสยืนยัน)", "LINE OA จะส่งภาพ Artwork และ Mockup กลับมาในแชตเดียวกัน แล้วทีมงานจะตอบกลับในแชตนั้น"];
    $("orderSteps").replaceChildren(...steps.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    $("orderOpenLine").href = isMobile ? order.line.chatWithText : order.line.profile;
    $("orderBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  $("aiOrder").addEventListener("click", async () => {
    const btn = $("aiOrder");
    if (btn.disabled) return;
    const d = readForm();
    const invalid = validate(d);
    if (invalid) { showError(invalid); return; }
    const acc = await window.SVAccount.refresh();
    if (!acc.user) { await savePending(); window.SVAccount.openLogin(); return; }
    btn.disabled = true;
    try {
      // key ต่องาน → กดซ้ำได้เลขออร์เดอร์เดิม ไม่สร้างออร์เดอร์ซ้ำ
      const keyName = `sv_order_idem_${state.job ? state.job.jobId : "nojob"}`;
      let key = sessionStorage.getItem(keyName);
      if (!key) { key = crypto.randomUUID().replace(/-/g, ""); sessionStorage.setItem(keyName, key); }
      const r = await api("/api/ai", { action: "order", idempotencyKey: key, input: d, jobId: state.job ? state.job.jobId : null });
      renderOrder(r.order);
      if (r.order.lineDelivery && r.order.lineDelivery.status === "sent") return;   // ส่งไปแล้ว ไม่ต้องคัดลอก/ส่งซ้ำ
      const copied = await copyOrderText();
      $("orderNote").textContent = copied
        ? "คัดลอกข้อความแล้ว · ระบบยังไม่ได้ส่งข้อความแทนคุณ — กรุณากดส่งในแชต LINE เพื่อยืนยันคำสั่งผลิต"
        : "ระบบยังไม่ได้ส่งข้อความแทนคุณ — กรุณากดส่งในแชต LINE เพื่อยืนยันคำสั่งผลิต";
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("orderCopy").addEventListener("click", async () => {
    $("orderNote").textContent = (await copyOrderText())
      ? "คัดลอกข้อความแล้ว เปิดแชต LINE @signverse แล้ววาง จากนั้นกดส่ง"
      : "คัดลอกอัตโนมัติไม่สำเร็จ กรุณาเลือกข้อความในกรอบด้านบนแล้วคัดลอกเอง";
  });
  // ลิงก์เปิด LINE: คัดลอกข้อความไว้ด้วยเสมอ (กันกรณีแอปไม่รับข้อความที่เติมให้)
  $("orderOpenLine").addEventListener("click", () => { copyOrderText(); pollDelivery(); });

  $("quotaViewMine").addEventListener("click", () => {
    window.SVAccount.closeModal("quotaModal");
    if (!$("aiResult").hidden) $("aiResult").scrollIntoView({ behavior: "smooth" });
    else showNotice("ยังไม่มีแบบที่สร้างสำเร็จในบัญชีนี้");
  });

  // ---------- เริ่มต้น ----------
  window.SVAccount.onChange(async (acc) => {
    // แสดงส่วน AI เสมอ — ปุ่มและข้อความทำงานตามสถานะจาก Server
    renderStatus(acc);
    renderRestoredNotice(acc);
    // ปุ่มสั่งผลิตผ่าน LINE: แสดงเฉพาะเมื่อเปิดให้บัญชีนี้ใช้ (ช่วงทดสอบ = เฉพาะพนักงาน) · ไม่งั้นแสดงปุ่มติดต่อร้านทาง LINE
    $("aiOrder").hidden = !acc.lineOrders;
    $("aiContactLine").hidden = acc.lineOrders;
    renderQuota();
    if ((acc.user || isGuestMode(acc)) && !state.job) {
      try {
        const { jobs } = await api("/api/ai");
        const latest = jobs.find((j) => ["completed", "partial", "processing"].includes(j.status));
        if (latest) showJob(latest);
      } catch { /* ยังไม่ตั้งค่าระบบ */ }
    }
  });

  renderStatus(window.SVAccount.state);
  loadAlbums();
  restorePending();
  renderPicked();
})();
