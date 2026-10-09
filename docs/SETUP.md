# คู่มือตั้งค่าระบบสมาชิก · โควตา AI · หลังบ้าน — SIGN VERSE

> ทำตามลำดับ 1 → 8 · ทุกบริการในคู่มือนี้ใช้แผนฟรีได้ (ดู "ค่าใช้จ่าย" ท้ายไฟล์)
> โดเมนในตัวอย่าง: `https://signverse-azure.vercel.app` — ถ้าใช้โดเมนอื่น ให้เปลี่ยนทุกจุด

---

## 1. ฐานข้อมูล Neon (ฟรี)

1. Vercel → เลือกโปรเจกต์ → แท็บ **Storage** → **Create Database** → เลือก **Neon**
2. เลือกแผน **Free** และ Region **Singapore** (ใกล้ไทยที่สุด)
3. กด **Connect** กับโปรเจกต์ (เลือกทั้ง Production และ Preview) → Vercel จะเพิ่ม `DATABASE_URL` ให้อัตโนมัติ
4. เปิด Neon Console (ปุ่ม **Open in Neon**) → **SQL Editor**
5. คัดลอกเนื้อหาไฟล์ `db/schema.sql` ทั้งหมด วางแล้วกด **Run** (รันซ้ำได้ ไม่ทำข้อมูลหาย)
   - ถ้าเคยรันเวอร์ชันก่อนแล้ว ให้รันไฟล์ล่าสุดซ้ำอีกครั้ง (ส่วนท้ายไฟล์อัปเดตตารางเดิมให้อัตโนมัติ)

> แนะนำตั้ง Function Region ของ Vercel เป็น Singapore ด้วย (Settings → Functions → Region → `sin1`) เพื่อให้ API อยู่ใกล้ฐานข้อมูล

## 2. Vercel Blob 2 ชุด (ฟรี)

**ชุดที่ 1 — Private (ภาพลูกค้า / ภาพ AI / ต้นฉบับรูปผลงาน)**
1. Storage → **Create** → **Blob** → ชื่อ `signverse-private` → Access: **Private**
2. ตอน Connect กับโปรเจกต์ เลือกทั้ง **Production และ Preview** และตั้ง **Environment Variables Prefix** = `PRIVATE_BLOB`
3. ตรวจว่ามีตัวแปร `PRIVATE_BLOB_STORE_ID` ใน Settings → Environment Variables

**ชุดที่ 2 — Public (เฉพาะรูปผลงานที่กดเผยแพร่)**
1. Create → Blob → ชื่อ `signverse-public` → Access: **Public**
2. Connect (Production + Preview) · Prefix = `PUBLIC_BLOB` → ตรวจว่ามี `PUBLIC_BLOB_STORE_ID`

> ระบบใช้ **Store ID + Vercel OIDC** — Vercel ส่ง OIDC token มากับทุก request เอง จึง**ไม่ต้องมี** `*_READ_WRITE_TOKEN`
> และจะไม่เห็น `VERCEL_OIDC_TOKEN` ในหน้า Environment Variables (ปกติ) · ต้องเปิด OIDC ไว้ (Settings → Security → Secure backend access with OIDC federation — ค่าเริ่มต้นเปิด)
> ถ้ามี `PRIVATE_BLOB_READ_WRITE_TOKEN` / `PUBLIC_BLOB_READ_WRITE_TOKEN` ระบบจะใช้ token ก่อน (ทางเลือก)
> ถ้าตั้งไม่ครบทั้งสอง store หรือ Store ID ซ้ำกัน ระบบไฟล์จะปิด (ตอบ `not_configured`) — ไม่มีทางเก็บไฟล์ลูกค้าใน store Public
> `*_BLOB_WEBHOOK_PUBLIC_KEY` ระบบนี้ไม่ได้ใช้ ปล่อยไว้ได้

## 3. ตั้งค่า Better Auth

ใน Vercel → Settings → Environment Variables (Production):

| ตัวแปร | ค่า |
|---|---|
| `BETTER_AUTH_SECRET` | สุ่มใหม่ด้วยคำสั่ง `openssl rand -base64 32` (อย่างน้อย 32 ตัวอักษร ห้ามแชร์) |
| `BETTER_AUTH_URL` | `https://signverse-azure.vercel.app` (ไม่มี `/` ท้าย) |
| `APP_ORIGIN` | ค่าเดียวกับ `BETTER_AUTH_URL` |

## 4. Google Login (ปิดอยู่)

ระบบเข้าสู่ระบบใช้ **LINE** และ **เบอร์โทรศัพท์ + OTP** เท่านั้น (ค่าเริ่มต้น `AUTH_PROVIDERS=line,phone`)
- ปุ่ม Google ไม่แสดงบนเว็บแม้ยังมี `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` ใน Vercel (ลบออกได้)
- บัญชีที่เคยสมัครด้วย Google ยังอยู่ในฐานข้อมูล ไม่ถูกลบ
- เปิดคืนได้ด้วย `AUTH_PROVIDERS=line,phone,google` แล้ว Redeploy (ต้องตั้ง OAuth Client ตามเดิม: Redirect URI `https://signverse-azure.vercel.app/api/auth/callback/google`)

