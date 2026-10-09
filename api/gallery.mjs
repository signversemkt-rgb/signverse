// GET /api/gallery            → อัลบั้มที่เผยแพร่ (พร้อมภาพปก)
// GET /api/gallery?album=ID   → รูปที่เผยแพร่ในอัลบั้ม (แบ่งหน้า)
// แสดงเฉพาะรูป Published ในอัลบั้ม Published ที่ไม่ถูกลบ
import { route } from "./_lib/route.mjs";
import { sendJson, query, HttpError, isId } from "./_lib/http.mjs";
import { need } from "./_lib/context.mjs";

const PAGE = 24;
const publicImage = (i) => ({ id: i.image_id, albumId: i.album_id, title: i.title, alt: i.alt || i.title, url: i.public_url, thumbUrl: i.public_thumb_url, width: i.width, height: i.height });

export default route(async (req, res, ctx) => {
  if (req.method !== "GET") throw new HttpError(405, "bad_request");
  need(ctx, "repo");
  const q = query(req);
  // แคชสั้น ๆ ที่ CDN: รูปที่เพิ่งเผยแพร่ปรากฏภายใน ~1 นาทีโดยไม่ต้อง Deploy ใหม่
  const cache = "public, s-maxage=60, stale-while-revalidate=300";

  if (q.album) {
    if (!isId(q.album)) throw new HttpError(400, "bad_request");
    const page = Math.max(0, Number.parseInt(q.page || "0", 10) || 0);
    const { rows, total } = await ctx.repo.listImages({ albumId: q.album, publishedOnly: true, limit: PAGE, offset: page * PAGE });
    res.setHeader("Cache-Control", cache);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ images: rows.map(publicImage), total, page, hasMore: (page + 1) * PAGE < total }));
  }

  const albums = await ctx.repo.listAlbums({ publishedOnly: true });
  const out = [];
  for (const a of albums) {
    if (!a.image_count) continue;
    let cover = a.cover_image_id ? (await ctx.repo.getPublishedImages([a.cover_image_id]))[0] : null;
    if (!cover) cover = (await ctx.repo.listImages({ albumId: a.album_id, publishedOnly: true, limit: 1 })).rows[0];
    out.push({ id: a.album_id, title: a.title, description: a.description, imageCount: a.image_count, coverUrl: cover ? cover.public_thumb_url : null });
  }
  res.setHeader("Cache-Control", cache);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ albums: out }));
});
