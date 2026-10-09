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

// Vercel Blob — ใช้ token แยกของแต่ละ store (ตั้ง prefix ตอนเชื่อม store: PRIVATE_BLOB / PUBLIC_BLOB)
export function createVercelStorage({ blob, privateToken, publicToken }) {
  const { put, get, del } = blob;
  return {
    async putPrivate(pathname, bytes, mime) {
      const r = await put(pathname, Buffer.from(bytes), { access: "private", token: privateToken, contentType: mime, addRandomSuffix: true });
      return r.url;
    },
    async getPrivate(key) {
      const r = await get(key, { access: "private", token: privateToken });
      if (!r || r.statusCode !== 200) throw new Error("private blob not found");
      const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
      return { bytes, mime: r.blob.contentType };
    },
    async delPrivate(key) { await del(key, { token: privateToken }); },
    async putPublic(pathname, bytes, mime) {
      const r = await put(pathname, Buffer.from(bytes), {
        access: "public", token: publicToken, contentType: mime, addRandomSuffix: true, cacheControlMaxAge: 60 * 60 * 24 * 30,
      });
      return { url: r.url, key: r.url };
    },
    async delPublic(key) { await del(key, { token: publicToken }); },
  };
}