## 5. LINE Login (ปิดอยู่ — เปิดได้ด้วย `AUTH_PROVIDERS=facebook,line,phone`)

> **LINE Login Channel ≠ Messaging API Channel ของ OA** — ใช้คนละ Channel ID/Secret
> `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` เป็นของ OA (Webhook) **ห้ามนำมาใช้กับ LINE Login** และห้ามแก้

1. เปิด [LINE Developers Console](https://developers.line.biz/console/) → เลือก **Provider เดียวกับ LINE OA @signverse** (สำคัญ: LINE userId จะตรงกันเฉพาะใน Provider เดียวกัน)
2. **Create a new channel** → เลือก **LINE Login** (ถ้าสร้างไว้แล้ว ใช้ Channel เดิม)
   - App types: **Web app** · ใส่ชื่อ ไอคอน อีเมล และลิงก์นโยบายความเป็นส่วนตัว `https://signverse-azure.vercel.app/privacy.html`
3. แท็บ **Basic settings**
   - **Channel ID** → Vercel `LINE_LOGIN_CHANNEL_ID`
   - **Channel secret** → Vercel `LINE_LOGIN_CHANNEL_SECRET`
   - (ไม่บังคับ) **OpenID Connect → Email address permission** → Apply — ถ้าไม่ได้สิทธิ์หรือลูกค้าไม่อนุญาต ระบบยังล็อกอินได้ (ใช้อีเมลแทนภายในระบบ)
4. แท็บ **LINE Login** → **Callback URL**: `https://signverse-azure.vercel.app/api/auth/callback/line`
5. เปลี่ยนสถานะ Channel จาก **Developing** เป็น **Published** (ถ้ายังเป็น Developing จะล็อกอินได้เฉพาะผู้ดูแล Channel)

> `LINE_LOGIN_CHANNEL_ID` ใช้ร่วมกับหน้า LIFF (ตรวจ ID token) อยู่แล้ว — เป็น Channel เดียวกัน
> ชื่อเดิม `LINE_CLIENT_ID` / `LINE_CLIENT_SECRET` ยังใช้ได้ (สำรอง)

## 5.5 เข้าสู่ระบบด้วยเบอร์โทรศัพท์ + OTP (SMS)

**ลำดับสำคัญ — ทำข้อ 1 ก่อนตั้งค่าตัวแปร SMS เสมอ** (เมื่อมีตัวแปร SMS ครบ ระบบจะเปิดใช้ phoneNumber plugin ซึ่งต้องมีคอลัมน์ใหม่ในตาราง `user`)

1. Neon → SQL Editor → รัน `db/schema.sql` ล่าสุดอีกครั้ง (เพิ่มคอลัมน์ `phoneNumber`, `phoneNumberVerified` และตาราง `phone_otp_requests` — เพิ่มอย่างเดียว ไม่แก้ข้อมูลเดิม)
2. สมัคร [ThaiBulkSMS](https://www.thaibulksms.com/) → ซื้อเครดิต → **ลงทะเบียนชื่อผู้ส่ง (Sender name)** และรออนุมัติ
3. ThaiBulkSMS → ตั้งค่า → **API Key** → สร้าง Key แล้วคัดลอก Key และ Secret
4. Vercel → Environment Variables (Production):

| ตัวแปร | ค่า |
|---|---|
| `SMS_PROVIDER` | `thaibulksms` |
| `THAIBULKSMS_API_KEY` / `THAIBULKSMS_API_SECRET` | จากข้อ 3 (ห้ามแชร์) |
| `SMS_SENDER_NAME` | ชื่อผู้ส่งที่อนุมัติแล้ว |
| `OTP_HASH_SECRET` | สุ่มใหม่ `openssl rand -base64 32` (≥ 32 ตัว ห้ามซ้ำกับ secret อื่น) |
| `OTP_DAILY_LIMIT` | เพดาน SMS ทั้งระบบต่อวัน เช่น `200` (กันค่าใช้จ่ายผิดปกติ) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | แนะนำ: Cloudflare Turnstile (ฟรี) กันบอทก่อนส่ง OTP |

5. Redeploy → `/api/me` ต้องมี `"phoneLogin":"ready"`

กฎความปลอดภัยที่ระบบบังคับ: OTP 6 หลัก หมดอายุ 5 นาที · กรอกผิดได้ 5 ครั้งต่อรหัส · ขอรหัสใหม่ได้หลัง 60 วินาที · จำกัด 5 ครั้ง/ชม. และ 10 ครั้ง/วันต่อเบอร์ · 10 ครั้ง/ชม. และ 30 ครั้ง/วันต่อ IP · เพดานรวมต่อวัน · รับเฉพาะเบอร์มือถือไทย · เก็บ OTP/เบอร์/IP เป็น hash · Log ไม่มีเบอร์เต็มหรือ OTP · SMS จำลองใช้ไม่ได้บน Production

## 6. Facebook Login (วิธีหลัก · ค่าเริ่มต้น `AUTH_PROVIDERS=facebook,phone`)

1. เปิด [Meta for Developers](https://developers.facebook.com/apps/) → **Create app** (ใช้บัญชี Facebook ของร้าน/ผู้ดูแล)
2. Use case: **Authenticate and request data from users with Facebook Login** · ประเภทแอป: Consumer/Business ตามที่ Meta แนะนำ
3. **App settings → Basic**
   - **App ID** → Vercel `FACEBOOK_CLIENT_ID` · **App secret** → Vercel `FACEBOOK_CLIENT_SECRET` (ห้ามแชร์ / ห้ามใส่ในโค้ด)
   - **App domains**: `signverse-azure.vercel.app`
   - **Privacy Policy URL**: `https://signverse-azure.vercel.app/privacy.html`
   - **User data deletion** → เลือก "Data deletion instructions URL": `https://signverse-azure.vercel.app/privacy.html#data-deletion`
   - หมวดหมู่ ไอคอนแอป (1024×1024) และอีเมลติดต่อ
4. **Facebook Login → Settings**
   - **Valid OAuth Redirect URIs**: `https://signverse-azure.vercel.app/api/auth/callback/facebook` (ต้องตรงทุกตัวอักษร)
   - Client OAuth login: On · Web OAuth login: On · Enforce HTTPS: On
5. **Permissions**: ระบบขอเฉพาะ `public_profile` (ชื่อ + รูปโปรไฟล์) — **ไม่ขออีเมล** ไม่ต้องส่ง App Review สำหรับสิทธิ์เพิ่มเติม
6. สลับ **App mode** จาก Development เป็น **Live** (ถ้ายังเป็น Development ล็อกอินได้เฉพาะผู้ดูแล/ผู้ทดสอบของแอป) — Meta อาจขอยืนยันธุรกิจ (Business Verification)
7. Vercel → ตั้งค่า 2 ตัวแปรด้านบน (Production) → Redeploy → `/api/me` ต้องมี `"providers":["facebook"]`

> สมาชิก Facebook ถูกระบุด้วย **Facebook User ID** เท่านั้น (ไม่ใช้อีเมล) → เข้าสู่ระบบซ้ำได้บัญชีเดิม และไม่ถูกรวมกับบัญชี LINE/Google/เบอร์โทรเดิมโดยอัตโนมัติ
> บัญชี LINE / Google เดิมยังอยู่ในฐานข้อมูล · เปิดคืนได้ด้วย `AUTH_PROVIDERS` เช่น `facebook,line,phone`
> เบอร์โทรจะแสดง "กำลังเตรียมเปิดใช้งาน" (กดไม่ได้) จนกว่าจะตั้งค่า SMS จริงตามข้อ 5.5

## 6.5 LINE OA @signverse — ส่งคำสั่งผลิตเข้าแชตของลูกค้า

> ใช้ LINE OA เดิมที่พนักงานตอบแชตอยู่แล้ว **ไม่ใช้กลุ่ม LINE ไม่ต้องมี Group ID**
> ระบบส่งเข้ากลุ่มแบบเดิม **ปิดสมบูรณ์** (ไม่ตั้ง `LINE_GROUP_ORDERS_ENABLED` · push ถูกปิดที่ระดับโค้ดอีกชั้น)
> ⚠️ ห้ามเปิดใช้ LINE จริงจนกว่าเจ้าของร้านอนุมัติ

### ภาพรวมการทำงาน
**ทาง A (หลัก)**: ลูกค้ากด "สั่งผลิตป้ายนี้" → ระบบ **บันทึกออร์เดอร์ก่อน** (เลขออร์เดอร์ + รหัสยืนยัน) → มือถือ: LINE เปิดแชต @signverse พร้อมข้อความ / คอมพิวเตอร์: คัดลอกไปวาง → **ลูกค้ากดส่งเอง** → Webhook ตรวจลายเซ็น + รหัส → **OA ตอบกลับ (Reply) ด้วยข้อความยืนยัน + รูป Artwork + Mockup ในแชตเดียวกัน**
**ทาง B (Rich Menu ในอนาคต)**: ลูกค้าเปิดหน้า LIFF จากเมนูในแชต → กด "ส่งแบบเข้าแชตนี้" → ส่งข้อความ + รูป **ในนามลูกค้า** (`liff.sendMessages` ใช้ได้เฉพาะเมื่อเปิดจากห้องแชต)

**กติกาที่ระบบบังคับ**
- ตอบเฉพาะข้อความที่มี **เลขออร์เดอร์ + รหัสยืนยันที่ถูกต้อง** — ข้อความอื่นไม่ตอบ (พนักงานตอบแชตได้ตามปกติ)
- Reply ไปยังห้องของผู้ส่งข้อความนั้นเท่านั้น · ส่งครั้งเดียวต่อออร์เดอร์ (Webhook ซ้ำ/ข้อความซ้ำ/พร้อมกัน → ไม่ส่งซ้ำ)
- ผูกออร์เดอร์กับ LINE userId ที่ LINE ยืนยัน (Webhook ลงลายเซ็น / LIFF ID token) — ถ้าลูกค้าล็อกอินเว็บด้วย LINE ต้องเป็นบัญชีเดียวกัน
- **LINE userId ตรงกันข้ามช่องทางได้เฉพาะเมื่อ LINE Login, LIFF และ Messaging API อยู่ใน Provider เดียวกัน** (คนละ Provider = คนละ userId)
- รูปเป็นลิงก์ HTTPS มีลายเซ็น HMAC (ผูกกับงาน + ชนิดภาพ + วันหมดอายุ) อายุ `FILE_URL_TTL_DAYS` (ค่าเริ่มต้น 30 วัน) · ไฟล์จริงอยู่ใน Private Blob · เปลี่ยน `FILE_SIGNING_SECRET` = ลิงก์เดิมทั้งหมดใช้ไม่ได้ทันที
- ไม่มี `FILE_SIGNING_SECRET` (หรือสั้นกว่า 32 ตัว) → ระบบ **ไม่ส่งรูป** ส่งเฉพาะข้อความยืนยัน
- Reply ใช้ได้เฉพาะเมื่อลูกค้าส่งข้อความมา (replyToken ใช้ครั้งเดียว ~1 นาที) — ไม่ใช่ช่องทางส่งออร์เดอร์เอง · Reply **ไม่นับโควตาข้อความรายเดือน**
- สถานะการส่ง (แยกจากสถานะการผลิต): รอส่งผ่าน LINE → กำลังส่ง → ส่งผ่าน LINE สำเร็จ / ไม่สำเร็จ · บันทึก `x-line-request-id` เป็นหลักฐาน
- "ส่งผ่าน LINE สำเร็จ" = **LINE API รับข้อความแล้ว ไม่ได้แปลว่าพนักงานเห็นแล้ว**

---

### ช่วงที่ 1 — ตั้งค่าได้ทันที (ก่อน Deploy · ยังไม่เปิดใช้งานจริง)
1. **ตรวจ Provider**: LINE Developers Console → ยืนยันว่า LINE Login channel (ข้อ 5) และ OA @signverse จะอยู่ใน **Provider เดียวกัน** (ย้าย channel ข้าม Provider ภายหลังไม่ได้)
2. **LINE Official Account Manager → ตั้งค่า → Messaging API** → เปิดใช้งาน → เลือก Provider ข้างต้น (ระบบสร้าง Messaging API channel ให้)
3. **LINE Developers Console → Messaging API channel ของ @signverse**
   - Basic settings → คัดลอก **Channel secret**
   - Messaging API → **Channel access token (long-lived) → Issue** → คัดลอก
   - **ยังไม่ต้องใส่ Webhook URL / ยังไม่เปิด Use webhook** (ทำในช่วงที่ 2)
4. **Vercel → Settings → Environment Variables** (Production + Preview):
   | ตัวแปร | ค่า |
   |---|---|
   | `LINE_CHANNEL_SECRET` | Channel secret |
   | `LINE_CHANNEL_ACCESS_TOKEN` | Long-lived token (ใช้ Reply เท่านั้น) |
   | `FILE_SIGNING_SECRET` | สุ่มใหม่ `openssl rand -base64 48` (≥32 ตัว · ห้ามใช้ค่าเดียวกับ secret อื่น) |
   | `LINE_OA_ID` | `@signverse` |
   | `FILE_URL_TTL_DAYS` | (ไม่บังคับ) 1–60 · ค่าเริ่มต้น 30 |
   | `LINE_ORDERS_ENABLED` | **ไม่ต้องตั้ง** (= off: ไม่มีปุ่มสั่งผลิตผ่าน LINE และ Webhook ไม่ตอบใคร) · ช่วงทดสอบ = `staff` · เปิดให้ลูกค้าทุกคน = `on` (หลังผ่านการทดสอบช่วงที่ 3 เท่านั้น) |
   | `LINE_GROUP_ORDERS_ENABLED` | **ไม่ต้องตั้ง** |
5. (ทาง B — ทำภายหลังได้) LINE Login channel → แท็บ **LIFF → Add**: Size Full · Endpoint `https://signverse-azure.vercel.app/liff/order.html` · Scopes `openid`, `chat_message.write` · Bot link **On** กับ @signverse → ใส่ `LIFF_ID` และ `LINE_LOGIN_CHANNEL_ID` ใน Vercel
6. **แนะนำ**: สร้าง **LINE OA สำหรับทดสอบ** (ฟรี) ใน Provider เดียวกัน และใช้ค่าข้างต้นของ OA ทดสอบใน Preview ก่อน

### ช่วงที่ 2 — หลัง Deploy (ต้องได้รับอนุมัติ Deploy ก่อน)
1. LINE Developers → Messaging API channel → **Webhook URL**: `https://<โดเมน>/api/line/webhook` → **Verify** ต้องได้ Success
2. เปิด **Use webhook**
3. LINE OA Manager → **ตั้งค่าการตอบกลับ**:
   - **แชต: เปิด** (พนักงานตอบแชตได้เหมือนเดิม) · **Webhook: เปิด** — LINE อนุญาตให้ใช้ร่วมกันได้
   - **ข้อความตอบกลับอัตโนมัติ (Auto-reply)**: ถ้าใช้อยู่ ตรวจว่าไม่มีคำสำคัญที่ตรงกับ "สั่งผลิตงานป้าย" / "รหัสยืนยัน" / "SV" (กันตอบซ้อนกับระบบ) — ถ้าตั้ง Auto-reply แบบ "ตอบทุกข้อความ" ลูกค้าจะได้ทั้งข้อความอัตโนมัติและรูปจากระบบ
   - ข้อความทักทาย: ใช้ตามเดิมได้ (ไม่กระทบระบบ)
4. หลังบ้าน → แท็บ **LINE OA** → ตรวจว่า Webhook "พร้อม", Reply "พร้อม", ลิงก์รูป "พร้อม", ระบบกลุ่ม "ปิด"

### ช่วงที่ 3 — ทดสอบกับ LINE OA จริง (ต้องได้รับอนุมัติก่อนทุกครั้ง · ใช้ OA ทดสอบก่อน)
> ตั้ง `LINE_ORDERS_ENABLED=staff` แล้ว Redeploy → ปุ่ม "สั่งผลิตป้ายนี้" และการตอบกลับจะทำงานเฉพาะออร์เดอร์ของ **บัญชีพนักงาน/ผู้ดูแล** · ลูกค้าทั่วไปยังไม่เห็น
> ผ่านทุกข้อ (โดยเฉพาะข้อ 4) และเจ้าของร้านอนุมัติ → ค่อยเปลี่ยนเป็น `on`

| # | ทดสอบ | ผลที่ต้องได้ |
|---|---|---|
| 1 | Webhook → Verify | Success |
| 2 | ส่งข้อความทั่วไป "สวัสดี" | ระบบไม่ตอบ · พนักงานเห็นและตอบใน OA Manager ได้ตามปกติ |
| 3 | สั่งผลิตจากเว็บ (มือถือ) → กดส่งข้อความใน LINE | ลูกค้าได้ข้อความยืนยัน + รูป 2 รูป · หน้าเว็บขึ้น "ส่งผ่าน LINE สำเร็จ" |
| 4 | **ดูใน LINE OA Manager → Chat (ฝั่งพนักงาน)** | ข้อความลูกค้า (มีเลขออร์เดอร์) ✔ · **รูป/ข้อความที่ OA ส่งผ่าน API ปรากฏหรือไม่ = ยังไม่มีเอกสารยืนยัน ต้องดูจากการทดสอบนี้** |
| 5 | ส่งข้อความเดิมซ้ำ | ไม่ได้รูปซ้ำ |
| 6 | ใช้บัญชี LINE อื่นส่งข้อความเดียวกัน | ได้ข้อความ "ไม่สามารถยืนยันออร์เดอร์นี้…" ไม่ได้รูป |
| 7 | สั่งผลิตจากคอมพิวเตอร์ → คัดลอกไปวางใน LINE PC | ได้รูปเหมือนข้อ 3 |
| 8 | หลังบ้าน → ออร์เดอร์ | สถานะการส่ง "ส่งผ่าน LINE สำเร็จ" + Request ID + เปิดภาพได้ |
| 9 | (ทาง B) เปิด LIFF จาก Rich Menu → ส่งแบบ | ข้อความ + รูปส่งในนามลูกค้า · เปิด LIFF จาก Chrome ต้องขึ้นว่า "กรุณาเปิดจากเมนูในห้องแชต" |

**ถ้าข้อ 4 พบว่ารูปที่ OA ส่งไม่ปรากฏในหน้าแชตพนักงาน** (ต้องตัดสินใจก่อนเปิดใช้จริง):
- พนักงานยังเห็นเลขออร์เดอร์ในข้อความลูกค้า → เปิดดูภาพที่หลังบ้าน แท็บ **ออร์เดอร์** (พร้อมใช้แล้ว)
- หรือเปิด **ทาง B (LIFF)** ให้ลูกค้าเป็นผู้ส่งรูป (ข้อความจากลูกค้าแสดงในแชตพนักงาน) — ขั้นตอนลูกค้าเพิ่มขึ้น

## 6.55 AI สร้างภาพจริง (OpenAI GPT Image 2 + ลายน้ำ)

> มีค่าใช้จ่าย — GPT Image 2 ขนาด 1536×1024: Medium ~$0.041/ภาพ, High ~$0.165/ภาพ (ราคาทางการ ต.ค. 2026) · 1 งาน = Artwork + Mockup
> ลายน้ำ SIGN VERSE • PREVIEW ใส่ฝั่ง Server ด้วย `sharp` · ต้นฉบับไม่มีลายน้ำเก็บใน Private Blob เท่านั้น

1. OpenAI → **Organization verification** (ถ้า OpenAI ขอ) และตั้ง **Usage limit / Budget ต่อเดือน** ใน Billing เป็นชั้นป้องกันสุดท้าย (เช่น $50)
2. Neon → รัน `db/schema.sql` ล่าสุด (เพิ่ม `artwork_original_key`, `mockup_original_key`, `cost_usd`)
3. Vercel → Environment Variables (Production):

| ตัวแปร | ค่า |
|---|---|
| `AI_PROVIDER` | `openai` |
| `OPENAI_API_KEY` | มีอยู่แล้ว (ใช้ร่วมกับสรุปบรีฟ) |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` (ค่าเริ่มต้น) |
| `AI_IMAGE_QUALITY` | `medium` (ค่าเริ่มต้น) · `high` แพงขึ้น ~4 เท่า |
| `AI_ACCESS` | ไม่ตั้ง = **เฉพาะพนักงานทดสอบ** · `members` = เปิดให้สมาชิก (และ Guest ถ้าเปิด `GUEST_AI_ENABLED`) |
| `AI_DAILY_BUDGET_THB` / `AI_MONTHLY_BUDGET_THB` | `200` / `1500` |

4. Redeploy → พนักงานล็อกอินแล้วทดสอบสร้างภาพ (ไม่ใช้เครดิตลูกค้า แต่นับในงบรวม)

### โหมดทดสอบ AI จริงสำหรับเจ้าของเว็บ (ไม่ต้องสมัครสมาชิก · งบแยก)

ใช้ทดสอบ OpenAI จริงผ่านหน้าเว็บจริงก่อนเปิดให้ลูกค้า — ผู้เข้าชมทั่วไปใช้ไม่ได้ (ต้องมีรหัส · ตรวจที่ Server)

1. ต้องรัน `db/schema.sql` ล่าสุดแล้ว (คอลัมน์ `guest_id`, `cost_usd`, `artwork_original_key`)
2. OpenAI → Billing → ตั้ง **Project budget / Usage limit** เช่น $3 เป็นชั้นป้องกันสุดท้าย (ยอดเรียกเก็บจริงดูที่ OpenAI)
3. Vercel → Environment Variables (Production):

| ตัวแปร | ค่า |
|---|---|
| `AI_PROVIDER` | `openai` |
| `AI_TEST_MODE` | `true` (ลบออก = ปิดโหมดทดสอบทันทีหลัง Redeploy) |
| `AI_TEST_CODE` | รหัสทดสอบยาว ≥ 12 ตัว เช่นสุ่มด้วย `openssl rand -base64 18` (ห้ามแชร์ · เปลี่ยนรหัส = เซสชันเดิมใช้ไม่ได้) |
| `AI_TEST_BUDGET_THB` | `100` (ค่าเริ่มต้น) — งบทดลองรวม แยกจากงบใช้งานจริง |
| `AI_TEST_MAX_JOBS` | `12` (ค่าเริ่มต้น) — จำนวนงานทดสอบสูงสุด (1 งาน = Artwork + Mockup) |
| `AI_TEST_SESSION_MINUTES` | `120` (ค่าเริ่มต้น) — อายุเซสชันทดสอบ |

ไม่ต้องตั้ง `AI_ACCESS` และ `GUEST_AI_ENABLED` (ลูกค้ายังใช้ไม่ได้)

4. Redeploy → เปิด `https://signverse-azure.vercel.app/?aitest#ai-design` → กรอกรหัสทดสอบ → กรอกฟอร์ม/อัปโหลดรูป → กด "สร้างภาพป้ายด้วย AI จริง (โหมดทดสอบ)"
5. หน้าเว็บแสดงยอดใช้ไปโดยประมาณ (คำนวณจาก usage ที่ OpenAI ส่งกลับ) — **ยอดเรียกเก็บจริงอาจต่างเล็กน้อย** ให้ตรวจที่ OpenAI → Usage ด้วย

ระบบหยุดเองเมื่อ: ยอดใช้ไป + ค่าประมาณงานถัดไป (8 บาท) เกินงบ · ครบจำนวนงาน · รหัสผิดเกิน 5 ครั้ง/15 นาที/IP

### Cloudflare Turnstile (กันบอท — ต้องตั้งก่อนเปิด Guest AI)
1. dash.cloudflare.com → **Turnstile** → **Add widget** → Hostname `signverse-azure.vercel.app` → Widget mode **Managed**
2. Vercel → `TURNSTILE_SITE_KEY` (Site Key) และ `TURNSTILE_SECRET_KEY` (Secret Key) → Redeploy
3. หน้าเว็บแสดงกรอบยืนยันก่อนสร้างภาพ · Server ตรวจโทเคนทุกครั้ง (ไม่ผ่าน = ไม่สร้างภาพ ไม่หักสิทธิ์)

## 6.6 สร้างภาพ AI ฟรีโดยไม่ต้องสมัครสมาชิก (Guest · เปิดชั่วคราว)

**ต้องมี AI จริงก่อน** — ถ้ายังไม่มี ระบบจะแสดง "กำลังเตรียมเปิดบริการ" (ปุ่มกดไม่ได้) และไม่ใช้ Mock AI กับลูกค้าเด็ดขาด

1. Neon → SQL Editor → รัน `db/schema.sql` ล่าสุด (เพิ่มคอลัมน์ `guest_id` ใน `ai_jobs` / `customer_uploads` — ไม่แก้ข้อมูลเดิม)
2. Vercel → Environment Variables (Production):

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `GUEST_AI_ENABLED` | (ปิด) | `true` = เปิดให้สร้างภาพโดยไม่ต้องล็อกอิน · ลบออก = กลับไปใช้ระบบสมาชิกทันที |
| `GUEST_AI_PER_GUEST_DAY` | `2` | งานต่อผู้ใช้ (cookie) ต่อวัน |
| `GUEST_AI_PER_IP_DAY` | `4` | งานต่อ IP ต่อวัน (กันล้าง cookie แล้วขอใหม่) |
| `GUEST_AI_DAILY_TOTAL` | `40` | งาน Guest ทั้งระบบต่อวัน |
| `AI_DAILY_BUDGET_THB` | `200` | งบ AI ทั้งระบบต่อวัน (สมาชิก + พนักงาน + Guest) — ถึงวงเงิน = ไม่รับงาน AI ใหม่จนถึงเที่ยงคืน |
| `AI_MONTHLY_BUDGET_THB` | `1500` | งบ AI ทั้งระบบต่อเดือน — ถึงวงเงิน = ปิดอัตโนมัติจนถึงต้นเดือน |
| `AI_COST_PER_JOB_THB` | `8` | ค่าประมาณสำหรับงานที่ยังไม่รู้ค่าใช้จ่ายจริง (งานที่เสร็จใช้ค่าจริงจาก OpenAI) |
| `AI_USD_THB` | `36` | อัตราแลกเปลี่ยนสำหรับคำนวณงบ |
| `GUEST_FILE_RETENTION_DAYS` | `7` | เก็บรูป/ภาพของ Guest กี่วันแล้วลบอัตโนมัติ |
| `GUEST_SIGNING_SECRET` | (ใช้ `BETTER_AUTH_SECRET`) | ไม่บังคับ: กุญแจลงลายเซ็น cookie Guest (≥ 32 ตัว) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | — | **แนะนำมาก**: กันบอทกดสร้างภาพ (ฟรี) |

3. Redeploy → `/api/me` (ไม่ล็อกอิน) ต้องได้ `"aiStatus":"guest_ready"`

> Guest สั่งผลิตผ่าน LINE OA ของร้าน (ปุ่ม "ส่งแบบนี้ให้ทีมงานทาง LINE") · งาน/ไฟล์ของ Guest แยกจากสมาชิก ไม่กระทบโควตาสมาชิก

## 7. ตัวแปรอื่น ๆ (Vercel → Environment Variables)

| ตัวแปร | ค่าแนะนำ | หน้าที่ |
|---|---|---|
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `FILE_SIGNING_SECRET` / `LINE_OA_ID` | ดูข้อ 6.5 | ส่งคำสั่งผลิตเข้าแชต LINE OA |
| `CRON_SECRET` | สุ่มด้วย `openssl rand -base64 32` | ป้องกัน endpoint ลบไฟล์หมดอายุ (Vercel Cron ใช้อัตโนมัติ) |
| `AI_FREE_CREDITS` | `1` | สิทธิ์ทดลองต่อบัญชีใหม่ (1 = Artwork + Mockup 1 ชุด) |
| `AI_DAILY_JOB_LIMIT` | `20` | งาน AI สูงสุดต่อวันทั้งเว็บ (กันค่าใช้จ่ายบานปลาย) |
| `CUSTOMER_FILE_RETENTION_DAYS` | `90` | เก็บภาพลูกค้า/ภาพ AI กี่วัน |
| `GALLERY_TRASH_DAYS` | `30` | รูปในถังขยะถูกลบถาวรหลังกี่วัน |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | (ไม่บังคับ) | Cloudflare Turnstile กันบอท — ใส่เมื่อสมัครแล้ว |
| `AI_PROVIDER` | **เว้นว่าง** หรือ `mock` | `mock` = Mock AI (รูป PNG ตัวอย่าง ไม่มีค่าใช้จ่าย) **ใช้ได้เฉพาะบัญชี staff/admin** ตรวจที่ Server · ไม่ใช้เครดิตของใคร · ลูกค้าทั่วไปไม่เห็นส่วน AI · AI จริงยังไม่เปิด (รอระบบลายน้ำ) |

**ห้ามตั้ง `MOCK_SERVICES` บน Production** (ระบบจะปฏิเสธเอง)

หลังตั้งค่าทั้งหมด → Deployments → **Redeploy**

## 8. สร้างบัญชีผู้ดูแล (Admin) คนแรกอย่างปลอดภัย

ไม่มีรหัสผ่านเริ่มต้นและไม่มีหน้าสมัคร Admin — ต้องยกสิทธิ์จากฐานข้อมูลเท่านั้น

1. เปิดเว็บไซต์ → กด **เข้าสู่ระบบ** ด้วย Facebook (หรือเบอร์โทรศัพท์เมื่อเปิดใช้) ของเจ้าของร้าน 1 ครั้ง
2. Neon Console → SQL Editor → หาบัญชีของคุณ แล้วยกสิทธิ์ด้วย `id` (บัญชีเบอร์โทร/LINE อาจใช้อีเมลแทนภายในระบบ จึงไม่ควรค้นด้วยอีเมล):
   ```sql
   -- บัญชีเบอร์โทร: ค้นด้วยเบอร์แบบ +66 (เช่น 081-234-5678 → +66812345678) · บัญชี Facebook: ดูจากชื่อ Facebook
   SELECT "id", "name", "phoneNumber", "role", "createdAt" FROM "user" ORDER BY "createdAt" DESC LIMIT 5;
   UPDATE "user" SET "role" = 'admin' WHERE "id" = 'id ของคุณจากคำสั่งด้านบน';
   ```
3. เปิด `https://signverse-azure.vercel.app/admin/` → จะเห็นหลังบ้าน
4. ให้พนักงานล็อกอินที่เว็บ 1 ครั้ง แล้ว Admin ไปที่ **จัดการสิทธิ์ AI** → ค้นหาพนักงาน → เปลี่ยนสิทธิ์เป็น `staff`

---

## การทดสอบหลังตั้งค่า

1. เปิด `https://<โดเมน>/api/auth/get-session` → ควรได้ `null` (ไม่ใช่ 404) แปลว่า Better Auth ทำงาน
   - ถ้าได้ 404: ตรวจว่า `vercel.json` มี rewrite `/api/auth/:path*` → `/api/auth`
2. เปิด `https://<โดเมน>/api/me` → `providers` ต้องมีเฉพาะรายที่ตั้งค่าแล้ว
3. กด "สร้างภาพป้ายด้วย AI ฟรี" ขณะยังไม่ล็อกอิน → ต้องเห็นหน้าต่างล็อกอิน → ล็อกอิน → กลับมาที่ฟอร์ม ข้อมูลยังอยู่
4. ในหลังบ้าน → สร้างอัลบั้ม → อัปโหลดรูป → กด "เผยแพร่" ทั้งรูปและอัลบั้ม → ภายใน ~1 นาที รูปต้องปรากฏใน "เลือกจากผลงาน SIGN VERSE"
5. ปุ่มสร้างภาพจะแจ้ง "ระบบสร้างภาพ AI ยังไม่เปิดใช้งาน" จนกว่าจะเปิด AI จริง (ถูกต้องตามแผน)

## ตรวจสอบ Quota / เพิ่มสิทธิ์ให้ลูกค้า

- หลังบ้าน → **จัดการสิทธิ์ AI** → ค้นหาด้วยชื่อ/อีเมล → เห็น "ใช้ x/y · คงเหลือ z"
- **เพิ่มสิทธิ์** (เฉพาะ Admin): ใส่จำนวน (1–20) + หมายเหตุ → กด "เพิ่มสิทธิ์" → บันทึกในแท็บ **ประวัติ**
- **งานที่ต้องตรวจสอบ**: งานที่ค้าง/ไม่แน่ใจผล → Admin เลือก "คืนสิทธิ์" หรือ "ปิดงาน"
- ตรวจด้วย SQL ได้: `SELECT * FROM ai_quota WHERE user_id = '...';`

## ทดสอบในเครื่อง (Mock — ไม่ใช้บริการจริง)

```
cd ~/Desktop/"curser ai"
ELECTRON_RUN_AS_NODE=1 "/Applications/Cursor.app/Contents/MacOS/Cursor" tools/dev-server.mjs
```
เปิด http://localhost:3000 (หน้าเว็บ) และ http://localhost:3000/admin/ (หลังบ้าน — มีปุ่มล็อกอินทดสอบ)
รันชุดทดสอบ: `ELECTRON_RUN_AS_NODE=1 "/Applications/Cursor.app/Contents/MacOS/Cursor" --test tests/*.test.*`
(ถ้าติดตั้ง Node.js แล้ว ใช้ `node tools/dev-server.mjs` และ `npm test` ได้เลย)

## ค่าใช้จ่าย (ตรวจ ณ ต.ค. 2026)

| บริการ | ฟรี | เกินแล้ว |
|---|---|---|
| Neon | 1 GB, 100 CU-ชม./เดือน | ฐานข้อมูลหยุดจนรอบถัดไป หรืออัปเกรด Launch (จ่ายตามใช้) |
| Vercel Blob (Hobby) | 1 GB, รับส่งข้อมูล 10 GB/เดือน | Blob ใช้งานไม่ได้ 30 วัน (ไม่เก็บเงิน) · Pro คิดตามใช้ |
| Better Auth / Facebook Login | ฟรี | — |
| SMS OTP (ThaiBulkSMS) | ประมาณ 0.15–0.48 บาท/SMS ตามแพ็กเกจ | ซื้อเครดิตล่วงหน้า · ตั้ง `OTP_DAILY_LIMIT` กันค่าใช้จ่ายผิดปกติ |
| Vercel Cron | 1 งาน/วัน (ฟรีบน Hobby) | — |
| AI สร้างภาพ (เมื่อเปิดจริง) | — | ประมาณ 4–9 บาท/ชุด × จำนวนผู้ใช้สิทธิ์ (จำกัดด้วย `AI_DAILY_JOB_LIMIT`) |
| Vercel Hobby | ใช้ได้เฉพาะงานส่วนตัว/ไม่ใช่เชิงพาณิชย์ | เว็บธุรกิจควรใช้ Pro $20/เดือน |
