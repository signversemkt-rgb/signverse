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

> แนะนำตั้ง Function Region ของ Vercel เป็น Singapore ด้วย (Settings → Functions → Region → `sin1`) เพื่อให้ API อยู่ใกล้ฐานข้อมูล

## 2. Vercel Blob 2 ชุด (ฟรี)

**ชุดที่ 1 — Private (ภาพลูกค้า / ภาพ AI / ต้นฉบับรูปผลงาน)**
1. Storage → **Create** → **Blob** → ชื่อ `signverse-private` → Access: **Private**
2. ตอน Connect กับโปรเจกต์ ตั้ง **Environment Variables Prefix** = `PRIVATE_BLOB`
3. ตรวจว่ามีตัวแปร `PRIVATE_BLOB_READ_WRITE_TOKEN` ใน Settings → Environment Variables

**ชุดที่ 2 — Public (เฉพาะรูปผลงานที่กดเผยแพร่)**
1. Create → Blob → ชื่อ `signverse-public` → Access: **Public**
2. Prefix = `PUBLIC_BLOB` → ตรวจว่ามี `PUBLIC_BLOB_READ_WRITE_TOKEN`

> ถ้า Vercel ตั้งชื่อตัวแปรต่างจากนี้ ให้เพิ่มตัวแปรชื่อตามคู่มือเอง แล้วคัดลอกค่า token มาใส่
> ห้ามใช้ store Public เก็บภาพลูกค้า — โค้ดแยกให้แล้ว แค่อย่าสลับ token

## 3. ตั้งค่า Better Auth

ใน Vercel → Settings → Environment Variables (Production):

| ตัวแปร | ค่า |
|---|---|
| `BETTER_AUTH_SECRET` | สุ่มใหม่ด้วยคำสั่ง `openssl rand -base64 32` (อย่างน้อย 32 ตัวอักษร ห้ามแชร์) |
| `BETTER_AUTH_URL` | `https://signverse-azure.vercel.app` (ไม่มี `/` ท้าย) |
| `APP_ORIGIN` | ค่าเดียวกับ `BETTER_AUTH_URL` |

## 4. Google Login

