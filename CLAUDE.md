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
api/estimate-price.js  ประเมินราคาป้ายจากสูตรร้าน (ใช้ env PRICING_CONFIG)
api/_lib/*.mjs         auth, jobs (quota), repo-pg/memory, storage, images, http, context
api/_lib/pricing.js    เครื่องคำนวณราคา — จำลองสูตร Excel ทีละขั้น ไม่มีตัวเลขในโค้ด
tools/extract-pricing-config.py  ดึงค่าจาก Excel → private/ (ข้อมูลลับ)
tests/pricing.test.js  ทดสอบราคาเทียบ Excel (node --test tests/)
PRICING_AUDIT.md  ผลตรวจสูตรราคาและคำถามที่ต้องยืนยัน
private/          ⚠️ ข้อมูลลับ (config ราคา + fixtures) — .gitignore และ .vercelignore
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

## ระบบประเมินราคา (`/api/estimate-price`)
- **repo เป็นสาธารณะ** — ห้ามใส่ต้นทุน ตัวคูณ ค่าบริการ หรือไฟล์ Excel ในโค้ด/ไฟล์ที่ commit
- ค่าทั้งหมดอยู่ใน `PRICING_CONFIG` (Vercel env) / `private/pricing-config.json` (local, ignored)
- ห้ามเปลี่ยนสูตรราคาเอง สูตรต้องตรงกับ Excel (ตรวจด้วย fixtures ใน `private/`)
- สูตรที่ยังไม่ยืนยัน `enabled: false` → API ตอบ `needs_review` ห้ามแสดงราคาสมมติหรือ 0 บาท
- ห้ามแสดง/คำนวณส่วนลดให้ลูกค้า ส่วนลดให้พนักงานเสนอผ่าน LINE เท่านั้น
- ข้อความคุณภาพ/ข้อเสนอพิเศษใช้ถ้อยคำตามที่เจ้าของร้านกำหนด ห้ามเพิ่มคำรับประกัน
- ข้อความ "พิมพ์ UV" แสดงเฉพาะสูตรที่ `uvPrint: true` ใน `api/_lib/pricing.js`
- เปลี่ยนขนาด/วัสดุหลังได้ผล → เรียกเฉพาะ estimate-price ไม่เรียก AI ซ้ำ

## ระบบสมาชิก / โควตา AI / หลังบ้าน (ดู docs/SETUP.md)
- Auth: **Better Auth** (`api/_lib/auth.mjs`, `api/auth/index.mjs` + rewrite `/api/auth/:path*` ใน vercel.json) — **Facebook + เบอร์โทร/OTP** (`AUTH_PROVIDERS`, ค่าเริ่มต้น `facebook,phone`; LINE Login/Google ปิด) · `/api/me` → `providers` (social) + `phoneLogin` (`ready`/`coming_soon`/`off`), ไม่มีรหัสผ่าน, role: customer/staff/admin (`input:false`), `disableImplicitLinking` (ไม่รวมบัญชีอัตโนมัติ)
  - Facebook: `FACEBOOK_CLIENT_ID/SECRET`, ขอแค่ `public_profile`, ระบุสมาชิกด้วย Facebook User ID (อีเมลแทน `.invalid` — ไม่ใช้อีเมลจริง กันชน/รวมบัญชี) · แก้ต้องรัน `tests/social-login.test.mjs`
  - LINE Login (ถ้าเปิด) ใช้ `LINE_LOGIN_CHANNEL_ID/SECRET` — ห้ามใช้ `LINE_CHANNEL_SECRET` (ของ OA Webhook รับออร์เดอร์ ซึ่งยังใช้งานอยู่)
  - OTP: Better Auth `phoneNumber` plugin + `api/_lib/phone.mjs` (hash, 5 นาที, ผิดได้ 5 ครั้ง, ส่งซ้ำ 60 วิ, จำกัดต่อเบอร์/IP/วัน) · SMS: ThaiBulkSMS (`SMS_PROVIDER`) · SMS จำลองใช้ได้เฉพาะ `MOCK_SERVICES=1` (`MOCK_SMS_ECHO=1` แสดงรหัสใน console) · ต้องรัน `db/schema.sql` ก่อนตั้งค่า SMS · แก้ต้องรัน `tests/phone-otp.test.mjs`
- DB: Neon (`db/schema.sql`), repo: `api/_lib/repo-pg.mjs` (จริง) / `repo-memory.mjs` (mock+tests) อินเทอร์เฟซเดียวกัน
- Storage: Blob Private (ภาพลูกค้า/AI/ต้นฉบับผลงาน) + Public (เฉพาะผลงานที่เผยแพร่) — `api/_lib/storage.mjs`; อ่าน private ผ่าน `/api/files` ที่ตรวจสิทธิ์เท่านั้น
  - เลือก store ด้วย `PRIVATE_BLOB_STORE_ID` / `PUBLIC_BLOB_STORE_ID` + Vercel OIDC (หรือ `*_BLOB_READ_WRITE_TOKEN` ถ้ามี ใช้ก่อน) · ส่ง storeId ทุกคำสั่ง + ตรวจ host ของ URL ไฟล์ · ห้ามพึ่ง `BLOB_READ_WRITE_TOKEN`/`BLOB_STORE_ID` ค่าเริ่มต้น · แก้ต้องรัน `tests/storage.test.mjs`
- Quota/Job state machine: `api/_lib/jobs.mjs` (1 สิทธิ์ = Artwork+Mockup, idempotency key, refund rules) — แก้ต้องรัน `tests/jobs.test.mjs`
- API (Hobby จำกัด 12 functions — ตอนนี้ 11): me, gallery, upload, ai, files, admin, cron-cleanup, auth, ai-brief, estimate-price, line/webhook
- LINE OA @signverse (คำสั่งผลิต): ลูกค้ากด "สั่งผลิตป้ายนี้" → บันทึก `production_orders` (เลขออร์เดอร์ + claim_code) → `oaMessage` ให้ลูกค้ากดส่งเอง → `api/line/webhook.mjs` ตรวจลายเซ็น → `api/_lib/delivery.mjs` reply รูปกลับในแชตเดียวกัน (ครั้งเดียว, ผูก LINE userId) · ทาง B: `liff/order.html` (`liff.sendMessages`, ตรวจ ID token) · สถานะการส่ง `line_delivery_status` แยกจาก `status` การผลิต
- Mock AI ใช้ PNG ตัวอย่าง (`api/_lib/fixtures/`) เพราะ LINE รับเฉพาะ PNG/JPEG · `FILE_SIGNING_SECRET` ต้องเป็นค่าเฉพาะ ≥32 ตัว (ไม่มี = ไม่ส่งรูป) · `push` ถูกปิดที่ `context.mjs` เมื่อระบบกลุ่มปิด
- ระบบส่งเข้ากลุ่ม LINE พนักงาน (เดิม) ปิดไว้ — เปิดเฉพาะ `LINE_GROUP_ORDERS_ENABLED=true`; ห้ามเรียก LINE จริงในการทดสอบ (tests บล็อก fetch)
- โค้ดใหม่ฝั่ง server เป็น ESM `.mjs`; ไฟล์เดิม `.js` เป็น CommonJS — อย่าเพิ่ม `"type": "module"` ใน package.json
- AI จริง: `AI_PROVIDER=openai` → `api/_lib/ai-openai.mjs` (GPT Image 2, `/v1/images/generations` + `/edits`, ค่าใช้จ่ายจาก usage) + `api/_lib/watermark.mjs` (sharp 0.35.4, `fixtures/watermark.png`) · ต้นฉบับไม่มีลายน้ำ = `*_original_key` (Private เท่านั้น) · `AI_ACCESS` ไม่ตั้ง = เฉพาะพนักงาน · งบรวม `AI_DAILY_BUDGET_THB`/`AI_MONTHLY_BUDGET_THB` ตรวจใน `createJob` ภายใต้ `lockAiBudget()` · ทดสอบ `tests/ai-openai.test.mjs` (fetch จำลอง) · ทดสอบ sharp จริงต้องใช้ Node ทางการ (Node ใน Cursor โหลด native module ไม่ได้)
- `AI_PROVIDER=mock` บนเว็บจริง → `canUseAi()` อนุญาตเฉพาะ staff/admin และงานเป็น `credit_state=exempt` (ไม่หักเครดิต) · ทดสอบในเครื่องด้วย `MOCK_AI_STAFF_ONLY=1`
- ส่วน `#ai-design` แสดงเสมอ — ปุ่ม/ข้อความทำงานตาม `aiStatus` จาก `/api/me` (`ready` / `mock_test` / `login_required` / `coming_soon`) · `/api/upload` รับรูปเฉพาะเมื่อ `canUseAi` · งาน Mock มี `preview: true` และหน้าเว็บติดป้าย "ไม่ใช่ผลลัพธ์จาก AI จริง" · แก้ต้องรัน `tests/ai-status.test.mjs`
- **Guest AI** (`api/_lib/guest.mjs`, `GUEST_AI_ENABLED=true`): สร้างภาพโดยไม่ล็อกอิน — ตัวตน = cookie `sv_guest` ลงลายเซ็น HMAC · `resolveActor()` ใน context ตรวจทุก API (ai/upload/files) · งาน/ไฟล์ใช้ `guest_id` (user_id = NULL, `credit_state='guest'`) · เพดานต่อ Guest/IP/วัน/งบเดือน ตรวจใน `createJob` ภายใต้ `lockGuestAi()` · **ใช้ได้เฉพาะ AI จริง (ห้าม Mock)** ไม่มี AI จริง = `coming_soon` · ทดสอบหน้าเว็บในเครื่องด้วย `DEV_FAKE_REAL_AI=1` (เฉพาะ MOCK_SERVICES) · แก้ต้องรัน `tests/guest-ai.test.mjs`
- `MOCK_SERVICES=1` ห้ามใช้บน Production (ระบบปฏิเสธ)
- หน้าเว็บ: `js/account.js` (login modal), `js/ai-design.js` (gallery picker, uploads, generate, canvas ขนาด), หลังบ้าน `admin/`
- ทดสอบ: `ELECTRON_RUN_AS_NODE=1 "/Applications/Cursor.app/Contents/MacOS/Cursor" --test tests/*.test.*` (เครื่องนี้ไม่มี Node แยก)
- Dev server mock: `tools/dev-server.mjs`

## วิธีเปิดดู
เปิด `index.html` ในเบราว์เซอร์โดยตรง หรือ
```
python3 -m http.server 8000   # แล้วเปิด http://localhost:8000 (ระบบ AI จะยังไม่ทำงาน)
vercel dev                    # รันพร้อม API — ต้องมี .env.local ที่มี OPENAI_API_KEY
```
