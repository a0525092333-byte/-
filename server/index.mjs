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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIDI_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OWNER_EMAIL = "a0525092333@gmail.com";
let quoteCcReady = false;

const cleanEmail = (raw) => String(raw ?? "").replace(BIDI_RE, "").replace(/\s+/g, "").toLowerCase();
const cleanPass = (raw) => String(raw ?? "").replace(BIDI_RE, "").trim();
const escapeHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseJsonSafe(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch {
    return null;
  }
}

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
  const prof = await db.query(
    `SELECT id::text AS id, full_name FROM public.profiles WHERE lower(btrim(email)) = $1 AND email NOT LIKE 'legacy-%@old.local' LIMIT 1`,
    [email],
  );
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
      if (uCols.has("role")) { cols.push("role"); vals.push(email === OWNER_EMAIL ? "'admin'" : "'user'"); }
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

    const existing = await q(
      `SELECT password FROM neon_auth.account WHERE ${uidCol}::text = $1 AND password IS NOT NULL LIMIT 1`,
      [authUserId],
    );
    const previousHash = existing[0]?.password || null;

    await q(`DELETE FROM neon_auth.account WHERE ${uidCol}::text = $1 AND ${pidCol} = 'credential'`, [authUserId]);

    const cols = ["id", aidCol, pidCol, uidCol, "password"];
    const vals = ["$1", "$2", "'credential'", "$3", "$4"];
    if (aCaCol) { cols.push(aCaCol); vals.push("now()"); }
    if (aUaCol) { cols.push(aUaCol); vals.push("now()"); }
    await q(`INSERT INTO neon_auth.account (${cols.join(", ")}) VALUES (${vals.join(", ")})`, [
      randomUUID(),
      authUserId,
      authUserId,
      newHash,
    ]);
    return { ok: true, userId: authUserId, previousHash };
  });
}

function userIdFromBearer(headers) {
  const parts = String(headers.authorization || headers.Authorization || "").replace(/^Bearer\s+/i, "").split(".");
  if (parts.length < 2) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (p?.role === "anonymous") return null;
    const uid = p?.sub || p?.user_id || p?.id || null;
    return typeof uid === "string" && UUID_RE.test(uid) ? uid : null;
  } catch {
    return null;
  }
}

async function forwardAuthSmart({ method, pathname, url, headers, rawBody, reqEnv }) {
  const cleanHeaders = { ...headers };
  if (pathname === "/api/auth/sign-in/email" || pathname === "/api/auth/sign-up/email") {
    delete cleanHeaders.cookie;
    delete cleanHeaders.Cookie;
  }

  const runOnce = (hdrs) =>
    handler({
      method,
      path: pathname,
      url,
      headers: hdrs,
      rawBody,
      json: () => parseJsonSafe(rawBody) ?? {},
      env: reqEnv,
      db,
    });

  const first = await runOnce(cleanHeaders);

  if (method === "GET" && (pathname === "/api/auth/get-session" || pathname === "/api/auth/token")) {
    const bodyObj = parseJsonSafe(first.body);
    const valid = pathname === "/api/auth/get-session" ? Boolean(bodyObj?.user?.id) : Boolean(bodyObj?.token);
    const rawCookie = String(headers.cookie || headers.Cookie || "");
    if (!valid && rawCookie.includes(";")) {
      const parts = rawCookie.split(";").map((c) => c.trim()).filter(Boolean);
      const sessionParts = parts.filter((c) => c.split("=")[0]?.includes("session_token"));
      const otherParts = parts.filter((c) => !c.split("=")[0]?.includes("session_token"));
      if (sessionParts.length > 1) {
        for (let i = sessionParts.length - 1; i >= 0; i -= 1) {
          const singleCookie = [sessionParts[i], ...otherParts].join("; ");
          const retryHeaders = { ...headers, cookie: singleCookie };
          delete retryHeaders.Cookie;
          const candidate = await runOnce(retryHeaders);
          const candObj = parseJsonSafe(candidate.body);
          const candOk = pathname === "/api/auth/get-session" ? Boolean(candObj?.user?.id) : Boolean(candObj?.token);
          if (candOk) return candidate;
        }
      }
    }
  }

  if (pathname === "/api/auth/sign-in/email" && first.status !== 200) {
    console.error("[auth] sign-in rejected:", first.status, String(first.body || "").slice(0, 300));
  }
  return first;
}

