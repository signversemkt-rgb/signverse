// ทดสอบ API จริงทุกตัวในโหมด Mock (ไม่เรียก Neon / Blob / AI / OAuth จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AI_DAILY_JOB_LIMIT = "0";
delete process.env.VERCEL_ENV;

const ORIGIN = "http://localhost:3000";
const me = (await import("../api/me.mjs")).default;
const ai = (await import("../api/ai.mjs")).default;
const upload = (await import("../api/upload.mjs")).default;
const files = (await import("../api/files.mjs")).default;
const admin = (await import("../api/admin.mjs")).default;
const gallery = (await import("../api/gallery.mjs")).default;
const cron = (await import("../api/cron-cleanup.mjs")).default;
const { getContext } = await import("../api/_lib/context.mjs");
const ctx = await getContext();

// ---------- helpers ----------
async function call(handler, { method = "GET", url = "/", body, cookie, origin = ORIGIN, headers = {} } = {}) {
  const req = { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), "x-forwarded-for": headers["x-forwarded-for"] || "1.2.3.4" }, body };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(data) { this.body = data; },
    // helper ของ Vercel (ใช้โดย API เดิม เช่น estimate-price.js)
    status(c) { this.statusCode = c; return this; },
    json(o) { this.setHeader("Content-Type", "application/json"); this.end(JSON.stringify(o)); return this; },
  };
  await handler(req, res);
  const text = res.body == null ? "" : Buffer.isBuffer(res.body) ? res.body.toString("utf8") : String(res.body);
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary/svg */ }
  return { status: res.statusCode, headers: res.headers, json, text };
}

async function login(role = "customer") {
  const r = await call(me, { method: "POST", url: "/api/me?mock=login", body: { role } });
  return r.headers["set-cookie"].split(";")[0];
}

// PNG ขนาด 800x600 (header ถูกต้อง พอสำหรับการตรวจชนิด/ขนาดไฟล์)
function png(w = 800, h = 600) {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b.toString("base64");
}
const INPUT = { shopName: "บ้านสวน", signText: "CAFE", widthCm: 120, heightCm: 60, lighting: "warm", material: "พลาสวูด" };
const idem = () => ctx.uuid();

async function makePublishedImage(staff) {
  const album = (await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "createAlbum", title: "ป้ายมินิมอล" } })).json.album;
  const img = (await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "uploadImage", albumId: album.id, data: png(), thumb: png(320, 240), title: "ร้านกาแฟ" } })).json.image;
  return { album, img };
}

// ---------- ผู้ใช้ทั่วไป ----------
test("ผู้ใช้ทั่วไป: ดูสถานะได้ แต่เรียก API สร้างภาพโดยตรงไม่ได้", async () => {
  const r = await call(me);
  assert.equal(r.status, 200);
  assert.equal(r.json.user, null);
  assert.deepEqual(r.json.providers, ["line", "phone"]);          // Google ปิด · เข้าสู่ระบบด้วย LINE หรือเบอร์โทร
  const c = await call(ai, { method: "POST", url: "/api/ai", body: { action: "create", idempotencyKey: idem(), input: INPUT } });
  assert.equal(c.status, 401);
  const u = await call(upload, { method: "POST", url: "/api/upload", body: { kind: "storefront", data: png() } });
  assert.equal(u.status, 401);
});

test("ผู้ใช้ทั่วไปประเมินราคาได้โดยไม่ต้องล็อกอิน (API เดิมไม่เสียหาย)", async () => {
  const require = createRequire(import.meta.url);
  const estimate = require("../api/estimate-price.js");
  const r = await call(estimate, { method: "POST", url: "/api/estimate-price", body: { widthCm: 120, heightCm: 60, material: "พลาสวูด", layers: 1, jobType: "standard", lighting: "none" } });
  assert.equal(r.status, 200);
  assert.ok(["estimated", "needs_review"].includes(r.json.status));
});

// ---------- CSRF / สิทธิ์ ----------
test("คำขอที่แก้ไขข้อมูลต้องมาจาก origin ของเว็บ", async () => {
  const cookie = await login();
  const r = await call(ai, { method: "POST", url: "/api/ai", cookie, origin: "https://evil.example", body: { action: "create", idempotencyKey: idem(), input: INPUT } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "bad_origin");
});

test("ลูกค้าเข้า Admin API ไม่ได้ / staff เพิ่มสิทธิ์ไม่ได้ / ส่ง role เองไม่ได้", async () => {
  const customer = await login("customer");
  assert.equal((await call(admin, { url: "/api/admin?action=dashboard", cookie: customer })).status, 403);
  assert.equal((await call(admin, { url: "/api/admin?action=dashboard" })).status, 401);
  const staff = await login("staff");
  assert.equal((await call(admin, { url: "/api/admin?action=dashboard", cookie: staff })).status, 200);
  const target = (await call(me, { cookie: customer })).json.user.id;
  const g = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "grantCredits", userId: target, amount: 1, isAdmin: true } });
  assert.equal(g.status, 403);
  const sr = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "setRole", userId: target, role: "admin" } });
  assert.equal(sr.status, 403);
});

