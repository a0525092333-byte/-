import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import handler, { buildQuotePdf } from "./routes.mjs";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let companySettingsSchemaState = null;

async function ensureCompanySettingsReady(database) {
  if (companySettingsSchemaState) return companySettingsSchemaState;

  await database.query(`
    CREATE TABLE IF NOT EXISTS public.company_settings (
      id integer PRIMARY KEY DEFAULT 1,
      company_name text NOT NULL DEFAULT 'נס סגא לדים ומולטימדיה בע״מ',
      logo_url text,
      tax_id text,
      address text,
      phone text,
      email text,
      default_vat_rate numeric(5,2) NOT NULL DEFAULT 18,
      default_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
      default_terms_text text,
      default_notes text,
      quote_number_prefix text NOT NULL DEFAULT '',
      quote_cc_emails text[] NOT NULL DEFAULT '{}'::text[],
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await database.query(`
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS company_name text NOT NULL DEFAULT 'נס סגא לדים ומולטימדיה בע״מ';
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS logo_url text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS tax_id text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS address text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS phone text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS default_vat_rate numeric(5,2) NOT NULL DEFAULT 18;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS default_terms_text text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS default_notes text;
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS quote_number_prefix text NOT NULL DEFAULT '';
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS quote_cc_emails text[] NOT NULL DEFAULT '{}'::text[];
    ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  `);

  const colRows = await database.query(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_settings'
  `);

  let termsUdt = colRows.find((r) => r.column_name === "default_terms")?.udt_name || null;
  if (!termsUdt) {
    await database.query(`
      ALTER TABLE public.company_settings
        ADD COLUMN IF NOT EXISTS default_terms jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
    termsUdt = "jsonb";
  }

  try {
    const safeCols = colRows
      .map((r) => String(r.column_name))
      .filter((c) => !["backup_drive_token", "paperless_api_key"].includes(c) && /^[a-z0-9_]+$/i.test(c));
    if (!safeCols.includes("default_terms")) safeCols.push("default_terms");
    if (safeCols.length > 0) {
      await database.query(
        `GRANT SELECT (${safeCols.map((c) => `"${c}"`).join(", ")}) ON public.company_settings TO authenticated;`,
      );
      await database.query(`NOTIFY pgrst, 'reload schema';`);
    }
  } catch {
    // Non-fatal: reads and writes are served directly through /api/quotes/company-settings
  }

  companySettingsSchemaState = { termsUdt };
  return companySettingsSchemaState;
}

function parseEmailCandidates(raw) {
  if (Array.isArray(raw)) {
    return raw
      .flatMap((item) => String(item ?? "").split(/[,;\s]+/))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function dedupeEmails(list, excludeEmail = null) {
  const excluded = excludeEmail ? String(excludeEmail).trim().toLowerCase() : "";
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item ?? "").trim().toLowerCase();
    if (!clean || (excluded && clean === excluded) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function normalizeTermsArray(raw) {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t ?? "").trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((t) => String(t ?? "").trim()).filter(Boolean);
      }
    } catch {
      // treat as newline-separated text
    }
    return raw.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function userIdFromAuth(headers) {
  const auth = headers.authorization || headers.Authorization || "";
  const token = String(auth).replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.sub || payload.user_id || payload.id || null;
  } catch {
    return null;
  }
}

async function verifyQuotesCaller(headers, env, action = "edit") {
  const auth = headers.authorization || headers.Authorization;
  if (!auth) {
    return { ok: false, status: 401, error: "unauthorized", message: "פג תוקף החיבור — התחבר מחדש ונסה שוב" };
  }
  const base = String(env.NEON_DATA_API_URL || env.VITE_NEON_DATA_API_URL || "").replace(/\/+$/, "");
  if (!base) {
    return { ok: false, status: 500, error: "server", message: "שירות האימות אינו מוגדר" };
  }
  try {
    const checks = [
      fetch(`${base}/rpc/is_super_admin`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: "{}",
      }),
      fetch(`${base}/rpc/is_approved`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: "{}",
      }),
      fetch(`${base}/rpc/has_permission`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ p_module: "quotes", p_action: action }),
      }),
    ];
    if (action === "view") {
      checks.push(
        fetch(`${base}/rpc/has_permission`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({ p_module: "quotes", p_action: "edit" }),
        }),
      );
    }
    const [adminRes, approvedRes, permRes, editPermRes] = await Promise.all(checks);
    const superAdmin = adminRes.ok ? await adminRes.json() : null;
    const approved = approvedRes.ok ? await approvedRes.json() : null;
    const perm = permRes.ok ? await permRes.json() : null;
    const editPerm = editPermRes && editPermRes.ok ? await editPermRes.json() : null;

    if (superAdmin === true) return { ok: true, isAdmin: true };
    if (adminRes.status === 401 || approvedRes.status === 401) {
      return { ok: false, status: 401, error: "unauthorized", message: "פג תוקף החיבור — התחבר מחדש ונסה שוב" };
    }
    if (!approvedRes.ok) {
      return { ok: false, status: 503, error: "server", message: "לא הצלחנו לבדוק את הרשאת החשבון — נסה שוב" };
    }
    if (approved !== true) {
      return { ok: false, status: 403, error: "pending_approval", message: "אין הרשאה — החשבון ממתין לאישור מנהל" };
    }
    if (perm === true || editPerm === true) return { ok: true, isAdmin: false };
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: action === "edit" ? "אין לך הרשאה לערוך או לשלוח הצעות מחיר" : "אין לך הרשאה לצפות בהגדרות הצעות מחיר",
    };
  } catch (e) {
    console.error("[quote-settings] auth check failed", e?.message || e);
    return { ok: false, status: 503, error: "server", message: "שגיאה בבדיקת ההרשאות — נסה שוב" };
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailShell({ heading, bodyHtml }) {
  return `<!doctype html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,'Segoe UI',sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
        <tr><td style="background:#312e81;padding:20px 24px">
          <p style="margin:0;color:#ffffff;font-size:18px;font-weight:bold">נס מולטימדיה</p>
          <p style="margin:4px 0 0;color:#c7d2fe;font-size:12px">מערכת ניהול הפקות אירועים</p>
        </td></tr>
        <tr><td style="padding:24px">
          <h1 style="margin:0 0 12px;font-size:18px;color:#111827">${heading}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb">
          <p style="margin:0;font-size:11px;color:#6b7280">הודעה זו נשלחה ממערכת "נס מולטימדיה". אם לא ביקשת אותה, אפשר להתעלם.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function jpegDimensions(buffer) {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    const len = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

async function handleCompanyQuoteSettings({ method, headers, env, database, json }) {
  if (method === "GET") {
    const caller = await verifyQuotesCaller(headers, env, "view");
    if (!caller.ok) {
      return { status: caller.status, body: { ok: false, error: caller.error, message: caller.message } };
    }
    await ensureCompanySettingsReady(database);
    const rows = await database.query(`
      SELECT id, company_name, logo_url, tax_id, address, phone, email,
             default_vat_rate, default_terms, default_terms_text, default_notes,
             quote_number_prefix, quote_cc_emails, updated_at
      FROM public.company_settings
      WHERE id = 1
      LIMIT 1
    `);
    const row = rows[0] || null;
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: {
        ok: true,
        settings: row
          ? {
              ...row,
              default_vat_rate: Number(row.default_vat_rate ?? 18),
              default_terms: normalizeTermsArray(row.default_terms),
              quote_cc_emails: dedupeEmails(row.quote_cc_emails ?? []),
            }
          : null,
      },
    };
  }

  if (method === "POST") {
    const caller = await verifyQuotesCaller(headers, env, "edit");
    if (!caller.ok) {
      return { status: caller.status, body: { ok: false, error: caller.error, message: caller.message } };
    }
    const body = json();
    const companyName = String(body?.company_name ?? "").trim();
    if (!companyName) {
      return { status: 400, body: { ok: false, error: "missing_name", message: "נא להזין שם חברה." } };
    }

    const logoUrl = body?.logo_url ? String(body.logo_url) : null;
    const taxId = body?.tax_id ? String(body.tax_id).trim() || null : null;
    const address = body?.address ? String(body.address).trim() || null : null;
    const phone = body?.phone ? String(body.phone).trim() || null : null;
    const email = body?.email ? String(body.email).trim() || null : null;
    const vatNum = Number(body?.default_vat_rate);
    const defaultVatRate = Number.isFinite(vatNum) && vatNum >= 0 ? vatNum : 18;
    const defaultTerms = normalizeTermsArray(body?.default_terms);
    const defaultTermsText = body?.default_terms_text ? String(body.default_terms_text).trim() || null : null;
    const defaultNotes = body?.default_notes ? String(body.default_notes).trim() || null : null;
    const quoteNumberPrefix = String(body?.quote_number_prefix ?? "").trim();

    let hasCcUpdate = false;
    let ccEmails = [];
    if (body && Object.hasOwn(body, "quote_cc_emails") && body.quote_cc_emails !== undefined) {
      hasCcUpdate = true;
      const candidates = parseEmailCandidates(body.quote_cc_emails);
      for (const candidate of candidates) {
        if (!EMAIL_RE.test(candidate)) {
          return {
            status: 400,
            body: { ok: false, error: "invalid_email", message: `כתובת אימייל לא תקינה: ${candidate}` },
          };
        }
      }
      ccEmails = dedupeEmails(candidates);
      if (ccEmails.length > 20) {
        return {
          status: 400,
          body: { ok: false, error: "too_many", message: "ניתן להגדיר עד 20 נמענים קבועים" },
        };
      }
    }

    const { termsUdt } = await ensureCompanySettingsReady(database);
    const termsParam = termsUdt === "_text" ? defaultTerms : JSON.stringify(defaultTerms);
    const termsCast =
      termsUdt === "_text"
        ? "::text[]"
        : termsUdt === "jsonb"
          ? "::jsonb"
          : termsUdt === "json"
            ? "::json"
            : "::text";

    const updateParams = [
      companyName,
      logoUrl,
      taxId,
      address,
      phone,
      email,
      defaultVatRate,
      termsParam,
      defaultTermsText,
      defaultNotes,
      quoteNumberPrefix,
    ];
    if (hasCcUpdate) updateParams.push(ccEmails);

    const updated = await database.query(
      `UPDATE public.company_settings
       SET company_name = $1,
           logo_url = $2,
           tax_id = $3,
           address = $4,
           phone = $5,
           email = $6,
           default_vat_rate = $7,
           default_terms = $8${termsCast},
           default_terms_text = $9,
           default_notes = $10,
           quote_number_prefix = $11,
           ${hasCcUpdate ? "quote_cc_emails = $12::text[]," : ""}
           updated_at = now()
       WHERE id = 1
       RETURNING id`,
      updateParams,
    );

    if (!updated.length) {
      await database.query(
        `INSERT INTO public.company_settings (
           id, company_name, logo_url, tax_id, address, phone, email,
           default_vat_rate, default_terms, default_terms_text, default_notes,
           quote_number_prefix, quote_cc_emails, updated_at
         ) VALUES (
           1, $1, $2, $3, $4, $5, $6,
           $7, $8${termsCast}, $9, $10,
           $11, $12::text[], now()
         )`,
        [
          companyName,
          logoUrl,
          taxId,
          address,
          phone,
          email,
          defaultVatRate,
          termsParam,
          defaultTermsText,
          defaultNotes,
          quoteNumberPrefix,
          hasCcUpdate ? ccEmails : [],
        ],
      );
    }

    const savedRows = await database.query(
      `SELECT quote_cc_emails FROM public.company_settings WHERE id = 1 LIMIT 1`,
    );
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: {
        ok: true,
        emails: dedupeEmails(savedRows[0]?.quote_cc_emails ?? []),
      },
    };
  }

  return { status: 405, headers: { Allow: "GET, POST" }, body: { ok: false, error: "method_not_allowed" } };
}

async function handleQuoteCcSettings({ method, headers, env, database, json }) {
  if (method === "GET") {
    const caller = await verifyQuotesCaller(headers, env, "view");
    if (!caller.ok) {
      return { status: caller.status, body: { ok: false, error: caller.error, message: caller.message } };
    }
    await ensureCompanySettingsReady(database);
    const rows = await database.query(`SELECT quote_cc_emails FROM public.company_settings WHERE id = 1`);
    const emails = dedupeEmails(rows[0]?.quote_cc_emails ?? []);
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: { ok: true, emails },
    };
  }

  if (method === "POST") {
    const caller = await verifyQuotesCaller(headers, env, "edit");
    if (!caller.ok) {
      return { status: caller.status, body: { ok: false, error: caller.error, message: caller.message } };
    }
    const body = json();
    const candidates = parseEmailCandidates(body?.emails);
    for (const candidate of candidates) {
      if (!EMAIL_RE.test(candidate)) {
        return {
          status: 400,
          body: { ok: false, error: "invalid_email", message: `כתובת אימייל לא תקינה: ${candidate}` },
        };
      }
    }
    const emails = dedupeEmails(candidates);
    if (emails.length > 20) {
      return {
        status: 400,
        body: { ok: false, error: "too_many", message: "ניתן להגדיר עד 20 נמענים קבועים" },
      };
    }
    await ensureCompanySettingsReady(database);
    const updated = await database.query(
      `UPDATE public.company_settings
       SET quote_cc_emails = $1::text[], updated_at = now()
       WHERE id = 1
       RETURNING id`,
      [emails],
    );
    if (!updated.length) {
      await database.query(
        `INSERT INTO public.company_settings (id, quote_cc_emails, updated_at)
         VALUES (1, $1::text[], now())`,
        [emails],
      );
    }
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: { ok: true, emails },
    };
  }

  return { status: 405, headers: { Allow: "GET, POST" }, body: { ok: false, error: "method_not_allowed" } };
}

