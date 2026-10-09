// ทดสอบการเลือก Blob store (Private / Public) — ใช้ Blob จำลอง ไม่เรียก Vercel จริง
import test from "node:test";
import assert from "node:assert/strict";
import { resolveBlobConfig, createVercelStorage, blobUrlInStore } from "../api/_lib/storage.mjs";

const PRIV_ID = "store_PrivAAA111";
const PUB_ID = "store_PubBBB222";
const host = (id, access) => `https://${id.replace(/^store_/, "").toLowerCase()}.${access}.blob.vercel-storage.com`;

// Blob จำลอง: บันทึกทุกคำสั่ง และคืน URL ตาม store ที่ถูกเลือกจริง (เหมือนฝั่ง Vercel)
// swap = จำลองกรณีตั้ง Store ID สลับกัน (ไฟล์ไปตกอีก store)
function fakeBlob({ swap = false } = {}) {
  const calls = [];
  const storeOf = (o) => {
    const id = o.storeId || o.token.split("_")[3];
    if (!swap) return id;
    return id.toLowerCase().includes("priv") ? PUB_ID : PRIV_ID;
  };
  return {
    calls,
    async put(pathname, body, o) {
      calls.push({ fn: "put", pathname, o });
      const real = storeOf(o);
      const access = real.toLowerCase().includes("priv") ? "private" : "public";
      return { url: `${host(real, access)}/${pathname}` };
    },
    async get(url, o) {
      calls.push({ fn: "get", url, o });
      return { statusCode: 200, stream: new Blob([new Uint8Array([1, 2, 3])]).stream(), blob: { contentType: "image/png" } };
    },
    async del(url, o) { calls.push({ fn: "del", url, o }); },
  };
}

const storeEnv = { PRIVATE_BLOB_STORE_ID: PRIV_ID, PUBLIC_BLOB_STORE_ID: PUB_ID };