// ---------- อัปโหลดลูกค้า → Private เท่านั้น ----------
test("อัปโหลดภาพลูกค้าเก็บ Private + ตรวจชนิดไฟล์จริง + เจ้าของเท่านั้นที่เปิดได้", async () => {
  const a = await login();
  const b = await login();
  const pubBefore = ctx.storage._pub.size;
  const r = await call(upload, { method: "POST", url: "/api/upload", cookie: a, body: { kind: "storefront", data: png() } });
  assert.equal(r.status, 201);
  assert.equal(ctx.storage._pub.size, pubBefore, "ห้ามเก็บภาพลูกค้าใน Public");
  const fake = Buffer.from("<script>alert(1)</script>".padEnd(64, " ")).toString("base64");
  const bad = await call(upload, { method: "POST", url: "/api/upload", cookie: a, body: { kind: "reference", data: fake } });
  assert.equal(bad.json.code, "invalid_file");
  assert.equal((await call(files, { url: r.json.url, cookie: a })).status, 200);
  assert.equal((await call(files, { url: r.json.url, cookie: b })).status, 404);
  assert.equal((await call(files, { url: r.json.url })).status, 401);
});

// ---------- งาน AI ครบวงจร ----------
test("สมาชิกสร้างภาพครบ 1 ชุด → ใช้สิทธิ์ครบ → สร้างเพิ่มไม่ได้ → admin เพิ่มสิทธิ์แล้วสร้างได้", async () => {
  const staff = await login("staff");
  const adminCookie = await login("admin");
  const { img } = await makePublishedImage(staff);
  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "publishImage", id: img.id, published: true } });
  const albums = (await call(admin, { url: "/api/admin?action=albums", cookie: staff })).json.albums;
  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateAlbum", id: albums.at(-1).id, published: true } });

  const cookie = await login();
  const key = idem();
  const created = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: key, input: INPUT, references: [img.id] } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.quota.remaining, 0);
  const again = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: key, input: INPUT, references: [img.id] } });
  assert.equal(again.json.created, false, "ส่ง key เดิมซ้ำต้องไม่สร้างงานใหม่");

  const jobId = created.json.job.jobId;
  const s1 = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "step", jobId, step: "artwork" } });
  assert.equal(s1.json.job.status, "partial");
  const s2 = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "step", jobId, step: "mockup" } });
  assert.equal(s2.json.job.status, "completed");
  assert.deepEqual(s2.json.quota, { total: 1, used: 1, reserved: 0, remaining: 0 });

  // ไฟล์ภาพ: เจ้าของเปิดได้ (PNG ตัวอย่างที่มีลายน้ำในไฟล์ + CSP sandbox), คนอื่นเปิดไม่ได้
  const art = await call(files, { url: s2.json.job.artwork.url, cookie });
  assert.equal(art.status, 200);
  assert.equal(art.headers["content-type"], "image/png");
  assert.match(art.headers["content-security-policy"], /sandbox/);
  assert.equal(art.headers["cache-control"], "private, no-store");
  assert.equal((await call(files, { url: s2.json.job.artwork.url, cookie: await login() })).status, 404);
  // ข้อมูลงานที่ส่งให้ Browser ไม่มี storage key
  assert.ok(!JSON.stringify(s2.json).includes("memory-private"));

  const blocked = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: idem(), input: INPUT } });
  assert.equal(blocked.json.code, "quota_exhausted");

  const userId = (await call(me, { cookie })).json.user.id;
  const grant = await call(admin, { method: "POST", url: "/api/admin", cookie: adminCookie, body: { action: "grantCredits", userId, amount: 1, note: "ทดสอบ" } });
  assert.equal(grant.json.quota.remaining, 1);
  const audit = (await call(admin, { url: "/api/admin?action=audit&type=credits", cookie: adminCookie })).json.events;
  assert.ok(audit.some((e) => e.action === "ai_credits_granted" && e.target === userId));
  const ok = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: idem(), input: INPUT } });
  assert.equal(ok.status, 201);
});