async function handleSendQuoteEmailWithCc({ headers, env, database, body, id }) {
  const caller = await verifyQuotesCaller(headers, env, "edit");
  if (!caller.ok) {
    return { status: caller.status, body: { ok: false, error: caller.error, message: caller.message } };
  }
  if (!id) {
    return { status: 400, body: { ok: false, error: "invalid", message: "חסר מזהה הצעה" } };
  }
  const key = env.RESEND_API_KEY;
  if (!key) {
    return {
      status: 503,
      body: { ok: false, error: "email_not_configured", message: "שליחת דוא״ל אינה מוגדרת במערכת (חסר RESEND_API_KEY)" },
    };
  }

  const to = String(body?.to ?? "").trim();
  if (!EMAIL_RE.test(to)) {
    return { status: 400, body: { ok: false, error: "invalid_email", message: "כתובת האימייל של הלקוח אינה תקינה" } };
  }

  await ensureCompanySettingsReady(database);
  let rawCcSource;
  if (body && Object.hasOwn(body, "cc") && body.cc !== undefined) {
    rawCcSource = body.cc;
  } else {
    const ccRows = await database.query(`SELECT quote_cc_emails FROM public.company_settings WHERE id = 1`);
    rawCcSource = ccRows[0]?.quote_cc_emails ?? [];
  }

  const ccCandidates = parseEmailCandidates(rawCcSource);
  for (const candidate of ccCandidates) {
    if (!EMAIL_RE.test(candidate)) {
      return {
        status: 400,
        body: { ok: false, error: "invalid_cc", message: `כתובת אימייל בעותק (CC) אינה תקינה: ${candidate}` },
      };
    }
  }
  const ccList = dedupeEmails(ccCandidates, to);
  if (ccList.length > 20) {
    return {
      status: 400,
      body: { ok: false, error: "too_many_cc", message: "ניתן לשלוח עד 20 נמענים בעותק (CC)" },
    };
  }

  const quoteRows = await database.query(`SELECT * FROM public.quotes WHERE id = $1`, [id]);
  const quote = quoteRows[0];
  if (!quote) {
    return { status: 404, body: { ok: false, error: "not_found", message: "ההצעה לא נמצאה" } };
  }
  const items = await database.query(
    `SELECT * FROM public.quote_items WHERE quote_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [id],
  );
  const imageRows = await database.query(
    `SELECT position, mime, data_url, caption FROM public.quote_images WHERE quote_id = $1 ORDER BY position ASC, id ASC`,
    [id],
  );
  const settingsRows = await database.query(
    `SELECT company_name, tax_id, address, phone, email, logo_url FROM public.company_settings WHERE id = 1`,
  );
  const settings = settingsRows[0] || {};
  const eventRows = quote.event_id
    ? await database.query(`SELECT address FROM public.events WHERE id = $1`, [quote.event_id])
    : [];
  const eventAddress = (quote.event_address && String(quote.event_address).trim()) || eventRows[0]?.address || null;

  let customLogo;
  if (settings.logo_url) {
    try {
      const logoRes = await fetch(settings.logo_url);
      if (logoRes.ok) {
        const contentType = logoRes.headers.get("content-type") || "";
        if (/jpe?g/i.test(contentType)) {
          const buffer = Buffer.from(await logoRes.arrayBuffer());
          const dims = jpegDimensions(buffer);
          if (dims) customLogo = { buffer, width: dims.width, height: dims.height };
        }
      }
    } catch (e) {
      console.error("[quote-email] logo fetch failed", e?.message || e);
    }
  }

  let pdf;
  try {
    pdf = buildQuotePdf({
      quote,
      items,
      settings,
      eventAddress,
      ...(customLogo ? { logo: customLogo } : {}),
      images: imageRows,
    });
  } catch (e) {
    console.error("[quote-email] pdf failed", e?.message || e);
    return { status: 500, body: { ok: false, error: "pdf_failed", message: "לא הצלחנו להפיק את קובץ ה-PDF" } };
  }

  const senderId = userIdFromAuth(headers);
  let replyTo = env.INVITE_FROM_EMAIL || settings.email || "a0525092333@gmail.com";
  if (senderId) {
    const senderRows = await database.query(`SELECT email FROM public.profiles WHERE id = $1`, [senderId]);
    if (senderRows[0]?.email) replyTo = senderRows[0].email;
  }

  const from = "נס מולטימדיה <no-reply@nsmm.work>";
  const subject = `הצעת מחיר מס׳ ${quote.quote_number} — ${settings.company_name || "נס מולטימדיה"}`;
  const message = String(body?.message ?? "").trim();
  const html = emailShell({
    heading: `הצעת מחיר מס׳ ${quote.quote_number}`,
    bodyHtml: `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.7">שלום${quote.client_name ? ` ${escapeHtml(quote.client_name)}` : ""},</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.7">מצורפת הצעת המחיר שלך כקובץ PDF.</p>
      ${message ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;white-space:pre-wrap">${escapeHtml(message)}</p>` : ""}
      <p style="margin:0;font-size:12px;line-height:1.7;color:#6b7280">הקובץ המצורף: הצעת-מחיר-${escapeHtml(quote.quote_number)}.pdf</p>
    `,
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        ...(ccList.length > 0 ? { cc: ccList } : {}),
        reply_to: replyTo,
        subject,
        html,
        attachments: [
          { filename: `הצעת-מחיר-${quote.quote_number}.pdf`, content: pdf.toString("base64") },
        ],
      }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const reason = String(data?.message || data?.error || `HTTP ${res.status}`).slice(0, 300);
      console.error("[quote-email] send failed", res.status, reason);
      return {
        status: 503,
        body: { ok: false, error: "send_failed", message: `שליחת ההצעה נכשלה: ${reason}` },
      };
    }
    try {
      const recipientsSummary = [to, ...ccList].join(", ");
      await database.query(`UPDATE public.quotes SET last_sent_at = now(), last_sent_to = $1 WHERE id = $2`, [
        recipientsSummary,
        id,
      ]);
    } catch (e) {
      console.error("[quote-email] bookkeeping failed", e?.message || e);
    }
    return { status: 200, body: { ok: true, to, cc: ccList } };
  } catch (e) {
    console.error("[quote-email] error", e?.message || e);
    return {
      status: 503,
      body: { ok: false, error: "send_failed", message: "שליחת ההצעה נכשלה — בדוק את החיבור ונסה שוב" },
    };
  }
}

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

    let result;
    try {
      const quoteSendMatch = url.pathname.match(/^\/api\/quotes\/([^/]+)\/send-email$/);
      if (url.pathname === "/api/quotes/company-settings") {
        result = await handleCompanyQuoteSettings({
          method: req.method || "GET",
          headers: req.headers,
          env: process.env,
          database: db,
          json,
        });
      } else if (url.pathname === "/api/quotes/cc-settings") {
        result = await handleQuoteCcSettings({
          method: req.method || "GET",
          headers: req.headers,
          env: process.env,
          database: db,
          json,
        });
      } else if (quoteSendMatch && req.method === "POST") {
        result = await handleSendQuoteEmailWithCc({
          headers: req.headers,
          env: process.env,
          database: db,
          body: json(),
          id: quoteSendMatch[1],
        });
      } else {
        result = await handler({
          method: req.method || "GET",
          path: url.pathname,
          url,
          headers: req.headers,
          rawBody,
          json,
          env: process.env,
          db,
        });
      }
    } catch (err) {
      console.error("[server] unhandled api error", err?.message || err);
      result = {
        status: 500,
        body: { ok: false, error: "server", message: "אירעה שגיאה בשרת — נסה שוב" },
      };
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
