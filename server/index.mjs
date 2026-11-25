import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import handler, { buildQuotePdf, hashPassword, verifyPassword } from "./routes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");

for (const envFile of [".env.local", ".env"]) {
  const fullPath = path.join(rootDir, envFile);
  if (!fs.existsSync(fullPath)) continue;
  for (const line of fs.readFileSync(fullPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = val;
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
    return (await pool.query(text, params)).rows;
  },
  async transaction(statements) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const stmt of statements) {
        results.push((await client.query(stmt.text, stmt.params ?? [])).rows);
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

async function runNeonAuthWork(workFn) {
  try {
    return await workFn((text, params = []) => db.query(text, params));
  } catch (err) {
    if (err?.code !== "42501") throw err;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE neon_auth");
      const out = await workFn(async (text, params = []) => (await client.query(text, params)).rows);
      await client.query("RESET ROLE");
      await client.query("COMMIT");
      return out;
    } catch (innerErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw innerErr;
    } finally {
      client.release();
    }
  }
}

const BIDI_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let quoteCcReady = false;

const cleanEmail = (raw) => String(raw ?? "").replace(BIDI_RE, "").replace(/\s+/g, "").toLowerCase();
const cleanPass = (raw) => String(raw ?? "").replace(BIDI_RE, "");
const escapeHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseEmailList(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return arr.flatMap((x) => String(x ?? "").split(/[,;\s]+/)).map(cleanEmail).filter(Boolean);
}

function dedupeEmails(list, exclude = "") {
  const ex = cleanEmail(exclude);
  const seen = new Set();
  return list.map(cleanEmail).filter((e) => e && e !== ex && !seen.has(e) && seen.add(e));
}

function makeTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "Ns";
  for (let i = 0; i < 8; i += 1) out += chars[randomBytes(1)[0] % chars.length];
  return out + "9";
}

