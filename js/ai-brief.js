/* =========================================================
   SIGN VERSE — AI บรีฟงานป้าย
   ส่งฟอร์มไปที่ /api/ai-brief (Vercel Serverless) แล้วแสดงผล
   ========================================================= */

(() => {
  "use strict";

  const form = document.getElementById("briefForm");
  if (!form) return;

  const submitBtn = document.getElementById("briefSubmit");
  const submitLabel = submitBtn.querySelector("span");
  const errorBox = document.getElementById("briefError");
  const emptyBox = document.getElementById("briefEmpty");
  const output = document.getElementById("briefOutput");
  const summaryEl = document.getElementById("briefSummary");
  const designEl = document.getElementById("briefDesign");
  const missingEl = document.getElementById("briefMissing");
  const sendBtn = document.getElementById("briefSend");
  const noteEl = document.getElementById("briefNote");
  const defaultNote = noteEl.textContent;

  const LABELS = {
    shopName: "ชื่อร้าน",
    signText: "ข้อความบนป้าย",
    size: "ขนาด",
    colors: "โทนสี",
    style: "สไตล์",
    material: "วัสดุ",
    lighting: "ติดไฟหรือไม่",
    budget: "งบประมาณ",
    deadline: "วันที่ต้องการ",
    details: "รายละเอียดเพิ่มเติม",
  };

  let lastBrief = "";

  // วันที่ต้องการ: เลือกย้อนหลังไม่ได้
  const deadline = document.getElementById("bf-deadline");
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  deadline.min = today.toISOString().slice(0, 10);

  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
  };

  const setLoading = (loading) => {
    submitBtn.disabled = loading;
    form.setAttribute("aria-busy", String(loading));
    submitLabel.textContent = loading ? "AI กำลังวิเคราะห์บรีฟ..." : "ให้ AI สรุปบรีฟ";
  };

  const fillList = (ul, items, emptyText) => {
    ul.replaceChildren();
    const list = items.length ? items : [emptyText];
    list.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
  };

  const formatDate = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d) ? iso : d.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
  };

  const collect = () => {
    const data = {};
    new FormData(form).forEach((value, key) => {
      const v = String(value).trim();
      if (v) data[key] = key === "deadline" ? formatDate(v) : v;
    });
    return data;
  };

  // ข้อความบรีฟสำหรับคัดลอกไปวางใน LINE
  const buildBriefText = (data, result) => {
    const lines = ["📋 บรีฟงานป้าย (สรุปโดย AI จากเว็บไซต์ SIGN VERSE)", ""];
    Object.keys(LABELS).forEach((key) => {
      if (data[key]) lines.push(`• ${LABELS[key]}: ${data[key]}`);
    });
    lines.push("", "สรุปบรีฟ:", result.summary);
    if (result.design_direction.length) {
      lines.push("", "แนวทางการออกแบบ:", ...result.design_direction.map((t) => `- ${t}`));
    }
    if (result.missing_info.length) {
      lines.push("", "ข้อมูลที่ยังขาด:", ...result.missing_info.map((t) => `- ${t}`));
    }
    return lines.join("\n");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");

    const data = collect();
    if (!data.shopName && !data.signText) {
      showError("กรุณากรอกชื่อร้าน หรือข้อความบนป้าย อย่างน้อย 1 ช่อง");
      form.elements.shopName.focus();
      return;
    }

    if (location.protocol === "file:") {
      showError("ระบบ AI ใช้งานได้เมื่อเปิดเว็บผ่าน Vercel (หรือ vercel dev) เท่านั้น");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/ai-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // บันทึกรหัสไว้ช่วยตรวจปัญหาใน DevTools (ไม่มีข้อมูลลับ)
        console.warn("[ai-brief]", res.status, json.code || "non_json_response");
        let msg = json.error;
        if (!msg && res.status === 404) msg = "ไม่พบระบบ AI บนเซิร์ฟเวอร์ กรุณาทักไลน์หาเราโดยตรง";
        if (!msg && res.status === 504) msg = "AI ใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้ง";
        throw new Error(msg || "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
      }

      const result = {
        summary: json.summary || "",
        design_direction: json.design_direction || [],
        missing_info: json.missing_info || [],
      };

      summaryEl.textContent = result.summary;
      fillList(designEl, result.design_direction, "ทีมงานจะช่วยแนะนำเพิ่มเติมทาง LINE");
      fillList(missingEl, result.missing_info, "ข้อมูลครบถ้วนแล้ว 🎉");
      lastBrief = buildBriefText(data, result);
      noteEl.textContent = defaultNote;

      emptyBox.hidden = true;
      output.hidden = false;
      if (window.matchMedia("(max-width: 959px)").matches) {
        output.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      // fetch ล้มเหลวระดับเครือข่ายจะได้ TypeError ภาษาอังกฤษ เช่น "Failed to fetch"
      showError(err instanceof TypeError || !err.message
        ? "ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง"
        : err.message);
    } finally {
      setLoading(false);
    }
  });

  // คัดลอกบรีฟก่อนเปิด LINE (ลิงก์ LINE ถูกตั้งโดย main.js)
  sendBtn.addEventListener("click", async () => {
    if (!lastBrief) return;
    try {
      await navigator.clipboard.writeText(lastBrief);
      noteEl.textContent = "คัดลอกบรีฟแล้ว วางในแชต LINE ได้เลย";
    } catch {
      noteEl.textContent = "คัดลอกอัตโนมัติไม่สำเร็จ กรุณาแคปหน้าจอผลสรุปส่งทาง LINE";
    }
  });
})();
