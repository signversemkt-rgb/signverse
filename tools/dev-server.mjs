// Dev server สำหรับทดสอบในเครื่องด้วย Mock Services (ไม่เรียก Neon / Blob / OAuth / AI จริง)
// ใช้งาน:  node tools/dev-server.mjs   แล้วเปิด http://localhost:3000
// (ถ้าไม่มี Node: ELECTRON_RUN_AS_NODE=1 "/Applications/Cursor.app/Contents/MacOS/Cursor" tools/dev-server.mjs)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);
process.env.MOCK_SERVICES = "1";
process.env.APP_ORIGIN = `http://localhost:${PORT}`;
process.env.AI_DAILY_JOB_LIMIT = process.env.AI_DAILY_JOB_LIMIT || "0";

const require = createRequire(import.meta.url);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".avif": "image/avif", ".svg": "image/svg+xml", ".json": "application/json" };
const BLOCKED = /^\/(private|tools|tests|db|docs|node_modules|api)\b|\.(md|xlsx|env)/i;   // เหมือน .vercelignore
const handlers = new Map();

async function loadHandler(name) {
  if (handlers.has(name)) return handlers.get(name);
  const mjs = path.join(ROOT, "api", `${name}.mjs`);
  const cjs = path.join(ROOT, "api", `${name}.js`);
  let h = null;
  if (fs.existsSync(mjs)) h = (await import(pathToFileURL(mjs).href)).default;
  else if (fs.existsSync(cjs)) h = require(cjs);
  handlers.set(name, h);
  return h;
}

// เพิ่ม helper แบบ Vercel (res.status().json(), req.body)
function vercelify(req, res, raw) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); return res; };
  req.rawBody = raw;
  if (raw.length && String(req.headers["content-type"] || "").includes("application/json")) {
    try { req.body = JSON.parse(raw.toString("utf8")); } catch { req.body = raw.toString("utf8"); }
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/\/$/, "");
    // /api/auth/* → api/auth/[...all].mjs (catch-all เหมือน Vercel)
    const h = name.startsWith("auth/") ? await loadHandler("auth/[...all]")
      : /^[a-z-]+(\/[a-z-]+)?$/.test(name) && !name.startsWith("_") ? await loadHandler(name) : null;
    if (!h) { res.statusCode = name.startsWith("auth") ? 503 : 404; return res.end(JSON.stringify({ error: "not available in mock dev server" })); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    vercelify(req, res, Buffer.concat(chunks));
    try { await h(req, res); } catch (e) { console.error(e); res.statusCode = 500; res.end("{}"); }
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (BLOCKED.test(p)) { res.statusCode = 404; return res.end("Not found"); }
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`SIGN VERSE dev (MOCK) → http://localhost:${PORT}  |  หลังบ้าน → http://localhost:${PORT}/admin/`);
});
