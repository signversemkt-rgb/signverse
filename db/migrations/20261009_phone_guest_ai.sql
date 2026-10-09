-- SIGN VERSE — Migration 2026-10-09: เบอร์โทร/OTP + Guest/โหมดทดสอบ AI + AI จริง (ต้นฉบับ/ค่าใช้จ่าย)
-- สำหรับฐานข้อมูลที่รัน db/schema.sql รุ่นก่อนหน้าแล้ว (16 ตาราง) — เนื้อหาเดียวกับส่วนท้ายของ db/schema.sql
--
-- ความปลอดภัย:
--   - เพิ่มคอลัมน์/ตาราง/index/ข้อบังคับเท่านั้น · ไม่มี DROP TABLE / DELETE / TRUNCATE / UPDATE / เปลี่ยนชนิดคอลัมน์
--   - DROP CONSTRAINT ใช้เฉพาะเพื่อสร้างข้อบังคับเดิมใหม่ให้รองรับค่ามากขึ้น (ข้อมูลเดิมผ่านทุกข้อ)
--   - user_id DROP NOT NULL = อนุญาตให้ว่างได้ (ไม่แก้ข้อมูลเดิม) · ข้อบังคับใหม่บังคับให้มี user_id หรือ guest_id อย่างใดอย่างหนึ่ง
--   - รันซ้ำได้ (IF NOT EXISTS) · ทั้งชุดอยู่ใน transaction: ผิดพลาด = ยกเลิกทั้งหมด
--
-- ก่อนรัน: สร้าง Branch สำรองใน Neon (Branches → Create branch จาก main)

BEGIN;

-- ---------- เข้าสู่ระบบด้วยเบอร์โทร + OTP ----------
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phoneNumber" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phoneNumberVerified" boolean;
CREATE UNIQUE INDEX IF NOT EXISTS user_phone_number_key ON "user"("phoneNumber");

CREATE TABLE IF NOT EXISTS phone_otp_requests (
  request_id  text PRIMARY KEY,
  phone_hash  text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip_hash     text
);
CREATE INDEX IF NOT EXISTS phone_otp_phone_idx ON phone_otp_requests(phone_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_otp_created_idx ON phone_otp_requests(created_at);

-- ---------- Guest / โหมดทดสอบ AI (งานที่ไม่ผูกกับสมาชิก) ----------
ALTER TABLE ai_jobs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS guest_id text;
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS guest_ip_hash text;
ALTER TABLE ai_jobs DROP CONSTRAINT IF EXISTS ai_jobs_owner_check;
ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_owner_check CHECK (user_id IS NOT NULL OR guest_id IS NOT NULL);
ALTER TABLE ai_jobs DROP CONSTRAINT IF EXISTS ai_jobs_credit_state_check;
ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_credit_state_check CHECK (credit_state IN ('reserved', 'consumed', 'refunded', 'exempt', 'guest'));
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_guest_idem ON ai_jobs(guest_id, idempotency_key) WHERE guest_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_guest_one_active ON ai_jobs(guest_id) WHERE guest_id IS NOT NULL AND status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS ai_jobs_guest_idx ON ai_jobs(guest_id, created_at DESC) WHERE guest_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_jobs_guest_ip_idx ON ai_jobs(guest_ip_hash, created_at DESC) WHERE guest_ip_hash IS NOT NULL;

ALTER TABLE customer_uploads ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE customer_uploads ADD COLUMN IF NOT EXISTS guest_id text;
ALTER TABLE customer_uploads DROP CONSTRAINT IF EXISTS customer_uploads_owner_check;
ALTER TABLE customer_uploads ADD CONSTRAINT customer_uploads_owner_check CHECK (user_id IS NOT NULL OR guest_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS customer_uploads_guest_idx ON customer_uploads(guest_id) WHERE guest_id IS NOT NULL;

-- ---------- AI จริง: ต้นฉบับไม่มีลายน้ำ (Private) + ค่าใช้จ่ายจริงต่องาน ----------
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS artwork_original_key text;
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS mockup_original_key text;
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS cost_usd numeric(10,4);

COMMIT;
