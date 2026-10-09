/* =========================================================
   SIGN VERSE — ส่วนผลงาน (#portfolio) จากอัลบั้มที่พนักงานอัปโหลดในหลังบ้าน (/admin)
   - แท็บ = อัลบั้มที่เผยแพร่ + "ทั้งหมด" · รูปแบ่งหน้า (ดูผลงานเพิ่ม) · กดรูปเพื่อขยาย
   - ยังไม่มีอัลบั้มที่เผยแพร่ / ระบบยังไม่พร้อม → แสดงการ์ดตัวอย่างเดิมในหน้า (ไม่ว่างเปล่า)
   - ข้อความจากระบบใส่ด้วย textContent เท่านั้น
   ========================================================= */
(() => {
  "use strict";

  const grid = document.getElementById("worksGrid");
  const filters = document.getElementById("workFilters");
  const more = document.getElementById("worksMore");
  if (!grid || !filters || !more) return;

  const state = { albums: new Map(), current: "all", page: 0, loading: false, seq: 0 };

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`gallery ${r.status}`);
    return r.json();
  }

  function zoom(img) {
    const z = document.getElementById("zoomImg");
    if (!z) return;
    z.src = img.url;
    z.alt = img.alt || img.title || "ผลงาน SIGN VERSE";
    document.getElementById("zoomCap").textContent = img.title || "";
    if (window.SVAccount) window.SVAccount.openModal("zoomModal");
    else document.getElementById("zoomModal").hidden = false;
  }

  function card(img) {
    const fig = document.createElement("figure");
    fig.className = "work work--photo";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "work__thumb work__thumb--photo";
    btn.setAttribute("aria-label", `ขยายภาพ ${img.title || "ผลงาน"}`);
    const im = document.createElement("img");
    im.src = img.thumbUrl || img.url;
    im.alt = img.alt || img.title || "ผลงาน SIGN VERSE";
    im.loading = "lazy";
    im.decoding = "async";
    im.width = 640;
    im.height = 480;
    im.onerror = () => fig.remove();                  // รูปเสีย/ถูกลบ → ไม่แสดงกรอบว่าง
    btn.appendChild(im);
    btn.addEventListener("click", () => zoom(img));
    const cap = document.createElement("figcaption");
    const t = document.createElement("strong");
    t.textContent = img.title || "ผลงาน SIGN VERSE";
    const sub = document.createElement("span");
    sub.textContent = state.albums.get(img.albumId)?.title || "";
    cap.append(t, sub);
    fig.append(btn, cap);
    return fig;
  }

  async function load(albumId, page) {
    const seq = ++state.seq;
    state.loading = true;
    more.disabled = true;
    try {
      const url = albumId === "all" ? `/api/gallery?all=1&page=${page}` : `/api/gallery?album=${encodeURIComponent(albumId)}&page=${page}`;
      const data = await getJson(url);
      if (seq !== state.seq) return;
      if (page === 0) grid.replaceChildren();
      data.images.forEach((img) => grid.appendChild(card(img)));
      state.page = page;
      more.hidden = !data.hasMore;
    } catch {
      if (seq === state.seq && page > 0) more.hidden = true;
    } finally {
      if (seq === state.seq) { state.loading = false; more.disabled = false; }
    }
  }

  function renderFilters(albums) {
    const mk = (id, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "filter" + (id === "all" ? " is-active" : "");
      b.dataset.album = id;
      b.setAttribute("aria-pressed", String(id === "all"));
      b.textContent = label;
      return b;
    };
    filters.replaceChildren(mk("all", "ทั้งหมด"), ...albums.map((a) => mk(a.id, a.title)));
  }

  filters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-album]");
    if (!b || b.dataset.album === state.current) return;
    state.current = b.dataset.album;
    filters.querySelectorAll("[data-album]").forEach((f) => {
      const on = f === b;
      f.classList.toggle("is-active", on);
      f.setAttribute("aria-pressed", String(on));
    });
    load(state.current, 0);
  });
  more.addEventListener("click", () => { if (!state.loading) load(state.current, state.page + 1); });

  (async () => {
    try {
      const { albums } = await getJson("/api/gallery");
      if (!albums || !albums.length) return;            // ยังไม่มีผลงานจริง → ใช้การ์ดตัวอย่างเดิม
      albums.forEach((a) => state.albums.set(a.id, a));
      renderFilters(albums);
      await load("all", 0);
    } catch { /* ระบบยังไม่พร้อม → ใช้การ์ดตัวอย่างเดิม */ }
  })();
})();
