import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import handler from "./routes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");

for (const envFile of [".env.local", ".env"]) {
  const fullPath = path.join(rootDir, envFile);
  if (fs.existsSync(fullPath)) {
    const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

process.env.NEON_DATA_API_URL = process.env.NEON_DATA_API_URL || process.env.VITE_NEON_DATA_API_URL || "";

for (const oid of [1082, 1083, 1114, 1184]) {
  pg.types.setTypeParser(oid, (val) => val);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const db = {
  async query(text, params = []) {
    const res = await pool.query(text, params);
    return res.rows;
  },
  async transaction(statements) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const stmt of statements) {
        const res = await client.query(stmt.text, stmt.params ?? []);
        results.push(res.rows);
      }
      await client.query("COMMIT");
      return results;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "localhost:3000";
  const url = new URL(req.url || "/", `${proto}://${host}`);

  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const json = () => (rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {});

    const result = await handler({
      method: req.method || "GET",
      path: url.pathname,
      url,
      headers: req.headers,
      rawBody,
      json,
      env: process.env,
      db,
    });

    const outHeaders = { ...(result.headers || {}) };
    const isRaw = typeof result.body === "string" || Buffer.isBuffer(result.body);
    if (!outHeaders["content-type"] && !outHeaders["Content-Type"]) {
      outHeaders["content-type"] = "application/json; charset=utf-8";
    }
    res.writeHead(result.status || 200, outHeaders);
    res.end(isRaw ? result.body : JSON.stringify(result.body ?? {}));
    return;
  }

  let filePath = path.join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(distDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Build dist/ not found. Run pnpm build first.");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Nes Multimedia server running on port ${port}`);
});
