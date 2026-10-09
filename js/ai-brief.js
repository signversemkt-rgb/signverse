/* =========================================================
   SIGN VERSE — AI บรีฟงานป้าย + ประเมินราคา
   - /api/ai-brief       สรุปบรีฟด้วย AI (Vercel Serverless)
   - /api/estimate-price ราคาประเมินจากสูตรร้าน (คำนวณฝั่ง Server เท่านั้น)
   ========================================================= */

(() => {
  "use strict";

  const form = document.getElementById("briefForm");
  if (!form) return;

  const $ = (id) => document.getElementById(id);
  const submitBtn = $("briefSubmit");
  const submitLabel = submitBtn.querySelector("span");
  const errorBox = $("briefError");
  const emptyBox = $("briefEmpty");
  const output = $("briefOutput");
  const quotePrice = $("quotePrice");
  const quoteReview = $("quoteReview");
  const quoteSpec = $("quoteSpec");
  const qualityText = $("qualityText");
  const aiBox = $("briefAi");
  const aiError = $("briefAiError");
  const summaryEl = $("briefSummary");
  const designEl = $("briefDesign");
  const missingEl = $("briefMissing");
  const sendBtn = $("briefSend");
  const noteEl = $("briefNote");
  const defaultNote = noteEl.textContent;

  const SUBMIT_TEXT = "สรุปบรีฟและประเมินราคา";
  const REVIEW_TEXT = "งานรูปแบบนี้ต้องประเมินราคาเพิ่มเติม กรุณาส่งรายละเอียดให้ทีม SIGN VERSE ตรวจสอบ";
  const QUALITY_UV = "คัดสรรวัสดุคุณภาพ พิมพ์ UV สีสันคมชัด ใส่ใจทุกขั้นตอนการผลิต";
  const QUALITY_BASE = "คัดสรรวัสดุคุณภาพ ใส่ใจทุกขั้นตอนการผลิต";

  const JOB_LABELS = {
    standard: "ป้ายแผ่นพิมพ์ลาย",
    diecut: "ไดคัทตัวอักษร",
    cutout: "ฉลุลาย",
    acrylic_overlay: "พลาสวูดประกบอะคริลิกใส",
  };
  const LIGHT_LABELS = { none: "ไม่ติดไฟ", white: "ไฟสีขาว (White)", warm: "ไฟวอร์มไวท์ (Warm White)" };

  // สถานะล่าสุด ใช้สร้างข้อความส่ง LINE
  const state = { brief: null, quote: null };
  let quoteSeq = 0;

  // วันที่ต้องการ: เลือกย้อนหลังไม่ได้
  const deadline = $("bf-deadline");
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  deadline.min = today.toISOString().slice(0, 10);

  const showError = (el, msg) => {
    el.textContent = msg || "";
    el.hidden = !msg;
  };

  const setLoading = (loading) => {
    submitBtn.disabled = loading;
    form.setAttribute("aria-busy", String(loading));
    submitLabel.textContent = loading ? "กำลังสรุปบรีฟและประเมินราคา..." : SUBMIT_TEXT;
  };

  const fillList = (ul, items, emptyText) => {
    ul.replaceChildren();
    (items.length ? items : [emptyText]).forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
  };

  const formatDate = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d) ? iso : d.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
  };

  const formatPrice = (n) => `฿${Number(n).toLocaleString("th-TH")}`;

  // ---------- เก็บข้อมูลจากฟอร์ม ----------
  const read = () => {
    const fd = new FormData(form);
    const get = (k) => String(fd.get(k) || "").trim();
    return {
      shopName: get("shopName"),
      signText: get("signText"),
      widthCm: get("widthCm"),
      heightCm: get("heightCm"),
      material: get("material"),
      layers: get("layers"),
      jobType: get("jobType"),
      lighting: get("lighting"),
      colors: get("colors"),
      style: get("style"),
      budget: get("budget"),
      deadline: get("deadline"),
      details: get("details"),
    };
  };

  const hasSize = (d) => Number(d.widthCm) > 0 && Number(d.heightCm) > 0;

  // ข้อมูลสำหรับ /api/ai-brief (ใช้ฟิลด์เดิมของ API)
  const toBriefPayload = (d) => {
    const out = {
      shopName: d.shopName,
      signText: d.signText,
      size: hasSize(d) ? `${d.widthCm} x ${d.heightCm} ซม.` : "",
      colors: d.colors,
      style: d.style,
      material: d.material,
      layers: `${d.layers} ชั้น`,
      jobType: JOB_LABELS[d.jobType] || "",
      lighting: LIGHT_LABELS[d.lighting] || "",
      budget: d.budget,
      deadline: d.deadline ? formatDate(d.deadline) : "",
      details: d.details,
    };
    Object.keys(out).forEach((k) => { if (!out[k]) delete out[k]; });
    return out;
  };

  const toPricePayload = (d) => ({
    widthCm: Number(d.widthCm),
    heightCm: Number(d.heightCm),
    material: d.material,
    layers: Number(d.layers),
    jobType: d.jobType,
    lighting: d.lighting,
  });

  const postJSON = async (url, data) => {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    } catch {
      throw new Error("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง");
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[sign-verse]", url, res.status, json.code || "non_json_response");
      let msg = json.error;
      if (!msg && res.status === 404) msg = "ไม่พบระบบบนเซิร์ฟเวอร์ กรุณาทักไลน์หาเราโดยตรง";
      if (!msg && res.status === 504) msg = "ระบบใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง";
      throw new Error(msg || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
    return json;
  };

  // ---------- แสดงราคา ----------
  const renderSpec = (spec) => {
    quoteSpec.replaceChildren();
    if (!spec) return;
    [
      ["ขนาดป้าย", spec.sizeText],
      ["วัสดุ", spec.material],
      ["จำนวนชั้น", `${spec.layers} ชั้น`],
      ["ประเภทงาน", spec.jobType],
      ["ระบบไฟ", spec.lighting],
    ].forEach(([k, v]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = k;
      dd.textContent = v;
      quoteSpec.append(dt, dd);
    });
  };

  const renderQuote = (quote, message) => {
    state.quote = quote;
    const estimated = quote && quote.status === "estimated" && Number(quote.price) > 0;
    quotePrice.hidden = !estimated;
    quotePrice.textContent = estimated ? formatPrice(quote.price) : "";
    quoteReview.hidden = estimated;
    quoteReview.textContent = estimated ? "" : message || (quote && quote.message) || REVIEW_TEXT;
    renderSpec(quote && quote.spec);
    // ข้อความ UV แสดงเฉพาะงานที่ยืนยันว่าใช้การพิมพ์ UV
    qualityText.textContent = estimated && quote.uvPrint ? QUALITY_UV : QUALITY_BASE;
  };

  // จำผลราคาของสเปกที่เคยถามแล้ว → เปลี่ยนกลับไปมาไม่ต้องเรียก Server ซ้ำ (Server ยังเป็นผู้คำนวณเสมอ)
  const quoteCache = new Map();
  const fetchQuote = async (d) => {
    const payload = toPricePayload(d);
    const key = JSON.stringify(payload);
    if (!quoteCache.has(key)) {
      const p = postJSON("/api/estimate-price", payload);
      quoteCache.set(key, p);
      p.catch(() => quoteCache.delete(key));
    }
    return quoteCache.get(key);
  };

  // ---------- ราคาประเมินทันที (ใต้ช่องขนาด/วัสดุ/ชั้น/ไฟ) — ไม่ต้องกดปุ่ม และไม่เรียก AI ----------
  const liveValue = $("livePriceValue");
  const liveNote = $("livePriceNote");
  const liveBox = $("livePrice");
  let liveSeq = 0;
  const renderLive = (state, text, note = "") => {
    liveBox.dataset.state = state;
    liveValue.textContent = text;
    liveNote.textContent = note;
  };
  const updateLive = async () => {
    const d = read();
    const seq = ++liveSeq;
    if (!hasSize(d)) return renderLive("empty", "กรอกความกว้างและความสูงเพื่อดูราคา");
    renderLive("loading", "กำลังคำนวณ…");
    try {
      const q = await fetchQuote(d);
      if (seq !== liveSeq) return;
      if (q && q.status === "estimated" && Number(q.price) > 0) {
        renderLive("estimated", formatPrice(q.price), q.note || "ราคาประเมินอาจเปลี่ยนแปลงตามรายละเอียดงานจริง • ยังไม่รวมค่าจัดส่ง");
      } else {
        renderLive("review", "ทีมงานจะประเมินราคาให้", "งานรูปแบบนี้ต้องประเมินเพิ่มเติม — ทักไลน์ส่งรายละเอียดได้เลย");
      }
    } catch (err) {
      if (seq === liveSeq) renderLive("error", "ยังคำนวณราคาไม่ได้", `${err.message}`);
    }
  };
  let liveTimer;
  const scheduleLive = (e) => {
    if (e && !e.target.hasAttribute("data-price")) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(updateLive, 400);
  };
  form.addEventListener("input", scheduleLive);
  form.addEventListener("change", scheduleLive);

  const requestQuote = async (d) => {
    const seq = ++quoteSeq;
    if (!hasSize(d)) {
      renderQuote(null, "กรอกความกว้างและความสูง (ซม.) เพื่อดูราคาประเมิน");
      return;
    }
    try {
      const quote = await fetchQuote(d);
      if (seq === quoteSeq) renderQuote(quote);
    } catch (err) {
      if (seq === quoteSeq) renderQuote(null, `${err.message} หรือทักไลน์ให้ทีมงานประเมินราคาให้`);
    }
  };

  // ---------- แสดงผล AI ----------
  const renderBrief = (result) => {
    state.brief = result;
    summaryEl.textContent = result.summary || "";
    fillList(designEl, result.design_direction || [], "ทีมงานจะช่วยแนะนำเพิ่มเติมทาง LINE");
    fillList(missingEl, result.missing_info || [], "ข้อมูลครบถ้วนแล้ว 🎉");
    aiBox.hidden = false;
    showError(aiError, "");
  };

  // ---------- ข้อความสำหรับส่ง LINE ----------
  const buildLineText = () => {
    const d = read();
    const q = state.quote;
    const lines = ["📋 สรุปงานป้ายจากเว็บไซต์ SIGN VERSE", ""];
    const add = (label, value) => { if (value) lines.push(`• ${label}: ${value}`); };
    add("ชื่อร้าน", d.shopName);
    add("ข้อความบนป้าย", d.signText);
    add("ขนาดป้าย", hasSize(d) ? `${d.widthCm} x ${d.heightCm} ซม.` : "");
    add("วัสดุ", d.material);
    add("จำนวนชั้น", `${d.layers} ชั้น`);
    add("ประเภทงาน", JOB_LABELS[d.jobType]);
    add("ระบบไฟ", LIGHT_LABELS[d.lighting]);
    add("โทนสี", d.colors);
    add("สไตล์", d.style);
    add("งบประมาณ", d.budget);
    add("วันที่ต้องการ", d.deadline ? formatDate(d.deadline) : "");
    add("ราคาประเมินเบื้องต้น", q && q.status === "estimated" ? `${formatPrice(q.price)} (ยังไม่รวมค่าจัดส่ง)` : "รอทีมงานประเมิน");
    add("หมายเหตุ", d.details);
    if (state.brief && state.brief.summary) lines.push("", "สรุปบรีฟโดย AI:", state.brief.summary);
    lines.push("", "สนใจรับข้อเสนอพิเศษและราคาสุทธิครับ/ค่ะ");
    return lines.join("\n");
  };

  // ---------- ส่งฟอร์ม ----------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(errorBox, "");
    const d = read();

    if (!d.shopName && !d.signText) {
      showError(errorBox, "กรุณากรอกชื่อร้าน หรือข้อความบนป้าย อย่างน้อย 1 ช่อง");
      form.elements.shopName.focus();
      return;
    }
    if (!hasSize(d)) {
      showError(errorBox, "กรุณากรอกความกว้างและความสูงของป้าย (เซนติเมตร) เพื่อประเมินราคา");
      form.elements.widthCm.focus();
      return;
    }
    if (location.protocol === "file:") {
      showError(errorBox, "ระบบนี้ใช้งานได้เมื่อเปิดเว็บผ่าน Vercel (หรือ vercel dev) เท่านั้น");
      return;
    }

    setLoading(true);
    const [brief] = await Promise.allSettled([
      postJSON("/api/ai-brief", toBriefPayload(d)),
      requestQuote(d),
    ]);
    setLoading(false);

    if (brief.status === "fulfilled") {
      renderBrief(brief.value);
    } else {
      state.brief = null;
      aiBox.hidden = true;
      showError(aiError, `สรุปบรีฟด้วย AI ไม่สำเร็จ: ${brief.reason.message}`);
    }

    noteEl.textContent = defaultNote;
    emptyBox.hidden = true;
    output.hidden = false;
    if (window.matchMedia("(max-width: 959px)").matches) {
      output.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  // เปลี่ยนขนาด/วัสดุ/ไฟ หลังได้ผลแล้ว → คำนวณราคาใหม่ (ไม่เรียก AI ซ้ำ)
  let timer;
  form.addEventListener("input", (e) => {
    if (output.hidden || !e.target.hasAttribute("data-price")) return;
    clearTimeout(timer);
    timer = setTimeout(() => requestQuote(read()), 500);
  });

  // คัดลอกสรุปก่อนเปิด LINE (ลิงก์ LINE ถูกตั้งโดย main.js) — ไม่อ้างว่าส่งสำเร็จ
  sendBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildLineText());
      noteEl.textContent = "คัดลอกสรุปงานแล้ว วางในแชต LINE แล้วกดส่งให้ทีมงานได้เลย";
    } catch {
      noteEl.textContent = "คัดลอกอัตโนมัติไม่สำเร็จ กรุณาแคปหน้าจอผลสรุปแล้วส่งในแชต LINE";
    }
  });
  // ข้อมูลที่กรอกค้างไว้ (เช่น กลับจากหน้าล็อกอิน) → แสดงราคาทันที
  setTimeout(updateLive, 0);
})();