test("resolveBlobConfig: ตั้งไม่ครบ → null (ปิดระบบไฟล์)", () => {
  assert.equal(resolveBlobConfig({}), null);
  assert.equal(resolveBlobConfig({ PRIVATE_BLOB_STORE_ID: PRIV_ID }), null);
  assert.equal(resolveBlobConfig({ PUBLIC_BLOB_STORE_ID: PUB_ID }), null);
  assert.equal(resolveBlobConfig({ PRIVATE_BLOB_STORE_ID: "  ", PUBLIC_BLOB_STORE_ID: PUB_ID }), null);
  // ไม่หยิบตัวแปรค่าเริ่มต้นของ SDK มาใช้แทน
  assert.equal(resolveBlobConfig({ BLOB_STORE_ID: PRIV_ID, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x_y" }), null);
});

test("resolveBlobConfig: Store ID ซ้ำกัน → ปฏิเสธ", () => {
  assert.equal(resolveBlobConfig({ PRIVATE_BLOB_STORE_ID: PRIV_ID, PUBLIC_BLOB_STORE_ID: PRIV_ID }).error, "blob_stores_identical");
  assert.equal(resolveBlobConfig({ PRIVATE_BLOB_STORE_ID: PRIV_ID, PUBLIC_BLOB_STORE_ID: "privaaa111" }).error, "blob_stores_identical");
  assert.equal(resolveBlobConfig({
    PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_Same1_a", PUBLIC_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_same1_b",
  }).error, "blob_stores_identical");
});

test("resolveBlobConfig: Store ID → OIDC (storeId), token มาก่อนถ้ามี", () => {
  const c = resolveBlobConfig(storeEnv);
  assert.deepEqual(c.private.opts, { storeId: PRIV_ID });
  assert.deepEqual(c.public.opts, { storeId: PUB_ID });
  const t = resolveBlobConfig({ ...storeEnv, PRIVATE_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_PrivAAA111_s" });
  assert.deepEqual(t.private.opts, { token: "vercel_blob_rw_PrivAAA111_s" });
  assert.deepEqual(t.public.opts, { storeId: PUB_ID });
});

test("putPrivate ใช้ Store ID ของ Private + access private เท่านั้น", async () => {
  const blob = fakeBlob();
  const s = createVercelStorage({ blob, config: resolveBlobConfig(storeEnv) });
  const key = await s.putPrivate("customers/u1/reference/a.png", new Uint8Array([1]), "image/png");
  assert.ok(key.startsWith(host(PRIV_ID, "private")));
  const c = blob.calls[0];
  assert.equal(c.o.storeId, PRIV_ID);
  assert.equal(c.o.access, "private");
  assert.equal(c.o.token, undefined);
  const got = await s.getPrivate(key);
  assert.deepEqual([...got.bytes], [1, 2, 3]);
  assert.equal(blob.calls[1].o.storeId, PRIV_ID);
  assert.equal(blob.calls[1].o.access, "private");
  await s.delPrivate(key);
  assert.equal(blob.calls[2].o.storeId, PRIV_ID);
});

test("putPublic ใช้ Store ID ของ Public + access public", async () => {
  const blob = fakeBlob();
  const s = createVercelStorage({ blob, config: resolveBlobConfig(storeEnv) });
  const r = await s.putPublic("gallery/img1.webp", new Uint8Array([1]), "image/webp");
  assert.ok(r.url.startsWith(host(PUB_ID, "public")));
  assert.equal(blob.calls[0].o.storeId, PUB_ID);
  assert.equal(blob.calls[0].o.access, "public");
  await s.delPublic(r.key);
  assert.equal(blob.calls[1].o.storeId, PUB_ID);
});

test("ไฟล์ข้าม store ถูกปฏิเสธ (ไม่อ่าน/ลบไฟล์ผิด store)", async () => {
  const blob = fakeBlob();
  const s = createVercelStorage({ blob, config: resolveBlobConfig(storeEnv) });
  const pubUrl = `${host(PUB_ID, "public")}/gallery/x.webp`;
  const privUrl = `${host(PRIV_ID, "private")}/customers/u1/a.png`;
  await assert.rejects(s.getPrivate(pubUrl), /blob_store_mismatch/);
  await assert.rejects(s.getPrivate(`${host(PRIV_ID, "public")}/a.png`), /blob_store_mismatch/);
  await assert.rejects(s.getPrivate("https://evil.example.com/a.png"), /blob_store_mismatch/);
  await assert.rejects(s.getPrivate("customers/u1/a.png"), /blob_store_mismatch/);
  await assert.rejects(s.delPrivate(pubUrl), /blob_store_mismatch/);
  await assert.rejects(s.delPublic(privUrl), /blob_store_mismatch/);
  assert.equal(blob.calls.length, 0);
});

test("ตั้ง Store ID สลับกัน → อัปโหลดล้มเหลวและลบไฟล์ที่ตกผิด store ทันที", async () => {
  const blob = fakeBlob({ swap: true });
  const s = createVercelStorage({ blob, config: resolveBlobConfig(storeEnv) });
  await assert.rejects(s.putPrivate("ai/u1/j1/artwork.png", new Uint8Array([1]), "image/png"), /blob_store_mismatch:private/);
  assert.equal(blob.calls.at(-1).fn, "del");
  await assert.rejects(s.putPublic("gallery/x.webp", new Uint8Array([1]), "image/webp"), /blob_store_mismatch:public/);
  assert.equal(blob.calls.at(-1).fn, "del");
});

test("blobUrlInStore", () => {
  assert.equal(blobUrlInStore(`${host(PRIV_ID, "private")}/a`, PRIV_ID, "private"), true);
  assert.equal(blobUrlInStore(`${host(PRIV_ID, "private")}/a`, PRIV_ID, "public"), false);
  assert.equal(blobUrlInStore(`http://privaaa111.private.blob.vercel-storage.com/a`, PRIV_ID, "private"), false);
  assert.equal(blobUrlInStore(`https://privaaa111.private.blob.vercel-storage.com.evil.com/a`, PRIV_ID, "private"), false);
  assert.equal(blobUrlInStore("not a url", PRIV_ID, "private"), false);
});

test("getContext: Store ID ซ้ำกัน → ไม่เปิดระบบไฟล์", async () => {
  const { getContext } = await import("../api/_lib/context.mjs");
  const orig = console.error;
  const logs = [];
  console.error = (m) => logs.push(String(m));
  try {
    const ctx = await getContext({ PRIVATE_BLOB_STORE_ID: PRIV_ID, PUBLIC_BLOB_STORE_ID: PRIV_ID });
    assert.equal(ctx.storage, null);
    assert.ok(logs.some((l) => l.includes("blob_stores_identical")));
    assert.ok(!logs.some((l) => l.includes("PrivAAA111")));     // ไม่ log ค่าตัวแปร
    const ctx2 = await getContext({ PRIVATE_BLOB_STORE_ID: PRIV_ID });
    assert.equal(ctx2.storage, null);
  } finally { console.error = orig; }
});
