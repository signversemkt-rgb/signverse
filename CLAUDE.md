# SIGN VERSE — Landing Page

## ภาพรวม
Landing Page หน้าเดียวของ **SIGN VERSE** ธุรกิจผลิตป้ายและสื่อสิ่งพิมพ์ทุกชนิด
กลุ่มเป้าหมาย: เจ้าของกิจการทุกรูปแบบ (ร้านค้า ร้านอาหาร คลินิก ออฟฟิศ SME)

**เป้าหมาย Conversion**
1. หลัก: แอด LINE เพื่อขอใบเสนอราคา (ปุ่มสีเขียว LINE)
2. รอง: โทรสอบถาม (ปุ่มสีฟ้า/ขอบ)

## ข้อกำหนด
- HTML, CSS, JavaScript ล้วน — ห้ามใช้ framework, build tool หรือ library ภายนอก (ยกเว้น Google Fonts)
- ไม่มีฐานข้อมูล — backend มีเฉพาะ Vercel Serverless Function ใน `api/` (ไม่ต้องมี package.json / dependency)
- ข้อความบนหน้าเว็บเป็นภาษาไทยทั้งหมด ห้ามใช้ Lorem Ipsum
- รองรับ Desktop และ Mobile (mobile-first)

## โครงสร้างไฟล์
```
index.html        โครงสร้างทุก Section (เรียงตามลำดับด้านล่าง)
css/style.css     ดีไซน์ทั้งหมด ใช้ CSS variables ใน :root
js/main.js        เมนูมือถือ, header ตอน scroll, FAQ accordion, ตัวกรองผลงาน, fade-in
js/ai-brief.js    ฟอร์มบรีฟงานป้าย → เรียก /api/ai-brief แล้วแสดงผล
api/ai-brief.js   Vercel Serverless Function เรียก OpenAI (ใช้ env OPENAI_API_KEY)
.env.example      ตัวอย่าง Environment Variables
assets/images/    รูปโลโก้/ผลงานจริง (ตอนนี้ยังว่าง ใช้กราฟิก CSS แทน)
```

## Section (id ใช้กับเมนู)
1. Header (sticky) → 2. Hero `#home` → 3. ปัญหาลูกค้า `#problems` → 4. จุดเด่น `#why`
→ 5. บริการ `#services` → 6. ขั้นตอน `#process` → AI บรีฟ `#ai-brief` → 7. ผลงาน `#portfolio` + รีวิว `#reviews`
→ 8. FAQ `#faq` → 9. CTA `#contact` → 10. Footer + ปุ่มลอย LINE / แถบ CTA มือถือ

## Design tokens (แก้ที่ `:root` ใน css/style.css เท่านั้น)
| Token | ค่า | ใช้กับ |
|---|---|---|
| `--blue-600` | `#1E6FFF` | สีหลัก ปุ่ม ไฮไลต์ |
| `--blue-900` | `#0B3D91` | CTA section, footer |
| `--blue-50` | `#EAF2FF` | พื้นหลังสลับ section |
| `--ink` / `--ink-soft` | `#0F172A` / `#475569` | ข้อความหลัก / รอง |
| `--line` | `#06C755` | ปุ่ม LINE |
| ฟอนต์ | `Prompt` (หัวข้อ), `Sarabun` (เนื้อหา) | |
| `--radius` | `16px` | การ์ด |

Breakpoints: `640px`, `960px` (min-width)

## Conventions
- Class naming แบบ BEM-ish: `.block`, `.block__element`, `.block--modifier`
- ห้าม hard-code สี ให้ใช้ CSS variables
- ไอคอนเป็น SVG inline
- Animation ต้องเคารพ `prefers-reduced-motion`
- ทุกปุ่ม LINE ใช้ class `js-line-link`, ปุ่มโทรใช้ `js-tel-link` — `main.js` จะตั้ง `href` ให้จากค่าคงที่ด้านบนไฟล์

## ⚠️ ข้อมูลที่ต้องแก้เป็นของจริง
- `js/main.js` → `CONTACT.lineId`, `CONTACT.phone` (ตอนนี้ `@signverse`, `080-000-0000` เป็นค่าตัวอย่าง)
- `index.html` → ข้อความเบอร์โทร/ที่อยู่/เวลาทำการใน Footer และ CTA (ค้นหา `080-000-0000`)
- `index.html` → แกลเลอรีผลงาน: เปลี่ยน `.work__thumb` เป็น `<img src="assets/images/...">`
- ตัวเลขสถิติใน Hero และรีวิวลูกค้าเป็นตัวอย่าง ควรแทนด้วยข้อมูลจริง

## ระบบ AI บรีฟงาน (`#ai-brief`)
- Frontend (`js/ai-brief.js`) POST JSON ไป `/api/ai-brief` ฟิลด์: `shopName, signText, size, colors, style, material, lighting, budget, deadline, details`
- API ตอบกลับ `{ summary, design_direction[], missing_info[] }` ภาษาไทย (OpenAI Chat Completions + JSON schema)
- **ห้ามใส่ OpenAI API Key ใน frontend** — ใช้ `process.env.OPENAI_API_KEY` ฝั่ง server เท่านั้น
- `OPENAI_MODEL` (ไม่บังคับ) เปลี่ยนโมเดลได้ ค่าเริ่มต้นอยู่ใน `api/ai-brief.js`
- แสดงผล AI ด้วย `textContent` เท่านั้น ห้ามใช้ `innerHTML`
- ฟีเจอร์นี้ไม่ทำงานเมื่อเปิด `index.html` แบบ file:// — ต้องใช้ Vercel หรือ `vercel dev`

## วิธีเปิดดู
เปิด `index.html` ในเบราว์เซอร์โดยตรง หรือ
```
python3 -m http.server 8000   # แล้วเปิด http://localhost:8000 (ระบบ AI จะยังไม่ทำงาน)
vercel dev                    # รันพร้อม API — ต้องมี .env.local ที่มี OPENAI_API_KEY
```
