-- SIGN VERSE — Neon Postgres schema
-- รันครั้งเดียวใน Neon Console → SQL Editor (ดู docs/SETUP.md)
-- ตาราง "user" / "session" / "account" / "verification" / "rateLimit" เป็นโครงสร้างของ Better Auth (ชื่อคอลัมน์ camelCase)

-- ========== Better Auth ==========
CREATE TABLE IF NOT EXISTS "user" (
  "id"            text PRIMARY KEY,
  "name"          text NOT NULL DEFAULT '',
  "email"         text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  "image"         text,
  "role"          text NOT NULL DEFAULT 'customer' CHECK ("role" IN ('customer', 'staff', 'admin')),
  "accountStatus" text NOT NULL DEFAULT 'active' CHECK ("accountStatus" IN ('active', 'suspended')),
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  "id"        text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_idx ON "session"("userId");

-- Social identities (provider + provider_user_id) — 1 ผู้ใช้เชื่อมได้หลาย provider
CREATE TABLE IF NOT EXISTS "account" (
  "id"                    text PRIMARY KEY,
  "accountId"             text NOT NULL,             -- provider_user_id
  "providerId"            text NOT NULL,             -- google | line | facebook
  "userId"                text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL DEFAULT now(),   -- linked_at
  "updatedAt"             timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX IF NOT EXISTS account_user_idx ON "account"("userId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id"         text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);

-- Better Auth rate limit (storage: "database")
CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id"          text PRIMARY KEY,
  "key"         text NOT NULL UNIQUE,
  "count"       integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

-- ========== AI Quota ==========
CREATE TABLE IF NOT EXISTS ai_quota (
  user_id            text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  free_credits_total integer NOT NULL DEFAULT 1 CHECK (free_credits_total >= 0),
  free_credits_used  integer NOT NULL DEFAULT 0 CHECK (free_credits_used >= 0),
  reserved_credits   integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (free_credits_used + reserved_credits <= free_credits_total)
);

-- ========== AI Generation Jobs ==========
CREATE TABLE IF NOT EXISTS ai_jobs (
  job_id              text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  idempotency_key     text NOT NULL,
  status              text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'partial', 'failed')),
  artwork_status      text NOT NULL DEFAULT 'pending' CHECK (artwork_status IN ('pending', 'processing', 'done', 'failed', 'unknown')),
  mockup_status       text NOT NULL DEFAULT 'pending' CHECK (mockup_status IN ('pending', 'processing', 'done', 'failed', 'unknown')),
  artwork_storage_key text,
  mockup_storage_key  text,
  credit_state        text NOT NULL DEFAULT 'reserved' CHECK (credit_state IN ('reserved', 'consumed', 'refunded')),
  attempts            integer NOT NULL DEFAULT 0,
  input               jsonb NOT NULL,          -- ข้อมูลฟอร์ม + reference/upload ids ที่ตรวจแล้ว
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ai_jobs_user_idx ON ai_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_jobs_created_idx ON ai_jobs(created_at);
-- 1 งานที่กำลังประมวลผลต่อผู้ใช้
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_one_active ON ai_jobs(user_id) WHERE status IN ('pending', 'processing');

-- ========== ไฟล์ที่ลูกค้าอัปโหลด (Private Blob) ==========
CREATE TABLE IF NOT EXISTS customer_uploads (
  upload_id   text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('reference', 'storefront')),
  storage_key text NOT NULL UNIQUE,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_uploads_user_idx ON customer_uploads(user_id);
CREATE INDEX IF NOT EXISTS customer_uploads_expires_idx ON customer_uploads(expires_at);

-- ========== Gallery ผลงานร้าน ==========
CREATE TABLE IF NOT EXISTS gallery_albums (
  album_id       text PRIMARY KEY,
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  cover_image_id text,
  sort_order     integer NOT NULL DEFAULT 0,
  is_published   boolean NOT NULL DEFAULT false,
  created_by     text REFERENCES "user"("id") ON DELETE SET NULL,
  updated_by     text REFERENCES "user"("id") ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE TABLE IF NOT EXISTS gallery_images (
  image_id           text PRIMARY KEY,
  album_id           text NOT NULL REFERENCES gallery_albums(album_id),
  private_key        text NOT NULL,     -- ต้นฉบับใน Private Blob (staff เท่านั้น)
  private_thumb_key  text NOT NULL,
  public_url         text,              -- มีค่าเฉพาะเมื่อเผยแพร่ (Public Blob)
  public_thumb_url   text,
  public_key         text,
  public_thumb_key   text,
  title              text NOT NULL DEFAULT '',
  alt                text NOT NULL DEFAULT '',
  width              integer,
  height             integer,
  sort_order         integer NOT NULL DEFAULT 0,
  is_published       boolean NOT NULL DEFAULT false,
  created_by         text REFERENCES "user"("id") ON DELETE SET NULL,
  updated_by         text REFERENCES "user"("id") ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz         -- Soft delete (ถังขยะ)
);
CREATE INDEX IF NOT EXISTS gallery_images_album_idx ON gallery_images(album_id, sort_order);

-- ========== Audit Logs ==========
CREATE TABLE IF NOT EXISTS audit_logs (
  event_id   text PRIMARY KEY,
  actor_id   text,
  action     text NOT NULL,
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

-- ========== Rate limit ของ API ของเรา (แชร์ระหว่าง instances) ==========
CREATE TABLE IF NOT EXISTS app_rate_limits (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL
);

-- ========== LINE Messaging API ==========
-- ค่าตั้งระบบ (เช่น groupId กลุ่มพนักงาน, hash ของรหัสผูกกลุ่มที่ยังไม่หมดอายุ)
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- กลุ่มที่บอทถูกเชิญเข้า (ยังไม่ถือเป็นกลุ่มพนักงานจนกว่าจะผูกด้วยรหัสจากหลังบ้าน)
CREATE TABLE IF NOT EXISTS line_groups (
  group_id   text PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('joined', 'staff', 'left')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ประวัติการส่งคำสั่งผลิตเข้ากลุ่ม (retry_key กันส่งซ้ำ)
CREATE TABLE IF NOT EXISTS line_orders (
  order_id   text PRIMARY KEY,
  job_id     text NOT NULL REFERENCES ai_jobs(job_id) ON DELETE CASCADE,
  group_id   text NOT NULL,
  retry_key  text NOT NULL UNIQUE,
  sent_by    text REFERENCES "user"("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_orders_job_idx ON line_orders(job_id);

-- ========== คำขอสั่งผลิตจากลูกค้า (ปุ่ม "สั่งผลิตป้ายนี้") ==========
CREATE TABLE IF NOT EXISTS production_orders (
  order_id        text PRIMARY KEY,
  order_no        text NOT NULL UNIQUE,                 -- เลขออร์เดอร์ที่ลูกค้าเห็น เช่น SV261009-7KQ4
  user_id         text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  job_id          text REFERENCES ai_jobs(job_id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  form            jsonb NOT NULL,                       -- ฟอร์มที่ตรวจแล้วฝั่ง Server
  price_estimate  integer,                              -- คำนวณใหม่ฝั่ง Server (null = รอทีมงานประเมิน)
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'confirmed', 'in_production', 'completed', 'cancelled')),
  staff_note      text NOT NULL DEFAULT '',
  -- การส่งผ่าน LINE OA (แยกจากสถานะการผลิต)
  claim_code      text NOT NULL,                        -- รหัสยืนยันที่ลูกค้าส่งในแชต LINE (แสดงเฉพาะเจ้าของออร์เดอร์)
  line_user_id    text,                                 -- LINE userId ที่ยืนยันแล้ว (จาก Webhook ที่ตรวจลายเซ็น / LIFF ID token)
  line_delivery_status text NOT NULL DEFAULT 'awaiting_customer'
                  CHECK (line_delivery_status IN ('awaiting_customer', 'sending', 'sent', 'failed')),
  line_delivery_channel text CHECK (line_delivery_channel IN ('oa_reply', 'liff')),
  line_delivery_attempts integer NOT NULL DEFAULT 0,
  line_delivery_error text,
  line_request_id text,                                 -- x-line-request-id จาก LINE (หลักฐานว่า LINE รับคำขอแล้ว)
  line_delivered_at timestamptz,
  line_delivery_updated_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text REFERENCES "user"("id") ON DELETE SET NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS production_orders_created_idx ON production_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS production_orders_status_idx ON production_orders(status, created_at DESC);