async function resolveCallerSession({ headers, reqEnv, url }) {
  const auth = headers.authorization || headers.Authorization;
  const bearerUid = userIdFromBearer(headers);
  const base = String(reqEnv.NEON_DATA_API_URL || reqEnv.VITE_NEON_DATA_API_URL || "").replace(/\/+$/, "");

  if (auth && bearerUid && base) {
    try {
      const [adminRes, approvedRes] = await Promise.all([
        fetch(`${base}/rpc/is_super_admin`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" }),
        fetch(`${base}/rpc/is_approved`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" }),
      ]);
      if (adminRes.status !== 401 && approvedRes.status !== 401) {
        const isSuper = adminRes.ok && (await adminRes.json()) === true;
        const isApp = approvedRes.ok && (await approvedRes.json()) === true;
        if (isSuper || isApp) return { ok: true, userId: bearerUid };
      }
    } catch {}
  }

  if (headers.cookie || headers.Cookie) {
    try {
      const sessRes = await forwardAuthSmart({
        method: "GET",
        pathname: "/api/auth/get-session",
        url,
        headers,
        rawBody: Buffer.alloc(0),
        reqEnv,
      });
      const sessObj = parseJsonSafe(sessRes.body);
      const cookieUid = sessObj?.user?.id;
      if (typeof cookieUid === "string" && UUID_RE.test(cookieUid)) {
        return { ok: true, userId: cookieUid };
      }
    } catch {}
  }

  return { ok: false, status: 401 };
}

async function handlePasswordStatusCustom({ headers, reqEnv, url }) {
  const sess = await resolveCallerSession({ headers, reqEnv, url });
  if (!sess.ok) {
    return { status: 401, body: { ok: false, error: "unauthorized", message: "פג תוקף ההתחברות — התחבר מחדש" } };
  }
  const rows = await db.query(
    `SELECT email, role, is_active, approval_status, must_change_password FROM public.profiles WHERE id::text = $1 LIMIT 1`,
    [sess.userId],
  );
  const prof = rows[0];
  if (!prof || (cleanEmail(prof.email) !== OWNER_EMAIL && (prof.is_active === false || prof.approval_status !== "approved"))) {
    return { status: 200, body: { ok: true, mustChangePassword: false, role: null } };
  }
  return {
    status: 200,
    body: { ok: true, mustChangePassword: prof.must_change_password === true, role: prof.role ?? null },
  };
}

async function handleChangePasswordCustom({ headers, reqEnv, url, body }) {
  const sess = await resolveCallerSession({ headers, reqEnv, url });
  if (!sess.ok) {
    return { status: 401, body: { ok: false, error: "unauthorized", message: "פג תוקף ההתחברות — התחבר מחדש ונסה שוב" } };
  }
  const rows = await db.query(
    `SELECT id::text AS id, email, full_name, is_active, approval_status FROM public.profiles WHERE id::text = $1 LIMIT 1`,
    [sess.userId],
  );
  const prof = rows[0];
  if (!prof || (cleanEmail(prof.email) !== OWNER_EMAIL && (prof.is_active === false || prof.approval_status !== "approved"))) {
    return { status: 403, body: { ok: false, error: "forbidden", message: "אין הרשאה לבצע פעולה זו" } };
  }

  const rawCurrent = String(body?.currentPassword ?? "").replace(BIDI_RE, "");
  const trimmedCurrent = rawCurrent.trim();
  const newPassword = cleanPass(body?.newPassword);

  if (newPassword.length < 8) {
    return { status: 400, body: { ok: false, error: "weak_password", message: "הסיסמה החדשה חייבת להכיל 8 תווים לפחות" } };
  }
  if (newPassword === rawCurrent || newPassword === trimmedCurrent) {
    return { status: 400, body: { ok: false, error: "same_password", message: "הסיסמה החדשה חייבת להיות שונה מהסיסמה הזמנית" } };
  }

  const currentHash = await runNeonAuthWork(async (q) => {
    const aCols = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'neon_auth' AND table_name = 'account'`)).map((r) => r.column_name));
    const uidCol = aCols.has("userId") ? '"userId"' : "user_id";
    const accs = await q(`SELECT password FROM neon_auth.account WHERE ${uidCol}::text = $1 AND password IS NOT NULL LIMIT 1`, [prof.id]);
    return accs[0]?.password || null;
  });

  if (!currentHash) {
    return { status: 400, body: { ok: false, error: "no_password", message: "לא נמצאה סיסמה קיימת לחשבון" } };
  }

  const validCurrent =
    (await verifyPassword(rawCurrent, currentHash)) ||
    (trimmedCurrent !== rawCurrent && (await verifyPassword(trimmedCurrent, currentHash)));

  if (!validCurrent) {
    return { status: 400, body: { ok: false, error: "wrong_password", message: "הסיסמה הנוכחית (הזמנית) שגויה — ודא שלא חסר תו" } };
  }

  const newHash = await hashPassword(newPassword);
  if (!(await verifyPassword(newPassword, newHash))) {
    return { status: 500, body: { ok: false, error: "hash_failed", message: "שגיאה בהצפנת הסיסמה — נסה שוב" } };
  }

  const updated = await upsertNeonCredentialPassword(cleanEmail(prof.email), prof.full_name, newHash);
  if (!updated.ok) {
    return { status: 500, body: { ok: false, error: "write_failed", message: "שמירת הסיסמה החדשה נכשלה — נסה שוב" } };
  }

  await db.query(`UPDATE public.profiles SET must_change_password = false WHERE id::text = $1`, [prof.id]);
  return { status: 200, body: { ok: true } };
}

async function handleForgotPasswordCustom(env, body) {
  const email = cleanEmail(body?.email);
  if (!EMAIL_RE.test(email)) return { status: 400, body: { ok: false, message: "נא להזין כתובת אימייל תקינה" } };
  const key = String(env.RESEND_API_KEY || "").trim();
  if (!key) return { status: 503, body: { ok: false, message: "חסר מפתח RESEND_API_KEY בלשונית Environment ב-Render" } };

  const profRows = await db.query(
    `SELECT id::text AS id, full_name FROM public.profiles WHERE lower(btrim(email)) = $1 AND email NOT LIKE 'legacy-%@old.local' LIMIT 1`,
    [email],
  );
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
     <p style="margin:0;font-size:13px">התחבר עם <span dir="ltr">${escapeHtml(email)}</span> ובחר סיסמה קבועה חדשה.</p>`,
  );

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "נס מולטימדיה <no-reply@nsmm.work>",
      to: [email],
      reply_to: env.INVITE_FROM_EMAIL || OWNER_EMAIL,
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

async function verifyModuleAccess(headers, env, module, action = "edit", url = null) {
  const sess = await resolveCallerSession({ headers, reqEnv: env, url: url || new URL("https://nsmm.work/") });
  if (!sess.ok) return { ok: false, status: 401, message: "פג תוקף החיבור — התחבר מחדש" };
  const rows = await db.query(
    `SELECT p.id::text AS id, p.email, p.role, p.is_active, p.approval_status,
            coalesce(up.can_view, false) AS can_view, coalesce(up.can_edit, false) AS can_edit
     FROM public.profiles p
     LEFT JOIN public.user_permissions up ON up.user_id = p.id AND up.module = $2
     WHERE p.id::text = $1 LIMIT 1`,
    [sess.userId, module],
  );
  const prof = rows[0];
  if (!prof) return { ok: false, status: 403, message: "החשבון אינו מוגדר במערכת" };
  if (cleanEmail(prof.email) === OWNER_EMAIL) return { ok: true, userId: prof.id, isOwner: true, role: "admin" };
  if (prof.is_active === false || prof.approval_status !== "approved") {
    return { ok: false, status: 403, message: "החשבון ממתין לאישור מנהל" };
  }
  const allowed = action === "edit" ? prof.can_edit === true : prof.can_view === true || prof.can_edit === true;
  if (!allowed) return { ok: false, status: 403, message: "אין לך הרשאה לבצע פעולה זו" };
  return { ok: true, userId: prof.id, isOwner: false, role: prof.role };
}

async function handleAdminResetCustom({ headers, env, body, url }) {
  const caller = await verifyModuleAccess(headers, env, "users", "edit", url);
  if (!caller.ok) return { status: caller.status, body: { ok: false, message: caller.message } };
  const targetId = String(body?.user_id || "").trim();
  if (!UUID_RE.test(targetId)) return { status: 400, body: { ok: false, message: "חסר מזהה משתמש תקין" } };
  const target = (await db.query(`SELECT id::text AS id, email, full_name FROM public.profiles WHERE id::text = $1`, [targetId]))[0];
  if (!target?.email) return { status: 404, body: { ok: false, message: "המשתמש לא נמצא" } };
  const password = makeTempPassword();
  const hash = await hashPassword(password);
  const updated = await upsertNeonCredentialPassword(cleanEmail(target.email), target.full_name, hash);
  if (!updated.ok) return { status: 500, body: { ok: false, message: "לא הצלחנו לעדכן סיסמה למשתמש" } };
  await db.query(`UPDATE public.profiles SET must_change_password = true WHERE id::text = $1`, [target.id]).catch(() => {});
  return { status: 200, body: { ok: true, password, email_configured: Boolean(env.RESEND_API_KEY), target } };
}

async function handleAdminDeleteUser({ headers, env, body, url }) {
  const caller = await verifyModuleAccess(headers, env, "users", "edit", url);
  if (!caller.ok) return { status: caller.status, body: { ok: false, message: caller.message } };
  if (!caller.isOwner && caller.role !== "admin") {
    return { status: 403, body: { ok: false, error: "admin_only", message: "מחיקת משתמשים מותרת להרשאת מנהל בלבד" } };
  }

  const targetId = String(body?.user_id || "").trim();
  if (!UUID_RE.test(targetId)) {
    return { status: 400, body: { ok: false, message: "מזהה משתמש לא תקין" } };
  }
  if (targetId === caller.userId) {
    return { status: 400, body: { ok: false, message: "לא ניתן למחוק את החשבון שמחובר כעת" } };
  }

  const targetRows = await db.query(`SELECT id::text AS id, email, full_name, role FROM public.profiles WHERE id::text = $1 LIMIT 1`, [targetId]);
  const target = targetRows[0];
  if (!target) {
    return { status: 404, body: { ok: false, message: "המשתמש לא נמצא" } };
  }
  const targetEmail = cleanEmail(target.email);
  if (targetEmail === OWNER_EMAIL) {
    return { status: 403, body: { ok: false, message: "לא ניתן למחוק את חשבון בעל המערכת" } };
  }
  if (!caller.isOwner && target.role === "admin") {
    return { status: 403, body: { ok: false, message: "רק בעל המערכת רשאי למחוק משתמש בדרגת מנהל" } };
  }

  await db.transaction([
    { text: `UPDATE public.invites SET invited_by = $2::uuid WHERE invited_by = $1::uuid`, params: [targetId, caller.userId] },
    { text: `DELETE FROM public.invites WHERE lower(btrim(email)) = $1 AND status = 'pending'`, params: [targetEmail] },
    { text: `UPDATE public.profiles SET approved_by = NULL WHERE approved_by = $1::uuid`, params: [targetId] },
    { text: `UPDATE public.crew_members SET user_id = NULL WHERE user_id = $1::uuid`, params: [targetId] },
    { text: `DELETE FROM public.user_permissions WHERE user_id = $1::uuid`, params: [targetId] },
    { text: `DELETE FROM public.profiles WHERE id = $1::uuid`, params: [targetId] },
  ]);

  await runNeonAuthWork(async (q) => {
    for (const tbl of ["session", "member", "account"]) {
      const cols = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'neon_auth' AND table_name = $1`, [tbl])).map((r) => r.column_name));
      const uCol = cols.has("userId") ? '"userId"' : cols.has("user_id") ? "user_id" : null;
      if (uCol) await q(`DELETE FROM neon_auth.${tbl} WHERE ${uCol}::text = $1`, [targetId]).catch(() => {});
    }
    await q(`DELETE FROM neon_auth."user" WHERE id::text = $1`, [targetId]).catch(() => {});
  }).catch((err) => {
    console.error("[delete-user] neon_auth cleanup warning:", err?.message || err);
  });

  return { status: 200, body: { ok: true, deleted_id: targetId, full_name: target.full_name } };
}

async function handleQuoteCcSettings({ method, headers, env, json, url }) {
  if (method === "GET") {
    const okView = await verifyModuleAccess(headers, env, "quotes", "view", url);
    const access = okView.ok ? okView : await verifyModuleAccess(headers, env, "quotes", "edit", url);
    if (!access.ok) return { status: access.status, body: { ok: false, message: access.message } };
    await ensureQuoteCcColumn();
    const rows = await db.query(`SELECT quote_cc_emails FROM public.company_settings WHERE id = 1`);
    return { status: 200, headers: { "Cache-Control": "no-store" }, body: { ok: true, emails: dedupeEmails(rows[0]?.quote_cc_emails ?? []) } };
  }
  if (method === "POST") {
    const caller = await verifyModuleAccess(headers, env, "quotes", "edit", url);
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

async function handleSendQuoteWithCc({ headers, env, body, id, url }) {
  const caller = await verifyModuleAccess(headers, env, "quotes", "edit", url);
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
  const senderEmail = caller.userId ? (await db.query(`SELECT email FROM public.profiles WHERE id::text = $1`, [caller.userId]))[0]?.email : null;
  const replyTo = senderEmail || env.INVITE_FROM_EMAIL || settings.email || OWNER_EMAIL;
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
        result = await handleQuoteCcSettings({ method: req.method || "GET", headers: req.headers, env: reqEnv, json, url });
      } else if (quoteSendMatch && req.method === "POST") {
        result = await handleSendQuoteWithCc({ headers: req.headers, env: reqEnv, body: json(), id: quoteSendMatch[1], url });
      } else if (url.pathname === "/api/auth/forgot-password" && req.method === "POST") {
        result = await handleForgotPasswordCustom(reqEnv, json());
      } else if (url.pathname === "/api/account/password-status" && req.method === "GET") {
        result = await handlePasswordStatusCustom({ headers: req.headers, reqEnv, url });
      } else if (url.pathname === "/api/account/change-password" && req.method === "POST") {
        result = await handleChangePasswordCustom({ headers: req.headers, reqEnv, url, body: json() });
      } else if (url.pathname === "/api/admin/reset-password" && req.method === "POST") {
        result = await handleAdminResetCustom({ headers: req.headers, env: reqEnv, body: json(), url });
      } else if (url.pathname === "/api/admin/delete-user" && req.method === "POST") {
        result = await handleAdminDeleteUser({ headers: req.headers, env: reqEnv, body: json(), url });
      } else if (url.pathname.startsWith("/api/auth/") && (req.method === "GET" || req.method === "POST")) {
        result = await forwardAuthSmart({ method: req.method || "GET", pathname: url.pathname, url, headers: req.headers, rawBody, reqEnv });
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
// END OF FILE - server/index.mjs
