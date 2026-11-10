// Neon Data API client — a tiny raw-`fetch` PostgREST wrapper. NO SDK, NO Supabase
// package, NO beta deps. The Data API (PostgREST) needs a JWT on EVERY request, so
// this client always attaches one: the logged-in user's JWT when signed in (RLS sees
// `auth.user_id()`), otherwise a short-lived ANONYMOUS JWT minted by Neon Auth at
// `{VITE_NEON_AUTH_URL}/token/anonymous` (RLS role `anonymous`, public reads only).
//
// Vincen provisioning injects VITE_NEON_DATA_API_URL + VITE_NEON_AUTH_URL at build.
// Usage (supabase-shaped, on purpose — minimal mental shift):
//   import { db } from "@/integrations/neon/client";
//   const { data, error } = await db.from("posts").select("id,title").order("created_at", { ascending: false });
//   const { data, error } = await db.from("items").insert({ title }).select().single();
//   await db.from("items").update({ done: true }).eq("id", id);
//   await db.from("items").delete().eq("id", id);
import { getAccessToken } from "./auth";
import { notifyDataChanged, scopeForTable } from "@/lib/data-events";

const DATA_API_URL: string = import.meta.env.VITE_NEON_DATA_API_URL;
// Same-origin auth proxy (see server/routes.mjs) — the anonymous token is
// minted through the site's own origin, not the *.neonauth.* host directly.
const AUTH_URL = "/api/auth";

// Both are injected by Vincen provisioning at build time. During the agent's preview
// (before the real backend is wired) they're absent — we DON'T throw at import (that
// would white-screen the preview); instead queries resolve to a clean error so the
// UI shows its loading/empty/error state. The shipped build always has both set.
const configured = Boolean(DATA_API_URL && AUTH_URL);

// ── anonymous token (login-free public reads) ──────────────────────────────
// Cached until ~30s before expiry; refetched transparently on the next query.
let anon: { token: string; expMs: number } | null = null;
async function anonToken(): Promise<string> {
  if (anon && anon.expMs - 30_000 > Date.now()) return anon.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${AUTH_URL}/token/anonymous`, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Neon anonymous token failed: ${res.status}`);
    const j = (await res.json()) as { token: string; expires_at?: number };
    anon = { token: j.token, expMs: (j.expires_at ?? 0) * 1000 || Date.now() + 50 * 60_000 };
    return j.token;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("הבקשה ארכה יותר מדי. בדוק את החיבור ונסה שוב.");
    throw new Error("לא הצלחנו להתחבר לנתונים — בדוק את החיבור ונסה שוב.");
  } finally {
    clearTimeout(timer);
  }
}

/** The JWT to send to the Data API: user's session JWT if signed in, else anonymous. */
export async function dataApiToken(): Promise<string> {
  return (await getAccessToken()) ?? (await anonToken());
}

const enc = encodeURIComponent;
export type Result<T> = { data: T | null; error: { message: string; code?: string } | null };
type Method = "GET" | "POST" | "PATCH" | "DELETE";

// Chainable PostgREST query. `await` it to run (implements PromiseLike).
class Query<T = any> implements PromiseLike<Result<T>> {
  private _filters: string[] = [];
  private _select = "*";
  private _order?: string;
  private _limit?: number;
  private _offset?: number;
  private _single = false;
  private _signal?: AbortSignal;
  private _method: Method = "GET";
  private _body?: unknown;
  private _prefer: string[] = [];

  constructor(private table: string) {}

  // ── filters ──
  private f(col: string, op: string, val: unknown) { this._filters.push(`${col}=${op}.${enc(String(val))}`); return this; }
  eq(col: string, val: unknown) { return this.f(col, "eq", val); }
  neq(col: string, val: unknown) { return this.f(col, "neq", val); }
  gt(col: string, val: unknown) { return this.f(col, "gt", val); }
  gte(col: string, val: unknown) { return this.f(col, "gte", val); }
  lt(col: string, val: unknown) { return this.f(col, "lt", val); }
  lte(col: string, val: unknown) { return this.f(col, "lte", val); }
  like(col: string, val: string) { return this.f(col, "like", val); }
  ilike(col: string, val: string) { return this.f(col, "ilike", val); }
  is(col: string, val: "null" | "true" | "false") { this._filters.push(`${col}=is.${val}`); return this; }
  in(col: string, vals: unknown[]) { this._filters.push(`${col}=in.(${vals.map((v) => enc(String(v))).join(",")})`); return this; }