1. เปิด [Google Cloud Console](https://console.cloud.google.com/) → สร้างโปรเจกต์ใหม่ เช่น `SIGN VERSE`
2. **Google Auth Platform** (หรือ APIs & Services → OAuth consent screen)
   - **Branding**: ชื่อแอป `SIGN VERSE`, อีเมลติดต่อ, โลโก้, ลิงก์นโยบายความเป็นส่วนตัว, โดเมน `signverse-azure.vercel.app`
   - **Audience**: User type **External**
   - **Data access**: ใช้เฉพาะ `openid`, `email`, `profile`
3. **Clients** → **Create client** → Application type **Web application**
   - Authorized JavaScript origins: `https://signverse-azure.vercel.app`
   - Authorized redirect URIs: `https://signverse-azure.vercel.app/api/auth/callback/google`
4. คัดลอก **Client ID** และ **Client secret** → ใส่ใน Vercel
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
5. Audience → **Publish app** (ถ้ายังเป็น Testing จะล็อกอินได้เฉพาะอีเมลที่เพิ่มเป็น Test users)

## 5. LINE Login

1. เปิด [LINE Developers Console](https://developers.line.biz/console/) → ล็อกอินด้วยบัญชี LINE ของร้าน
2. **Create a new provider** → ชื่อ `SIGN VERSE`
3. ใน Provider → **Create a new channel** → เลือก **LINE Login**
   - App types: **Web app**, ใส่ชื่อ/ไอคอน/อีเมล/ลิงก์นโยบายความเป็นส่วนตัว
4. แท็บ **Basic settings**
   - **Channel ID** → `LINE_CLIENT_ID`
   - **Channel secret** → `LINE_CLIENT_SECRET`
   - **OpenID Connect → Email address permission** → กด **Apply** (ต้องแนบนโยบายความเป็นส่วนตัวและภาพหน้าจอที่แจ้งการขออีเมล) — **จำเป็น** เพราะระบบสมาชิกใช้อีเมลเป็นข้อมูลบัญชี
5. แท็บ **LINE Login** → Callback URL: `https://signverse-azure.vercel.app/api/auth/callback/line`
6. เปลี่ยนสถานะ Channel จาก **Developing** เป็น **Published** (ถ้ายังเป็น Developing จะล็อกอินได้เฉพาะผู้ดูแล channel)

## 6. Facebook Login

1. เปิด [Meta for Developers](https://developers.facebook.com/apps/) → **Create app**
2. Use case: **Authenticate and request data from users with Facebook Login**
3. **App settings → Basic**
   - **App ID** → `FACEBOOK_CLIENT_ID`, **App secret** → `FACEBOOK_CLIENT_SECRET`
   - ใส่ Privacy Policy URL, **User data deletion** (URL หรือคำแนะนำการลบข้อมูล), หมวดหมู่, ไอคอนแอป
4. **Facebook Login → Settings** → Valid OAuth Redirect URIs:
   `https://signverse-azure.vercel.app/api/auth/callback/facebook`
5. Permissions: ใช้เฉพาะ `public_profile` และ `email`
6. เปลี่ยน App mode เป็น **Live** — Meta อาจขอ **Business Verification / App Review** ซึ่งอาจใช้เวลาหลายวัน

> **หมายเหตุ:** ปุ่มบนเว็บจะแสดงเฉพาะ provider ที่ตั้งค่า Client ID + Secret ครบแล้วเท่านั้น
> ถ้ายังไม่ได้ตั้งค่าทั้ง 3 ราย ปุ่ม "เข้าสู่ระบบ" จะถูกซ่อนและหน้าต่างล็อกอินจะแจ้งว่า "รอเปิดใช้งาน"

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
| `AI_PROVIDER` | **เว้นว่าง** | `mock` ใช้ทดสอบบน Preview เท่านั้น · AI จริงยังไม่เปิด (รอระบบลายน้ำ) |

**ห้ามตั้ง `MOCK_SERVICES` บน Production** (ระบบจะปฏิเสธเอง)

หลังตั้งค่าทั้งหมด → Deployments → **Redeploy**

## 8. สร้างบัญชีผู้ดูแล (Admin) คนแรกอย่างปลอดภัย

ไม่มีรหัสผ่านเริ่มต้นและไม่มีหน้าสมัคร Admin — ต้องยกสิทธิ์จากฐานข้อมูลเท่านั้น

1. เปิดเว็บไซต์ → กด **เข้าสู่ระบบ** ด้วยบัญชี Google/LINE/Facebook ของเจ้าของร้าน 1 ครั้ง
2. Neon Console → SQL Editor → รัน (เปลี่ยนอีเมลเป็นของคุณ):
   ```sql
   SELECT "id", "name", "email", "role" FROM "user" ORDER BY "createdAt" DESC LIMIT 5;
   UPDATE "user" SET "role" = 'admin' WHERE "email" = 'อีเมลของคุณ';
   ```
3. เปิด `https://signverse-azure.vercel.app/admin/` → จะเห็นหลังบ้าน
4. ให้พนักงานล็อกอินที่เว็บ 1 ครั้ง แล้ว Admin ไปที่ **จัดการสิทธิ์ AI** → ค้นหาพนักงาน → เปลี่ยนสิทธิ์เป็น `staff`

---

## การทดสอบหลังตั้งค่า

1. เปิด `https://<โดเมน>/api/auth/get-session` → ควรได้ `null` (ไม่ใช่ 404) แปลว่า Better Auth ทำงาน
   - ถ้าได้ 404: แจ้งผู้พัฒนาเพื่อเพิ่ม rewrite `/api/auth/(.*)` (Vercel บางเวอร์ชันไม่รองรับไฟล์ `[...all]`)
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
| Better Auth / Google / LINE / Facebook Login | ฟรี | — |
| Vercel Cron | 1 งาน/วัน (ฟรีบน Hobby) | — |
| AI สร้างภาพ (เมื่อเปิดจริง) | — | ประมาณ 4–9 บาท/ชุด × จำนวนผู้ใช้สิทธิ์ (จำกัดด้วย `AI_DAILY_JOB_LIMIT`) |
| Vercel Hobby | ใช้ได้เฉพาะงานส่วนตัว/ไม่ใช่เชิงพาณิชย์ | เว็บธุรกิจควรใช้ Pro $20/เดือน |