test("AI รับเฉพาะภาพอ้างอิงที่เผยแพร่ + ภาพอัปโหลดของตัวเอง (สูงสุด 3)", async () => {
  const staff = await login("staff");
  const { img } = await makePublishedImage(staff);   // ยังไม่เผยแพร่
  const cookie = await login();
  const hidden = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: idem(), input: INPUT, references: [img.id] } });
  assert.equal(hidden.json.code, "invalid_reference");

  const other = await login();
  const otherUpload = (await call(upload, { method: "POST", url: "/api/upload", cookie: other, body: { kind: "reference", data: png() } })).json.uploadId;
  const stolen = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: idem(), input: INPUT, uploads: [otherUpload] } });
  assert.equal(stolen.json.code, "invalid_reference");

  const mine = [];
  for (let i = 0; i < 3; i++) mine.push((await call(upload, { method: "POST", url: "/api/upload", cookie, body: { kind: "reference", data: png() } })).json.uploadId);
  const tooMany = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: idem(), input: INPUT, uploads: mine, references: [img.id] } });
  assert.ok(["too_many_files", "invalid_reference"].includes(tooMany.json.code));
  const fine = await call(ai, { method: "POST", url: "/api/ai", cookie, body: { action: "create", idempotencyKey: idem(), input: INPUT, uploads: mine } });
  assert.equal(fine.status, 201, fine.text);
});

// ---------- Gallery ----------
test("Gallery: แสดงเฉพาะรูปที่เผยแพร่, ซ่อน/ลบแล้วหาย, กู้คืนจากถังขยะได้, ต้นฉบับอยู่ Private", async () => {
  const staff = await login("staff");
  const { album, img } = await makePublishedImage(staff);
  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateAlbum", id: album.id, published: true } });
  const listed = async () => (await call(gallery, { url: `/api/gallery?album=${album.id}` })).json.images.map((i) => i.id);
  assert.deepEqual(await listed(), [], "ยังไม่เผยแพร่ต้องไม่แสดง");

  const pubBefore = ctx.storage._pub.size;
  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "publishImage", id: img.id, published: true } });
  assert.equal(ctx.storage._pub.size, pubBefore + 2, "เผยแพร่แล้วคัดลอกรูป+thumbnail ไป Public");
  assert.deepEqual(await listed(), [img.id]);
  const albums = (await call(gallery, { url: "/api/gallery" })).json.albums;
  assert.ok(albums.some((a) => a.id === album.id && a.coverUrl));

  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "publishImage", id: img.id, published: false } });
  assert.equal(ctx.storage._pub.size, pubBefore, "ซ่อนแล้วลบสำเนา Public");
  assert.deepEqual(await listed(), []);

  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "deleteImage", id: img.id } });
  const trash = (await call(admin, { url: "/api/admin?action=images&trash=1", cookie: staff })).json.images;
  assert.ok(trash.some((i) => i.id === img.id));
  await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "restoreImage", id: img.id } });
  const back = (await call(admin, { url: `/api/admin?action=images&album=${album.id}`, cookie: staff })).json.images;
  assert.ok(back.some((i) => i.id === img.id));
  assert.equal((await call(files, { url: `/api/files?gallery=${img.id}`, cookie: await login() })).status, 403, "ลูกค้าเปิดต้นฉบับไม่ได้");
  assert.equal((await call(files, { url: `/api/files?gallery=${img.id}`, cookie: staff })).status, 200);
});

test("ย้ายรูปไปอัลบั้มอื่น + ตั้งภาพปก + ค้นหา", async () => {
  const staff = await login("staff");
  const { album, img } = await makePublishedImage(staff);
  const other = (await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "createAlbum", title: "ป้ายไดคัท" } })).json.album;
  const moved = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateImage", id: img.id, albumId: other.id } });
  assert.equal(moved.json.image.albumId, other.id);
  const cover = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateAlbum", id: other.id, coverImageId: img.id } });
  assert.equal(cover.json.album.coverImageId, img.id);
  const wrongCover = await call(admin, { method: "POST", url: "/api/admin", cookie: staff, body: { action: "updateAlbum", id: album.id, coverImageId: img.id } });
  assert.equal(wrongCover.status, 400);
  const found = (await call(admin, { url: "/api/admin?action=images&search=" + encodeURIComponent("กาแฟ"), cookie: staff })).json.images;
  assert.ok(found.some((i) => i.id === img.id));
});

test("Cron cleanup ต้องมี CRON_SECRET", async () => {
  assert.equal((await call(cron, { url: "/api/cron-cleanup" })).status, 401);
});