function wrapEmailHtml(heading, bodyHtml) {
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px 12px;background:#f4f4f7;font-family:Arial,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:#312e81;padding:18px 24px;color:#fff;font-size:18px;font-weight:bold">נס מולטימדיה</div>
    <div style="padding:24px"><h1 style="margin:0 0 12px;font-size:18px;color:#111827">${heading}</h1>${bodyHtml}</div>
  </div>
</body></html>`;
}

async function ensureQuoteCcColumn() {
  if (quoteCcReady) return;
  await db.query(`ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS quote_cc_emails text[] NOT NULL DEFAULT '{}'::text[]`);
  quoteCcReady = true;
}

async function upsertNeonCredentialPassword(email, plainName, newHash) {
  const prof = await db.query(`SELECT id::text AS id, full_name FROM public.profiles WHERE lower(btrim(email)) = $1 LIMIT 1`, [email]);
  return await runNeonAuthWork(async (q) => {
    const uCols = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'neon_auth' AND table_name = 'user'`)).map((r) => r.column_name));
    const evCol = uCols.has("emailVerified") ? '"emailVerified"' : uCols.has("email_verified") ? "email_verified" : null;
    const uCaCol = uCols.has("createdAt") ? '"createdAt"' : uCols.has("created_at") ? "created_at" : null;
    const uUaCol = uCols.has("updatedAt") ? '"updatedAt"' : uCols.has("updated_at") ? "updated_at" : null;

    const aCols = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'neon_auth' AND table_name = 'account'`)).map((r) => r.column_name));
    const uidCol = aCols.has("userId") ? '"userId"' : "user_id";
    const pidCol = aCols.has("providerId") ? '"providerId"' : "provider_id";
    const aidCol = aCols.has("accountId") ? '"accountId"' : "account_id";
    const aCaCol = aCols.has("createdAt") ? '"createdAt"' : aCols.has("created_at") ? "created_at" : null;
    const aUaCol = aCols.has("updatedAt") ? '"updatedAt"' : aCols.has("updated_at") ? "updated_at" : null;

    const users = await q(`SELECT id::text AS id, name FROM neon_auth."user" WHERE lower(btrim(email)) = $1 LIMIT 1`, [email]);
    let authUserId = users[0]?.id || null;

    if (!authUserId) {
      if (!prof[0]) return { ok: false };
      authUserId = prof[0].id;
      const cols = ["id", "name", "email"];
      const vals = ["$1", "$2", "$3"];
      if (evCol) { cols.push(evCol); vals.push("true"); }
      if (uCaCol) { cols.push(uCaCol); vals.push("now()"); }
      if (uUaCol) { cols.push(uUaCol); vals.push("now()"); }
      if (uCols.has("role")) { cols.push("role"); vals.push(email === "a0525092333@gmail.com" ? "'admin'" : "'user'"); }
      if (uCols.has("banned")) { cols.push("banned"); vals.push("false"); }
      await q(`INSERT INTO neon_auth."user" (${cols.join(", ")}) VALUES (${vals.join(", ")})`, [
        authUserId,
        plainName || prof[0].full_name || email.split("@")[0],
        email,
      ]);
    } else {
      const sets = ["email = $1"];
      if (evCol) sets.push(`${evCol} = true`);
      if (uUaCol) sets.push(`${uUaCol} = now()`);
      if (uCols.has("banned")) sets.push("banned = false");
      await q(`UPDATE neon_auth."user" SET ${sets.join(", ")} WHERE id::text = $2`, [email, authUserId]);
    }

    const existing = await q(`SELECT id::text AS id, password FROM neon_auth.account WHERE ${uidCol}::text = $1 AND ${pidCol} = 'credential' LIMIT 1`, [authUserId]);
    const previousHash = existing[0]?.password || null;
    if (existing[0]) {
      const sets = ["password = $1"];
      if (aUaCol) sets.push(`${aUaCol} = now()`);
      await q(`UPDATE neon_auth.account SET ${sets.join(", ")} WHERE id::text = $2`, [newHash, existing[0].id]);
    } else {
      const cols = ["id", aidCol, pidCol, uidCol, "password"];
      const vals = ["$1", "$2", "'credential'", "$3", "$4"];
      if (aCaCol) { cols.push(aCaCol); vals.push("now()"); }
      if (aUaCol) { cols.push(aUaCol); vals.push("now()"); }
      await q(`INSERT INTO neon_auth.account (${cols.join(", ")}) VALUES (${vals.join(", ")})`, [randomUUID(), authUserId, authUserId, newHash]);
    }
    return { ok: true, userId: authUserId, previousHash };
  });
}

async function handleForgotPasswordCustom(env, body) {
  const email = cleanEmail(body?.email);
  if (!EMAIL_RE.test(email)) return { status: 400, body: { ok: false, message: "נא להזין כתובת אימייל תקינה" } };
  const key = String(env.RESEND_API_KEY || "").trim();
  if (!key) return { status: 503, body: { ok: false, message: "חסר מפתח RESEND_API_KEY בלשונית Environment ב-Render" } };

  const profRows = await db.query(`SELECT id::text AS id, full_name FROM public.profiles WHERE lower(btrim(email)) = $1 LIMIT 1`, [email]);
  const authRows = await runNeonAuthWork((q) => q(`SELECT id::text AS id, name FROM neon_auth."user" WHERE lower(btrim(email)) = $1 LIMIT 1`, [email])).catch(() => []);
  if (!profRows[0] && !authRows[0]) {
    return { status: 200, body: { ok: true, message: "אם הכתובת רשומה במערכת, נשלחה אליה סיסמה זמנית" } };
  }
  const fullName = profRows[0]?.full_name || authRows[0]?.name || "";
  const tempPassword = makeTempPassword();
  const hash = await hashPassword(tempPassword);
  if (!(await verifyPassword(tempPassword, hash))) {
    return { status: 500, body: { ok: false, message: "שגיאה ביצירת סיסמה זמנית — נסה שוב" } };
  }
  const updated = await upsertNeonCredentialPassword(email, fullName, hash);
  if (!updated.ok) return { status: 500, body: { ok: false, message: "לא הצלחנו לעדכן סיסמה לחשבון זה" } };

  const html = wrapEmailHtml(
    "סיסמה זמנית חדשה",
    `<p style="margin:0 0 12px;font-size:14px">שלום${fullName ? ` ${escapeHtml(fullName)}` : ""},</p>
     <p style="margin:0 0 8px;font-size:13px">הסיסמה הזמנית החדשה שלך להתחברות למערכת:</p>
     <p style="margin:0 0 16px;font-size:22px;font-weight:bold;letter-spacing:2px;background:#eef2ff;border:1px solid #c7d2fe;padding:12px;border-radius:10px;text-align:center;color:#312e81" dir="ltr">${escapeHtml(tempPassword)}</p>
     <p style="margin:0;font-size:13px">התחבר עם <span dir="ltr">${escapeHtml(email)}</span> והחלף לסיסמה קבועה.</p>`,
  );

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "נס מולטימדיה <no-reply@nsmm.work>",
      to: [email],
      reply_to: env.INVITE_FROM_EMAIL || "a0525092333@gmail.com",
      subject: "סיסמה זמנית חדשה — נס מולטימדיה",
      html,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (updated.previousHash) await upsertNeonCredentialPassword(email, fullName, updated.previousHash).catch(() => {});
    return { status: 503, body: { ok: false, message: `שליחת המייל נכשלה מול Resend (${res.status}): ${errText.slice(0, 140)}` } };
  }
  await db.query(`UPDATE public.profiles SET must_change_password = true WHERE id::text = $1 OR lower(btrim(email)) = $2`, [updated.userId, email]).catch(() => {});
  return { status: 200, body: { ok: true, message: "סיסמה זמנית נשלחה לכתובת המייל שלך" } };
}

function userIdFromBearer(headers) {
  const parts = String(headers.authorization || headers.Authorization || "").replace(/^Bearer\s+/i, "").split(".");
  if (parts.length < 2) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return p.sub || p.user_id || p.id || null;
  } catch {
    return null;
  }
}

async function verifyModuleAccess(headers, env, module, action = "edit") {
  const auth = headers.authorization || headers.Authorization;
  const base = String(env.NEON_DATA_API_URL || env.VITE_NEON_DATA_API_URL || "").replace(/\/+$/, "");
  if (!auth || !base) return { ok: false, status: 401, message: "פג תוקף החיבור — התחבר מחדש" };
  try {
    const [adminRes, approvedRes, permRes] = await Promise.all([
      fetch(`${base}/rpc/is_super_admin`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" }),
      fetch(`${base}/rpc/is_approved`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" }),
      fetch(`${base}/rpc/has_permission`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ p_module: module, p_action: action }) }),
    ]);
    if (adminRes.ok && (await adminRes.json()) === true) return { ok: true };
    if (adminRes.status === 401 || approvedRes.status === 401) return { ok: false, status: 401, message: "פג תוקף החיבור — התחבר מחדש" };
    if (!approvedRes.ok || (await approvedRes.json()) !== true) return { ok: false, status: 403, message: "החשבון ממתין לאישור מנהל" };
    if (permRes.ok && (await permRes.json()) === true) return { ok: true };
    return { ok: false, status: 403, message: "אין לך הרשאה לבצע פעולה זו" };
  } catch {
    return { ok: false, status: 503, message: "שגיאה בבדיקת ההרשאות — נסה שוב" };
  }
}

async function handleAdminResetCustom({ headers, env, body }) {
  const caller = await verifyModuleAccess(headers, env, "users", "edit");
  if (!caller.ok) return { status: caller.status, body: { ok: false, message: caller.message } };
  const targetId = String(body?.user_id || "").trim();
  if (!targetId) return { status: 400, body: { ok: false, message: "חסר מזהה משתמש" } };
  const target = (await db.query(`SELECT id::text AS id, email, full_name FROM public.profiles WHERE id::text = $1`, [targetId]))[0];
  if (!target?.email) return { status: 404, body: { ok: false, message: "המשתמש לא נמצא" } };
  const password = makeTempPassword();
  const hash = await hashPassword(password);
  const updated = await upsertNeonCredentialPassword(cleanEmail(target.email), target.full_name, hash);
  if (!updated.ok) return { status: 500, body: { ok: false, message: "לא הצלחנו לעדכן סיסמה למשתמש" } };
  await db.query(`UPDATE public.profiles SET must_change_password = true WHERE id::text = $1`, [target.id]).catch(() => {});
  return { status: 200, body: { ok: true, password, email_configured: Boolean(env.RESEND_API_KEY), target } };
}

async function handleQuoteCcSettings({ method, headers, env, json }) {
  if (method === "GET") {
    const okView = await verifyModuleAccess(headers, env, "quotes", "view");
    const access = okView.ok ? okView : await verifyModuleAccess(headers, env, "quotes", "edit");
    if (!access.ok) return { status: access.status, body: { ok: false, message: access.message } };
    await ensureQuoteCcColumn();
    const rows = await db.query(`SELECT quote_cc_emails FROM public.company_settings WHERE id = 1`);
    return { status: 200, headers: { "Cache-Control": "no-store" }, body: { ok: true, emails: dedupeEmails(rows[0]?.quote_cc_emails ?? []) } };
  }
  if (method === "POST") {
    const caller = await verifyModuleAccess(headers, env, "quotes", "edit");
    if (!caller.ok) return { status: caller.status, body: { ok: false, message: caller.message } };
    const candidates = parseEmailList(json()?.emails);
    const bad = candidates.find((c) => !EMAIL_RE.test(c));
    if (bad) return { status: 400, body: { ok: false, message: `כתובת אימייל לא תקינה: ${bad}` } };
    const emails = dedupeEmails(candidates);
    await ensureQuoteCcColumn();
    await db.query(
      `INSERT INTO public.company_settings (id, quote_cc_emails, updated_at) VALUES (1, $1::text[], now())
       ON CONFLICT (id) DO UPDATE SET quote_cc_emails = EXCLUDED.quote_cc_emails, updated_at = now()`,
      [emails],
    );
    return { status: 200, headers: { "Cache-Control": "no-store" }, body: { ok: true, emails } };
  }
  return { status: 405, body: { ok: false, error: "method_not_allowed" } };
}

function jpegDims(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0xd9) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

async function handleSendQuoteWithCc({ headers, env, body, id }) {
  const caller = await verifyModuleAccess(headers, env, "quotes", "edit");
  if (!caller.ok) return { status: caller.status, body: { ok: false, message: caller.message } };
  const key = String(env.RESEND_API_KEY || "").trim();
  if (!key) return { status: 503, body: { ok: false, message: "חסר RESEND_API_KEY בהגדרות השרת ב-Render" } };

  const to = cleanEmail(body?.to);
  if (!EMAIL_RE.test(to)) return { status: 400, body: { ok: false, message: "כתובת האימייל של הלקוח אינה תקינה" } };

  await ensureQuoteCcColumn();
  const rawCc = body && Object.hasOwn(body, "cc") && body.cc !== undefined
    ? body.cc
    : (await db.query(`SELECT quote_cc_emails FROM public.company_settings WHERE id = 1`))[0]?.quote_cc_emails ?? [];
  const ccParsed = parseEmailList(rawCc);
  const badCc = ccParsed.find((c) => !EMAIL_RE.test(c));
  if (badCc) return { status: 400, body: { ok: false, message: `כתובת עותק (CC) לא תקינה: ${badCc}` } };
  const ccList = dedupeEmails(ccParsed, to);

  const quote = (await db.query(`SELECT * FROM public.quotes WHERE id = $1`, [id]))[0];
  if (!quote) return { status: 404, body: { ok: false, message: "ההצעה לא נמצאה" } };
  const [items, imageRows, settingsRows, eventRows] = await Promise.all([
    db.query(`SELECT * FROM public.quote_items WHERE quote_id = $1 ORDER BY sort_order ASC, created_at ASC`, [id]),
    db.query(`SELECT position, mime, data_url, caption FROM public.quote_images WHERE quote_id = $1 ORDER BY position ASC, id ASC`, [id]),
    db.query(`SELECT company_name, tax_id, address, phone, email, logo_url FROM public.company_settings WHERE id = 1`),
    quote.event_id ? db.query(`SELECT address FROM public.events WHERE id = $1`, [quote.event_id]) : Promise.resolve([]),
  ]);
  const settings = settingsRows[0] || {};
  const eventAddress = (quote.event_address && String(quote.event_address).trim()) || eventRows[0]?.address || null;

  let customLogo;
  if (settings.logo_url) {
    try {
      const lr = await fetch(settings.logo_url);
      if (lr.ok && /jpe?g/i.test(lr.headers.get("content-type") || "")) {
        const buffer = Buffer.from(await lr.arrayBuffer());
        const dims = jpegDims(buffer);
        if (dims) customLogo = { buffer, width: dims.width, height: dims.height };
      }
    } catch {}
  }

  const pdf = buildQuotePdf({ quote, items, settings, eventAddress, ...(customLogo ? { logo: customLogo } : {}), images: imageRows });
  const senderId = userIdFromBearer(headers);
  const senderEmail = senderId ? (await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [senderId]))[0]?.email : null;
  const replyTo = senderEmail || env.INVITE_FROM_EMAIL || settings.email || "a0525092333@gmail.com";
  const msg = String(body?.message ?? "").trim();

  const html = wrapEmailHtml(
    `הצעת מחיר מס׳ ${escapeHtml(quote.quote_number)}`,
    `<p style="margin:0 0 12px;font-size:14px">שלום${quote.client_name ? ` ${escapeHtml(quote.client_name)}` : ""},</p>
     <p style="margin:0 0 12px;font-size:14px">מצורפת הצעת המחיר שלך כקובץ PDF.</p>
     ${msg ? `<p style="margin:0 0 12px;font-size:14px;white-space:pre-wrap">${escapeHtml(msg)}</p>` : ""}`,
  );

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "נס מולטימדיה <no-reply@nsmm.work>",
      to: [to],
      ...(ccList.length ? { cc: ccList } : {}),
      reply_to: replyTo,
      subject: `הצעת מחיר מס׳ ${quote.quote_number} — ${settings.company_name || "נס מולטימדיה"}`,
      html,
      attachments: [{ filename: `הצעת-מחיר-${quote.quote_number}.pdf`, content: pdf.toString("base64") }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { status: 503, body: { ok: false, message: `שליחת ההצעה נכשלה: ${errText.slice(0, 200)}` } };
  }
  await db.query(`UPDATE public.quotes SET last_sent_at = now(), last_sent_to = $1 WHERE id = $2`, [[to, ...ccList].join(", "), id]).catch(() => {});
  return { status: 200, body: { ok: true, to, cc: ccList } };
}

async function bootstrapAuthPermissions() {
  try {
    const owner = (await db.query("SELECT current_user AS u"))[0]?.u;
    if (owner && /^[a-zA-Z0-9_]+$/.test(owner)) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE neon_auth");
        await client.query(`GRANT USAGE ON SCHEMA neon_auth TO "${owner}"`);
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA neon_auth TO "${owner}"`);
        await client.query("RESET ROLE");
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK").catch(() => {});
      } finally {
        client.release();
      }
    }
    const cols = new Set((await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'neon_auth' AND table_name = 'user'`)).map((r) => r.column_name));
    const evCol = cols.has("emailVerified") ? '"emailVerified"' : cols.has("email_verified") ? "email_verified" : null;
    if (evCol) {
      await db.query(`UPDATE neon_auth."user" SET ${evCol} = true WHERE ${evCol} IS DISTINCT FROM true`);
    }
  } catch (err) {
    console.error("[bootstrap] auth check skipped:", err?.message || err);
  }
}


const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};

const server = http.createServer(async (req, res) => {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers.host || "localhost:3000";
  const requestOrigin = `${proto}://${host}`;
  const url = new URL(req.url || "/", requestOrigin);

  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let rawBody = Buffer.concat(chunks);

    if ((url.pathname === "/api/auth/sign-in/email" || url.pathname === "/api/auth/sign-up/email") && req.method === "POST" && rawBody.length) {
      try {
        const parsed = JSON.parse(rawBody.toString("utf8"));
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.email === "string") parsed.email = cleanEmail(parsed.email);
          if (typeof parsed.password === "string") parsed.password = cleanPass(parsed.password);
          rawBody = Buffer.from(JSON.stringify(parsed), "utf8");
        }
      } catch {}
    }

    const json = () => (rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {});
    const reqEnv = {
      ...process.env,
      NEON_AUTH_TRUSTED_ORIGIN: process.env.NEON_AUTH_TRUSTED_ORIGIN || requestOrigin,
    };

    let result;
    try {
      const quoteSendMatch = url.pathname.match(/^\/api\/quotes\/([^/]+)\/send-email$/);
      if (url.pathname === "/api/quotes/cc-settings") {
        result = await handleQuoteCcSettings({ method: req.method || "GET", headers: req.headers, env: reqEnv, json });
      } else if (quoteSendMatch && req.method === "POST") {
        result = await handleSendQuoteWithCc({ headers: req.headers, env: reqEnv, body: json(), id: quoteSendMatch[1] });
      } else if (url.pathname === "/api/auth/forgot-password" && req.method === "POST") {
        result = await handleForgotPasswordCustom(reqEnv, json());
      } else if (url.pathname === "/api/admin/reset-password" && req.method === "POST") {
        result = await handleAdminResetCustom({ headers: req.headers, env: reqEnv, body: json() });
      } else {
        result = await handler({
          method: req.method || "GET",
          path: url.pathname,
          url,
          headers: req.headers,
          rawBody,
          json,
          env: reqEnv,
          db,
        });
        if (url.pathname === "/api/auth/sign-in/email" && result.status !== 200) {
          console.error("[auth] sign-in rejected:", result.status, String(result.body || "").slice(0, 300));
        }
      }
    } catch (err) {
      console.error("[server] api error:", err?.message || err);
      result = { status: 500, body: { ok: false, error: "server", message: "אירעה שגיאה בשרת — נסה שוב" } };
    }

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
  bootstrapAuthPermissions();
});
