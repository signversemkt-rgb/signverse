// ที่เก็บไฟล์ 2 ชุดแยกกันชัดเจน
//   Private store → ภาพลูกค้า, ภาพอ้างอิงที่ลูกค้าอัปโหลด, ภาพ AI, ต้นฉบับรูปผลงาน (อ่านผ่าน /api/files ที่ตรวจสิทธิ์เท่านั้น)
//   Public store  → เฉพาะรูปผลงานที่พนักงานกดเผยแพร่แล้ว
// ห้ามเรียก putPublic กับไฟล์ของลูกค้า

export function createMemoryStorage({ uuid }) {
  const priv = new Map();
  const pub = new Map();
  return {
    _priv: priv,
    _pub: pub,
    async putPrivate(pathname, bytes, mime) {
      const key = `memory-private://${pathname}?${uuid().slice(0, 8)}`;
      priv.set(key, { bytes, mime });
      return key;
    },
    async getPrivate(key) {
      const f = priv.get(key);
      if (!f) throw new Error("private blob not found");
      return f;
    },
    async delPrivate(key) { priv.delete(key); },
    async putPublic(pathname, bytes, mime) {
      const key = `/mock-public/${uuid().slice(0, 8)}-${pathname.split("/").pop()}`;
      pub.set(key, { bytes, mime });
      return { url: key, key };
    },
    async delPublic(key) { pub.delete(key); },
  };
}

// ---------- Vercel Blob ----------
// เลือก store ด้วยวิธีใดวิธีหนึ่งต่อ store (ตรวจกับ @vercel/blob 2.8.1):
//   1) token แยกของ store: PRIVATE_BLOB_READ_WRITE_TOKEN / PUBLIC_BLOB_READ_WRITE_TOKEN  (ถ้ามีจะใช้ก่อน)
//   2) Store ID + Vercel OIDC: PRIVATE_BLOB_STORE_ID / PUBLIC_BLOB_STORE_ID
//      — OIDC token มากับทุก request บน Vercel เอง (header x-vercel-oidc-token) ไม่ต้องตั้งเป็นตัวแปร
//      — OIDC token ใช้ได้กับทุก store ที่เชื่อมกับโปรเจกต์ → ต้องส่ง storeId ทุกคำสั่ง และตรวจ URL ของไฟล์ว่าอยู่ store ที่ถูกต้อง
// ไม่พึ่งค่าเริ่มต้นของ SDK (BLOB_READ_WRITE_TOKEN / BLOB_STORE_ID) เพื่อไม่ให้หยิบ store ผิดโดยไม่ตั้งใจ
const normId = (id) => String(id || "").trim().replace(/^store_/, "").toLowerCase();
const idFromToken = (token) => normId(String(token).split("_")[3]);   // vercel_blob_rw_{storeId}_{secret}

function storeAuth(token, storeId) {
  if (token) return { opts: { token }, id: idFromToken(token) };
  if (storeId && String(storeId).trim()) return { opts: { storeId: String(storeId).trim() }, id: normId(storeId) };
  return null;
}

// คืน { private, public } หรือ null (= ตั้งค่าไม่ครบ/ไม่ปลอดภัย → ปิดระบบไฟล์ ตอบ not_configured)
export function resolveBlobConfig(env) {
  const priv = storeAuth(env.PRIVATE_BLOB_READ_WRITE_TOKEN, env.PRIVATE_BLOB_STORE_ID);
  const pub = storeAuth(env.PUBLIC_BLOB_READ_WRITE_TOKEN, env.PUBLIC_BLOB_STORE_ID);
  if (!priv || !pub) return null;
  if (!priv.id || !pub.id) return { error: "blob_store_id_unreadable" };
  if (priv.id === pub.id) return { error: "blob_stores_identical" };     // ชี้ store เดียวกัน = แยก Public/Private ไม่ได้
  return { private: priv, public: pub };
}

// URL ของไฟล์ต้องอยู่ใน store และโหมดที่คาดไว้เท่านั้น เช่น https://{storeId}.private.blob.vercel-storage.com/...
export function blobUrlInStore(url, storeId, access) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === `${normId(storeId)}.${access}.blob.vercel-storage.com`;
  } catch { return false; }
}

export function createVercelStorage({ blob, config }) {
  const { put, get, del } = blob;
  const P = config.private, U = config.public;
  const mustBe = (url, store, access) => {
    if (!blobUrlInStore(url, store.id, access)) throw new Error(`blob_store_mismatch:${access}`);
  };
  return {
    async putPrivate(pathname, bytes, mime) {
      const r = await put(pathname, Buffer.from(bytes), { ...P.opts, access: "private", contentType: mime, addRandomSuffix: true });
      if (!blobUrlInStore(r.url, P.id, "private")) {
        await del(r.url, { ...P.opts }).catch(() => {});
        throw new Error("blob_store_mismatch:private");
      }
      return r.url;
    },
    async getPrivate(key) {
      mustBe(key, P, "private");
      const r = await get(key, { ...P.opts, access: "private" });
      if (!r || r.statusCode !== 200) throw new Error("private blob not found");
      const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
      return { bytes, mime: r.blob.contentType };
    },
    async delPrivate(key) {
      mustBe(key, P, "private");
      await del(key, { ...P.opts });
    },
    async putPublic(pathname, bytes, mime) {
      const r = await put(pathname, Buffer.from(bytes), {
        ...U.opts, access: "public", contentType: mime, addRandomSuffix: true, cacheControlMaxAge: 60 * 60 * 24 * 30,
      });
      if (!blobUrlInStore(r.url, U.id, "public")) {
        await del(r.url, { ...U.opts }).catch(() => {});
        throw new Error("blob_store_mismatch:public");
      }
      return { url: r.url, key: r.url };
    },
    async delPublic(key) {
      mustBe(key, U, "public");
      await del(key, { ...U.opts });
    },
  };
}
