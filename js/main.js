/* =========================================================
   SIGN VERSE — Landing Page scripts
   ========================================================= */

// ⚠️ แก้ข้อมูลติดต่อจริงที่นี่จุดเดียว
const CONTACT = {
  lineId: "@signverse",
  phone: "080-000-0000",
};

(() => {
  "use strict";

  /* ---------- ลิงก์ LINE / โทร ---------- */
  const lineUrl = `https://line.me/R/ti/p/${encodeURIComponent(CONTACT.lineId)}`;
  const telUrl = `tel:${CONTACT.phone.replace(/[^\d+]/g, "")}`;

  document.querySelectorAll(".js-line-link").forEach((a) => { a.href = lineUrl; });
  document.querySelectorAll(".js-tel-link").forEach((a) => { a.href = telUrl; });

  /* ---------- เมนูมือถือ ---------- */
  const nav = document.getElementById("nav");
  const toggle = document.getElementById("navToggle");

  const setMenu = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "ปิดเมนู" : "เปิดเมนู");
  };

  toggle.addEventListener("click", () => {
    setMenu(toggle.getAttribute("aria-expanded") !== "true");
  });
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

  /* ---------- Header เงาเมื่อ scroll ---------- */
  const header = document.getElementById("header");
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- FAQ accordion (เปิดทีละข้อ) ---------- */
  const faqButtons = document.querySelectorAll(".faq__q");
  faqButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const willOpen = btn.getAttribute("aria-expanded") !== "true";
      faqButtons.forEach((other) => {
        other.setAttribute("aria-expanded", "false");
        document.getElementById(other.getAttribute("aria-controls")).hidden = true;
      });
      if (willOpen) {
        btn.setAttribute("aria-expanded", "true");
        document.getElementById(btn.getAttribute("aria-controls")).hidden = false;
      }
    });
  });

  /* ---------- ตัวกรองผลงาน ---------- */
  const filters = document.querySelectorAll(".filter");
  const works = document.querySelectorAll(".work");
  filters.forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.filter;
      filters.forEach((f) => {
        const active = f === btn;
        f.classList.toggle("is-active", active);
        f.setAttribute("aria-pressed", String(active));
      });
      works.forEach((w) => {
        w.classList.toggle("is-hidden", cat !== "all" && w.dataset.category !== cat);
      });
    });
  });

  /* ---------- Fade-in เมื่อ scroll ---------- */
  const reveals = document.querySelectorAll(".reveal");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach((el) => io.observe(el));
  }

  /* ---------- ปีปัจจุบันใน Footer ---------- */
  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
})();