  // ── shaping ──
  select(cols = "*") { this._select = cols; if (this._method !== "GET") this._prefer.push("return=representation"); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this._order = `${col}.${opts?.ascending === false ? "desc" : "asc"}`; return this; }
  limit(n: number) { this._limit = n; return this; }
  offset(n: number) { this._offset = n; return this; }
  single() { this._single = true; return this; }
  signal(signal: AbortSignal) { this._signal = signal; return this; }

  // ── mutations ──
  insert(values: unknown) { this._method = "POST"; this._body = values; return this; }
  update(values: unknown) { this._method = "PATCH"; this._body = values; return this; }
  upsert(values: unknown) { this._method = "POST"; this._body = values; this._prefer.push("resolution=merge-duplicates"); return this; }
  delete() { this._method = "DELETE"; return this; }

  private buildUrl(): string {
    const parts: string[] = [];
    const wantsRows = this._method === "GET" || this._prefer.includes("return=representation");
    if (wantsRows && this._select) parts.push(`select=${this._select.split(",").map((c) => enc(c.trim())).join(",")}`);
    parts.push(...this._filters);
    if (this._order) parts.push(`order=${this._order}`);
    if (this._limit != null) parts.push(`limit=${this._limit}`);
    if (this._offset != null) parts.push(`offset=${this._offset}`);
    return `${DATA_API_URL}/${this.table}${parts.length ? `?${parts.join("&")}` : ""}`;
  }

  private async exec(): Promise<Result<T>> {
    if (!configured) return { data: null, error: { message: "Backend not configured yet (preview)." } };
  const ctrl = new AbortController();
  // 30s: a cold Neon Auth start can take several seconds; the old 8s abort
  // turned a slow start into a fake "cannot reach server" error.
  const timer = setTimeout(() => ctrl.abort(), 30000);
  if (this._signal) {
    if (this._signal.aborted) ctrl.abort();
    else this._signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
    try {
      const token = await dataApiToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: this._single ? "application/vnd.pgrst.object+json" : "application/json",
      };
      if (this._body !== undefined) headers["content-type"] = "application/json";
      if (this._prefer.length) headers["prefer"] = [...new Set(this._prefer)].join(",");
      const res = await fetch(this.buildUrl(), {
        method: this._method,
        headers,
        body: this._body !== undefined ? JSON.stringify(this._body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) return { data: null, error: { message: json?.message || res.statusText, code: json?.code } };
      if (this._method !== "GET") notifyDataChanged(scopeForTable(this.table));
      return { data: (json as T) ?? null, error: null };
    } catch (e: any) {
      const aborted = e?.name === "AbortError";
      if (aborted && this._signal?.aborted) {
        // External cancellation (component unmount / new keystroke) is a normal
        // cancellation, not an error: never surface it in the UI.
        return { data: null, error: null };
      }
      return {
        data: null,
        error: {
          message: aborted
            ? "הבקשה ארכה יותר מדי. בדוק את החיבור ונסה שוב."
            : "לא הצלחנו להתחבר לנתונים — בדוק את החיבור ונסה שוב.",
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((v: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

/**
 * Call a Postgres function exposed through the Data API, e.g. `db.rpc("is_admin")`.
 * Uses the signed-in user's JWT (so `auth.user_id()` is correct inside the function).
 * Returns `{ data, error }` — never throws.
 */
export async function rpc<T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<Result<T>> {
  if (!configured) return { data: null, error: { message: "המערכת עדיין לא מחוברת לנתונים. נסה שוב מאוחר יותר." } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const token = await dataApiToken();
    const res = await fetch(`${DATA_API_URL}/rpc/${fn}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(args ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) return { data: null, error: { message: json?.message || res.statusText, code: json?.code } };
    return { data: (json as T) ?? null, error: null };
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return {
      data: null,
      error: {
        message: aborted
          ? "הבקשה ארכה יותר מדי. בדוק את החיבור ונסה שוב."
          : "לא הצלחנו להתחבר לנתונים — בדוק את החיבור ונסה שוב.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export const db = {
  /** Start a query against a table/view, e.g. `db.from("posts")`. */
  from<T = any>(table: string) { return new Query<T>(table); },
  /** Call a Postgres function exposed through the Data API, e.g. `db.rpc("is_admin")`. */
  rpc,
};
