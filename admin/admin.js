/* =========================================================
   SIGN VERSE — หลังบ้านพนักงาน
   ทุกการกระทำถูกตรวจ Session + Role ที่ Server (/api/admin) — หน้านี้แค่แสดงผล
   ========================================================= */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    kids.flat().forEach((c) => n.append(c instanceof Node ? c : document.createTextNode(String(c ?? ""))));
    return n;
  };
  const PROVIDER_LABELS = { line: "เข้าสู่ระบบด้วย LINE", phone: "เข้าสู่ระบบด้วยเบอร์โทรศัพท์", facebook: "เข้าสู่ระบบด้วย Facebook" };
  const fmtDate = (d) => (d ? new Date(d).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "-");

  let me = null;
  let lineFlags = {};   // groupOrdersEnabled = false → ซ่อนปุ่มส่งเข้ากลุ่มทั้งหมด
  let mock = false;
  let albums = [];
  let currentAlbum = null;
  let imagePage = 0;

  // ---------- API ----------
  async function api(action, body, params = {}) {
    const qs = new URLSearchParams({ action, ...params }).toString();
    const r = await fetch(body ? "/api/admin" : `/api/admin?${qs}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify({ action, ...body }) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || "เกิดข้อผิดพลาด"), { status: r.status });
    return data;
  }
  function flash(msg, error = false) {
    const f = $("flash");
    f.textContent = msg;
    f.className = "msg" + (error ? " msg--error" : "");
    f.hidden = false;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { f.hidden = true; }, 4000);
  }
  async function act(fn, okMsg) {
    try { const r = await fn(); if (okMsg) flash(okMsg); return r; }
    catch (e) { flash(e.message, true); return null; }
  }

  // ---------- เข้าสู่ระบบ ----------
  async function boot() {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    const data = r.ok ? await r.json() : { providers: [] };
    me = data.user;
    mock = data.mock;
    if (!me || !["staff", "admin"].includes(me.role)) return showGate(data);
    $("userBox").hidden = false;
    $("userName").textContent = `${me.name} · ${me.role === "admin" ? "ผู้ดูแล" : "พนักงาน"}`;
    $("app").hidden = false;
    try { lineFlags = await api("lineStatus"); } catch { lineFlags = {}; }
    loadDash();
    loadAlbums();
  }

  function showGate(data) {
    $("gate").hidden = false;
    const box = $("gateProviders");
    box.replaceChildren();
    if (me) {
      $("gateText").textContent = "บัญชีนี้ไม่มีสิทธิ์พนักงาน กรุณาติดต่อผู้ดูแลระบบ";
      $("userBox").hidden = false;
      $("userName").textContent = me.name;
      return;
    }
    if (mock) {
      ["staff", "admin"].forEach((role) => box.append(el("button", { class: "btn btn--primary", type: "button", onclick: () => mockLogin(role) }, `เข้าสู่ระบบทดสอบ (${role})`)));
      return;
    }
    // เบอร์โทร + OTP ทำที่หน้าหลัก (Session เดียวกัน) แล้วกลับมาหน้านี้
    (data.providers || []).forEach((p) => box.append(el("button", { class: "btn btn--primary", type: "button", onclick: () => signIn(p) }, PROVIDER_LABELS[p] || p)));
    if (data.phoneLogin === "ready") box.append(el("a", { class: "btn btn--primary", href: "/#login" }, PROVIDER_LABELS.phone));
    if (!(data.providers || []).length && data.phoneLogin !== "ready") $("gateText").textContent = "ระบบเข้าสู่ระบบยังไม่ได้ตั้งค่าบนเซิร์ฟเวอร์";
  }
  async function mockLogin(role) {
    await fetch("/api/me?mock=login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    location.reload();
  }
  async function signIn(provider) {
    try {
      const r = await fetch("/api/auth/sign-in/social", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, callbackURL: location.href }) });
      const d = await r.json();
      if (!d.url) throw new Error();
      location.assign(d.url);
    } catch {
      $("gateError").textContent = "เข้าสู่ระบบไม่สำเร็จ";
      $("gateError").hidden = false;
    }
  }
  $("logoutBtn").addEventListener("click", async () => {
    if (mock) await fetch("/api/me?mock=logout", { method: "POST" });
    else await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.reload();
  });

  // ---------- แท็บ ----------
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
    document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    ({ orders: () => loadOrders(0), dash: loadDash, gallery: () => loadImages(0), trash: loadTrash, quota: () => { loadUsers(""); loadProblems(); }, line: loadLine, audit: loadAudit })[t.dataset.tab]?.();
  });

  async function loadDash() {
    const d = await act(() => api("dashboard"));
    if (!d) return;
    const s = $("stats");
    s.replaceChildren(
      ...[["อัลบั้ม", d.albums], ["รูปทั้งหมด", d.images], ["เผยแพร่แล้ว", d.published], ["ในถังขยะ", d.trash], ["งาน AI ที่ต้องตรวจสอบ", d.problemJobs]]
        .map(([k, v]) => el("div", { class: "stat" }, el("strong", {}, v), k))
    );
  }

  // ---------- อัลบั้ม ----------
  async function loadAlbums() {
    const d = await act(() => api("albums"));
    if (!d) return;
    albums = d.albums;
    const list = $("albumList");
    list.replaceChildren(...albums.map((a) => el("li", {}, el("button", {
      type: "button", class: a.id === currentAlbum ? "is-active" : "", onclick: () => selectAlbum(a.id),
    }, a.title, el("br"), el("small", {}, `${a.imageCount ?? 0} รูป · ${a.published ? "เผยแพร่" : "ยังไม่เผยแพร่"}`)))));
    const filter = $("albumFilter");
    const keep = filter.value;
    filter.replaceChildren(el("option", { value: "" }, "ทุกอัลบั้ม"), ...albums.map((a) => el("option", { value: a.id }, a.title)));
    filter.value = keep;
  }

  function selectAlbum(id) {
    currentAlbum = id;
    const a = albums.find((x) => x.id === id);
    const f = $("albumEdit");
    f.title.value = a.title;
    f.description.value = a.description || "";
    f.published.checked = a.published;
    $("albumDetail").hidden = false;
    $("albumFilter").value = id;
    loadAlbums();
    loadImages(0);
  }

  $("albumForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await act(() => api("createAlbum", { title: f.title.value, description: f.description.value }), "สร้างอัลบั้มแล้ว");
    if (r) { f.reset(); await loadAlbums(); selectAlbum(r.album.id); }
  });
  $("albumEdit").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await act(() => api("updateAlbum", { id: currentAlbum, title: f.title.value, description: f.description.value, published: f.published.checked }), "บันทึกอัลบั้มแล้ว");
    loadAlbums();
  });
  $("albumDelete").addEventListener("click", async () => {
    if (!confirm("ลบอัลบั้มนี้? (ต้องย้ายหรือลบรูปในอัลบั้มออกก่อน)")) return;
    const r = await act(() => api("deleteAlbum", { id: currentAlbum }), "ลบอัลบั้มแล้ว");
    if (r) { currentAlbum = null; $("albumDetail").hidden = true; loadAlbums(); loadImages(0); }
  });

  // ---------- อัปโหลด: ย่อรูป + สร้าง thumbnail ในเบราว์เซอร์ (ลบ EXIF/GPS ไปด้วย) ----------
  async function encode(bitmap, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bitmap.width * scale);
    c.height = Math.round(bitmap.height * scale);
    c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
    let url = c.toDataURL("image/webp", quality);
    if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", quality);   // เบราว์เซอร์ที่ไม่รองรับ WebP
    return url;
  }
  $("imageUpload").addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, 30);
    e.target.value = "";
    if (!currentAlbum || !files.length) return;
    const status = $("uploadStatus");
    status.hidden = false;
    let ok = 0;
    for (const [i, f] of files.entries()) {
      status.textContent = `กำลังอัปโหลด ${i + 1}/${files.length}: ${f.name}`;
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size > 25 * 1024 * 1024) { flash(`ข้าม ${f.name}: ไฟล์ไม่รองรับหรือใหญ่เกินไป`, true); continue; }
      try {
        const bmp = await createImageBitmap(f);
        let data = await encode(bmp, 2000, 0.85);
        if (data.length * 0.75 > 2.9 * 1024 * 1024) data = await encode(bmp, 1600, 0.75);
        const thumb = await encode(bmp, 480, 0.75);
        const title = f.name.replace(/\.[^.]+$/, "").slice(0, 160);
        await api("uploadImage", { albumId: currentAlbum, data, thumb, title, alt: title });
        ok++;
      } catch (err) { flash(`อัปโหลด ${f.name} ไม่สำเร็จ: ${err.message}`, true); }
    }
    status.textContent = `อัปโหลดสำเร็จ ${ok}/${files.length} รูป (ยังไม่เผยแพร่ — กด "เผยแพร่" ที่รูปเพื่อให้ลูกค้าเห็น)`;
    loadAlbums();
    loadImages(0);
  });

  // ---------- รูป ----------
  let searchTimer;
  $("imageSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadImages(0), 300); });
  $("albumFilter").addEventListener("change", () => loadImages(0));
  $("imageMore").addEventListener("click", () => loadImages(imagePage + 1));

  async function loadImages(page) {
    imagePage = page;
    const d = await act(() => api("images", null, { album: $("albumFilter").value, search: $("imageSearch").value, page }));
    if (!d) return;
    const grid = $("imageGrid");
    if (page === 0) grid.replaceChildren();
    if (!d.images.length && page === 0) grid.append(el("p", { class: "hint" }, "ยังไม่มีรูป"));
    d.images.forEach((img) => grid.append(imageCard(img)));
    $("imageMore").hidden = !d.hasMore;
  }

  function imageCard(img) {
    const album = albums.find((a) => a.id === img.albumId);
    const isCover = album && album.coverImageId === img.id;
    const title = el("input", { value: img.title, maxlength: 160, "aria-label": "ชื่อรูป" });
    const alt = el("input", { value: img.alt, maxlength: 300, placeholder: "คำอธิบายภาพ (Alt)", "aria-label": "คำอธิบายภาพ" });
    const move = el("select", { "aria-label": "ย้ายไปอัลบั้ม" }, ...albums.map((a) => el("option", { value: a.id, selected: a.id === img.albumId }, a.title)));
    const order = el("input", { type: "number", value: img.sortOrder, "aria-label": "ลำดับ", style: "width:70px" });
    return el("div", { class: "img" },
      el("img", { src: img.thumbUrl, alt: img.alt || img.title, loading: "lazy", onerror: (e) => { e.target.style.opacity = ".3"; } }),
      el("div", { class: "img__body" },
        el("div", { class: "inline" },
          el("span", { class: `badge ${img.published ? "badge--on" : "badge--off"}` }, img.published ? "เผยแพร่" : "ซ่อน"),
          isCover ? el("span", { class: "badge badge--cover" }, "ภาพปก") : ""),
        title, alt,
        el("div", { class: "inline" }, move, order),
        el("div", { class: "img__actions" },
          el("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => {
            await act(() => api("updateImage", { id: img.id, title: title.value, alt: alt.value, albumId: move.value, sortOrder: order.value }), "บันทึกรูปแล้ว");
            loadAlbums(); loadImages(0);
          } }, "บันทึก"),
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: async () => {
            await act(() => api("publishImage", { id: img.id, published: !img.published }), img.published ? "ซ่อนรูปแล้ว" : "เผยแพร่รูปแล้ว");
            loadAlbums(); loadImages(0);
          } }, img.published ? "ซ่อน" : "เผยแพร่"),
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: async () => {
            await act(() => api("updateAlbum", { id: img.albumId, coverImageId: img.id }), "ตั้งเป็นภาพปกแล้ว");
            await loadAlbums(); loadImages(0);
          } }, "ตั้งเป็นปก"),
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: () => window.open(img.fullUrl, "_blank", "noopener") }, "ดูภาพใหญ่"),
          el("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => {
            if (!confirm(`ย้าย "${img.title || "รูปนี้"}" ไปถังขยะ? (กู้คืนได้)`)) return;
            await act(() => api("deleteImage", { id: img.id }), "ย้ายไปถังขยะแล้ว");
            loadAlbums(); loadImages(0);
          } }, "ลบ"))));
  }

  async function loadTrash() {
    const d = await act(() => api("images", null, { trash: "1" }));
    if (!d) return;
    const grid = $("trashGrid");
    grid.replaceChildren(...(d.images.length ? d.images.map((img) => el("div", { class: "img" },
      el("img", { src: img.thumbUrl, alt: img.alt || img.title, loading: "lazy" }),
      el("div", { class: "img__body" },
        el("div", { class: "img__title" }, img.title || "-"),
        el("small", {}, `ลบเมื่อ ${fmtDate(img.deletedAt)}`),
        el("div", { class: "img__actions" },
          el("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => { await act(() => api("restoreImage", { id: img.id }), "กู้คืนแล้ว (สถานะซ่อน)"); loadTrash(); } }, "กู้คืน"),
          me.role === "admin" ? el("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => {
            if (!confirm("ลบถาวร? ไม่สามารถกู้คืนได้")) return;
            await act(() => api("purgeImage", { id: img.id }), "ลบถาวรแล้ว"); loadTrash();
          } }, "ลบถาวร") : "")))) : [el("p", { class: "hint" }, "ถังขยะว่าง")]));
  }

  // ---------- สิทธิ์ AI ----------
  $("userSearchForm").addEventListener("submit", (e) => { e.preventDefault(); loadUsers(e.target.search.value); });

  async function loadUsers(search) {
    const d = await act(() => api("users", null, { search }));
    if (!d) return;
    const tbody = $("userTable").querySelector("tbody");
    tbody.replaceChildren(...d.users.map((u) => {
      const q = u.quota || { total: "-", used: "-", remaining: "-" };
      const amount = el("input", { type: "number", min: 1, max: 20, value: 1, "aria-label": "จำนวนสิทธิ์" });
      const note = el("input", { placeholder: "หมายเหตุ", maxlength: 200, "aria-label": "หมายเหตุ" });
      const role = el("select", { "aria-label": "สิทธิ์บัญชี" }, ...["customer", "staff", "admin"].map((r) => el("option", { value: r, selected: r === u.role }, r)));
      return el("tr", {},
        el("td", {}, u.name || "-", el("br"), el("small", {}, u.email), el("br"), el("small", {}, `สมัคร ${fmtDate(u.createdAt)}`)),
        el("td", {}, (u.providers || []).join(", ") || "-"),
        el("td", {}, me.role === "admin" && u.id !== me.id
          ? el("div", { class: "inline" }, role, el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: async () => {
              if (!confirm(`เปลี่ยนสิทธิ์บัญชีนี้เป็น ${role.value}?`)) return;
              await act(() => api("setRole", { userId: u.id, role: role.value }), "เปลี่ยนสิทธิ์บัญชีแล้ว"); loadUsers(search);
            } }, "บันทึก"))
          : u.role),
        el("td", {}, `ใช้ ${q.used}/${q.total} · คงเหลือ ${q.remaining}`),
        el("td", {}, el("div", { class: "inline" },
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: () => loadUserJobs(u) }, "ดูงาน AI"),
          me.role === "admin" ? [amount, note, el("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => {
            if (!confirm(`เพิ่มสิทธิ์ ${amount.value} ครั้ง ให้ ${u.name || u.email}?`)) return;
            await act(() => api("grantCredits", { userId: u.id, amount: Number(amount.value), note: note.value }), "เพิ่มสิทธิ์แล้ว (บันทึกในประวัติ)");
            loadUsers(search);
          } }, "เพิ่มสิทธิ์")] : "")));
    }));
  }

  async function loadUserJobs(u) {
    const d = await act(() => api("userJobs", null, { user: u.id }));
    if (!d) return;
    const box = $("userJobs");
    box.hidden = false;
    box.replaceChildren(el("h2", {}, `งาน AI ของ ${u.name || u.email}`),
      d.jobs.length ? el("div", { class: "tablewrap" }, el("table", { class: "table" },
        el("thead", {}, el("tr", {}, ...["งาน", "สถานะ", "Artwork", "Mockup", "สิทธิ์", "สร้างเมื่อ", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, ...d.jobs.map((j) => el("tr", {},
          el("td", {}, j.jobId.slice(0, 8)), el("td", {}, j.status),
          el("td", {}, j.artwork.url ? el("a", { href: j.artwork.url, target: "_blank", rel: "noopener" }, j.artwork.status) : j.artwork.status),
          el("td", {}, j.mockup.url ? el("a", { href: j.mockup.url, target: "_blank", rel: "noopener" }, j.mockup.status) : j.mockup.status),
          el("td", {}, j.creditState), el("td", {}, fmtDate(j.createdAt)),
          el("td", {}, lineFlags.groupOrdersEnabled && j.artwork.status === "done" ? el("button", { class: "btn btn--sm btn--primary", type: "button", onclick: () => sendOrder(j) }, "ส่งคำสั่งผลิตเข้ากลุ่ม LINE") : "")))))) : el("p", { class: "hint" }, "ยังไม่มีงาน"));
  }

  async function loadProblems() {
    const d = await act(() => api("problemJobs"));
    if (!d) return;
    const rows = [...d.stuck.map((j) => ({ ...j, kind: "ค้าง/ไม่แน่ใจผล" })), ...d.failed.map((j) => ({ ...j, kind: "ล้มเหลว/บางส่วน" }))];
    const tbody = $("problemTable").querySelector("tbody");
    tbody.replaceChildren(...(rows.length ? rows.map((j) => el("tr", {},
      el("td", {}, j.jobId.slice(0, 8), el("br"), el("small", {}, fmtDate(j.updatedAt))),
      el("td", {}, el("small", {}, j.userId)),
      el("td", {}, `${j.kind}: ${j.status} (A:${j.artwork.status} / M:${j.mockup.status})`),
      el("td", {}, j.creditState),
      el("td", {}, me.role === "admin" && j.creditState === "reserved" ? el("div", { class: "inline" },
        el("button", { class: "btn btn--sm btn--primary", type: "button", onclick: async () => { if (confirm("ปิดงานและคืนสิทธิ์ให้ลูกค้า?")) { await act(() => api("resolveJob", { jobId: j.jobId, resolution: "refund" }), "คืนสิทธิ์แล้ว"); loadProblems(); } } }, "คืนสิทธิ์"),
        el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: async () => { if (confirm("ปิดงานโดยถือว่าใช้สิทธิ์แล้ว?")) { await act(() => api("resolveJob", { jobId: j.jobId, resolution: "close" }), "ปิดงานแล้ว"); loadProblems(); } } }, "ปิดงาน")) : ""))) : [el("tr", {}, el("td", { colspan: 5 }, "ไม่มีงานที่ต้องตรวจสอบ"))]));
  }

  // ---------- ออร์เดอร์ ----------
  const STATUS_TH = { new: "ใหม่", contacted: "ติดต่อแล้ว", confirmed: "ยืนยันแล้ว", in_production: "กำลังผลิต", completed: "เสร็จแล้ว", cancelled: "ยกเลิก" };
  const LIGHT_TH = { none: "ไม่ติดไฟ", white: "ไฟสีขาว", warm: "ไฟวอร์มไวท์" };
  const baht = (n) => (n ? `${Number(n).toLocaleString("th-TH")} บาท` : "รอประเมิน");
  let orderPage = 0;
  $("orderSearchForm").addEventListener("submit", (e) => { e.preventDefault(); loadOrders(0); });
  $("orderMore").addEventListener("click", () => loadOrders(orderPage + 1));

  async function loadOrders(page) {
    orderPage = page;
    const f = $("orderSearchForm");
    const d = await act(() => api("orders", null, { search: f.search.value, status: f.status.value, page }));
    if (!d) return;
    const tbody = $("orderTable").querySelector("tbody");
    if (page === 0) tbody.replaceChildren();
    if (!d.orders.length && page === 0) tbody.append(el("tr", {}, el("td", { colspan: 7 }, "ไม่พบออร์เดอร์")));
    d.orders.forEach((o) => tbody.append(el("tr", {},
      el("td", {}, el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: () => openOrder(o.orderId) }, o.orderNo)),
      el("td", {}, o.customer?.name || "-", el("br"), el("small", {}, o.customer?.email || "")),
      el("td", {}, o.form.shopName || o.form.signText || "-", el("br"), el("small", {}, `${o.form.widthCm}x${o.form.heightCm} ซม. · ${o.form.material || "-"}`)),
      el("td", {}, baht(o.priceEstimate)),
      el("td", {}, STATUS_TH[o.status] || o.status),
      el("td", {}, o.lineDelivery.label),
      el("td", {}, fmtDate(o.createdAt)))));
    $("orderMore").hidden = !d.hasMore;
  }

  async function openOrder(id) {
    const d = await act(() => api("order", null, { id }));
    if (!d) return;
    const o = d.order, f = o.form, job = d.job;
    const status = el("select", { "aria-label": "สถานะ" }, ...Object.entries(STATUS_TH).map(([k, v]) => el("option", { value: k, selected: k === o.status }, v)));
    const note = el("textarea", { rows: 2, maxlength: 1000, "aria-label": "บันทึกพนักงาน", style: "width:100%" }, o.staffNote || "");
    const img = (url, label) => url
      ? el("figure", { style: "margin:0" }, el("a", { href: url, target: "_blank", rel: "noopener" }, el("img", { src: url, alt: label, style: "width:100%;border-radius:10px;background:#eef" })), el("figcaption", { class: "hint" }, label))
      : el("p", { class: "hint" }, `${label}: ยังไม่มีภาพ`);
    const box = $("orderDetail");
    box.hidden = false;
    box.replaceChildren(
      el("h2", {}, `ออร์เดอร์ ${o.orderNo}`),
      el("p", {}, `ลูกค้า: ${o.customer?.name || "-"} (${o.customer?.email || "-"}) · สร้างเมื่อ ${fmtDate(o.createdAt)}`),
      el("div", { class: "tablewrap" }, el("table", { class: "table" }, el("tbody", {}, ...[
        ["ชื่อร้าน", f.shopName], ["ข้อความบนป้าย", f.signText], ["ขนาด", `${f.widthCm} x ${f.heightCm} ซม.`],
        ["วัสดุ", `${f.material || "-"} · ${f.layers === 2 ? "2 ชั้น" : "1 ชั้น"}`], ["ประเภทงาน", f.jobType], ["ระบบไฟ", LIGHT_TH[f.lighting] || f.lighting],
        ["โทนสี / สไตล์", `${f.colors || "-"} / ${f.style || "-"}`], ["งบประมาณ / วันที่ต้องการ", `${f.budget || "-"} / ${f.deadline || "-"}`],
        ["รายละเอียด", f.details], ["ราคาประเมิน (สูตรร้าน)", baht(o.priceEstimate)],
        ["ส่งผ่าน LINE", `${o.lineDelivery.label}${o.lineDelivery.requestId ? ` · Request ID ${o.lineDelivery.requestId}` : ""}${o.lineDelivery.channel ? ` (${o.lineDelivery.channel === "liff" ? "ลูกค้าส่งผ่าน LIFF" : "OA ตอบกลับพร้อมรูป"})` : ""}${o.lineDelivery.deliveredAt ? ` · ${fmtDate(o.lineDelivery.deliveredAt)}` : ""}${o.lineDelivery.error ? ` · ข้อผิดพลาด: ${o.lineDelivery.error}` : ""} · ผูกบัญชี LINE: ${o.lineDelivery.lineUserLinked ? "แล้ว" : "ยัง"}`],
      ].map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v || "-")))))),
      el("div", { class: "grid", style: "grid-template-columns:repeat(auto-fit,minmax(240px,1fr))" },
        img(job && job.artwork.url, "Artwork หน้าตรง"), img(job && job.mockup.url, "Mockup หน้าร้าน")),
      el("p", { class: "hint" }, "หมายเหตุ: \"ส่งผ่าน LINE สำเร็จ\" หมายถึง LINE รับข้อความแล้ว — ตรวจในแชต LINE OA ว่าเห็นข้อความของลูกค้า (ซึ่งมีเลขออร์เดอร์) และภาพที่ OA ส่งกลับหรือไม่"),
      el("h2", { class: "h2" }, "ข้อความที่ลูกค้าเตรียมส่งใน LINE"),
      el("pre", { class: "hint", style: "white-space:pre-wrap;background:#F4F7FC;padding:10px;border-radius:10px" }, o.lineText),
      el("div", { class: "form" }, el("label", {}, "สถานะ", status), el("label", {}, "บันทึกพนักงาน", note),
        el("div", { class: "form__actions" },
          el("button", { class: "btn btn--primary", type: "button", onclick: async () => {
            await act(() => api("updateOrder", { id: o.orderId, status: status.value, staffNote: note.value }), "บันทึกออร์เดอร์แล้ว");
            loadOrders(0);
          } }, "บันทึก"),
          lineFlags.groupOrdersEnabled && job && job.artwork.status === "done" ? el("button", { class: "btn btn--ghost", type: "button", onclick: () => sendOrder(job) }, "ส่งคำสั่งผลิตเข้ากลุ่ม LINE พนักงาน") : "")));
    box.scrollIntoView({ behavior: "smooth" });
  }

  // ---------- LINE ----------
  const retryKeys = {};   // งานเดียวกันกดซ้ำหลัง error → ใช้ key เดิม (ไม่ส่งซ้ำ)
  async function sendOrder(job) {
    const note = prompt("หมายเหตุถึงฝ่ายผลิต (ไม่บังคับ)", "") ;
    if (note === null) return;
    const price = prompt("ราคาที่ตกลงกับลูกค้า (บาท, เว้นว่างได้)", "");
    if (price === null) return;
    if (!confirm(`ยืนยันส่งคำสั่งผลิตงาน ${job.jobId.slice(0, 8)} เข้ากลุ่ม LINE พนักงาน?`)) return;
    retryKeys[job.jobId] = retryKeys[job.jobId] || crypto.randomUUID();
    const r = await act(() => api("sendProductionOrder", { jobId: job.jobId, note, agreedPrice: price.replace(/[^0-9.]/g, ""), retryKey: retryKeys[job.jobId] }));
    if (r) flash(r.duplicate ? "คำสั่งนี้ถูกส่งไปแล้ว (ไม่ส่งซ้ำ)" : r.mock ? "ส่งแบบจำลองแล้ว (Mock — ไม่ได้ส่งเข้า LINE จริง)" : `ส่งเข้ากลุ่ม ${r.group} แล้ว`);
  }

  async function loadLine() {
    const d = await act(() => api("lineStatus"));
    if (!d) return;
    const box = $("lineStatus");
    const rows = [
      ["LINE OA", d.oaId],
      ["Webhook (ตรวจลายเซ็น)", d.webhookReady ? "พร้อม" : "ยังไม่ตั้ง LINE_CHANNEL_SECRET"],
      ["ส่งรูปกลับในแชตลูกค้า (Reply)", d.mock ? "Mock (ไม่ส่งจริง)" : d.oaReplyReady ? "พร้อม" : "ยังไม่ตั้ง LINE_CHANNEL_ACCESS_TOKEN"],
      ["ลิงก์รูปสำหรับ LINE (FILE_SIGNING_SECRET)", d.imageLinksReady ? "พร้อม" : "ยังไม่ตั้ง / สั้นกว่า 32 ตัว — จะส่งเฉพาะข้อความ ไม่ส่งรูป"],
      ["LIFF (Rich Menu — ทางเลือก B)", d.liffReady ? "พร้อม" : "ยังไม่ตั้ง LIFF_ID / LINE_LOGIN_CHANNEL_ID"],
      ["ระบบส่งเข้ากลุ่มพนักงาน (เดิม)", d.groupOrdersEnabled ? "เปิดอยู่" : "ปิด (LINE_GROUP_ORDERS_ENABLED ไม่ใช่ true)"],
    ];
    $("lineGroupCard").hidden = !d.groupOrdersEnabled;
    box.replaceChildren(el("h2", {}, "สถานะ LINE OA"),
      el("div", { class: "tablewrap" }, el("table", { class: "table" }, el("tbody", {}, ...rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v)))))),
      d.groupOrdersEnabled && d.groups.length ? el("p", { class: "hint" }, "กลุ่มที่บอทเคยเข้า: " + d.groups.map((g) => `${g.id} (${g.status})`).join(", ")) : "");
    $("lineBindBtn").hidden = me.role !== "admin";
    $("lineUnbindBtn").hidden = me.role !== "admin" || !d.staffGroup || d.staffGroup.source !== "db";
  }
  $("lineBindBtn").addEventListener("click", async () => {
    const r = await act(() => api("createBindCode", {}));
    if (!r) return;
    const p = $("lineBindCode");
    p.hidden = false;
    p.textContent = `${r.instruction} (หมดอายุ ${fmtDate(r.expiresAt)})`;
    loadLine();
  });
  $("lineUnbindBtn").addEventListener("click", async () => {
    if (!confirm("ยกเลิกการผูกกลุ่มพนักงาน? คำสั่งผลิตจะส่งไม่ได้จนกว่าจะผูกใหม่")) return;
    await act(() => api("unbindGroup", {}), "ยกเลิกการผูกกลุ่มแล้ว");
    loadLine();
  });

  // ---------- ประวัติ ----------
  $("auditType").addEventListener("change", loadAudit);
  async function loadAudit() {
    const d = await act(() => api("audit", null, { type: $("auditType").value }));
    if (!d) return;
    $("auditTable").querySelector("tbody").replaceChildren(...d.events.map((ev) => el("tr", {},
      el("td", {}, fmtDate(ev.created_at)), el("td", {}, el("small", {}, ev.actor_id || "ระบบ")), el("td", {}, ev.action),
      el("td", {}, el("small", {}, ev.target || "-")), el("td", {}, el("small", {}, JSON.stringify(ev.detail || {}))))));
  }

  boot();
})();
