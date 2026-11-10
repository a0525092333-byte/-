// Neon Auth (better-auth) — raw-`fetch` client. NO SDK, NO Supabase, NO beta deps.
// Only needed by sites that have user accounts; purely-public sites never call this
// (the db client falls back to an anonymous token on its own).
//
// Cross-origin model (validated against a live Neon project):
//   • POST /sign-up/email, /sign-in/email      → sets a Secure session COOKIE
//   • GET  /token   (with the session cookie)  → { token: <short-lived Data-API JWT> }
//   • GET  /get-session                        → { user, session }
//   • POST /sign-out
// Every call uses `credentials: "include"` so the browser carries the session cookie.
// The db client (client.ts) calls getAccessToken() to attach the user's JWT to Data
// API requests, so RLS sees auth.user_id(); when signed out it returns null → anon.
//
// NOTE: better-auth requires an `Origin` header (browsers send it automatically) and
// the site's domain to be allow-listed by Vincen provisioning.

// Same-origin proxy: the browser only talks to this site's own origin, and
// server/routes.mjs forwards the auth calls to Neon Auth. This avoids browser-side
// DNS/CORS/network failures reaching the *.neonauth.* host directly.
const AUTH_URL = "/api/auth";

// `role` comes from the Neon Auth (Better Auth) admin plugin — "admin" | "user".
// Gate admin UI on it: `const { user } = useAuth(); const isAdmin = user?.role === "admin"`.
// The platform sets a user's role; the site only reads it. RLS enforces admin writes
// server-side via is_admin() (reads neon_auth.users_sync.role), so this is UI-only.
export type NeonUser = { id: string; email: string; name?: string | null; image?: string | null; role?: string | null };

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  // 30s: a cold Neon Auth start can take several seconds; the old 8s abort
  // turned a slow start into a fake "cannot reach server" error.
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    return await fetch(`${AUTH_URL}${path}`, {
      ...init,
      credentials: "include",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", accept: "application/json", ...(init.headers || {}) },
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("הבקשה ארכה יותר מדי. בדוק את החיבור ונסה שוב.");
    throw new Error("לא הצלחנו להתחבר לשירות ההתחברות — בדוק את החיבור ונסה שוב.");
  } finally {
    clearTimeout(timer);
  }
}
function jwtExpMs(token: string): number {
  try {
    const { exp } = JSON.parse(atob(token.split(".")[1]));
    return typeof exp === "number" ? exp * 1000 : Date.now() + 10 * 60_000;
  } catch {
    return Date.now() + 10 * 60_000;
  }
}

// ── in-memory session state (single source of truth, React subscribes) ──
let user: NeonUser | null = null;
let signedIn = false;
let jwt: { token: string; expMs: number } | null = null;
let tokenRetryAfter = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function currentUser(): NeonUser | null {
  return user;
}

/** Read the current session from the cookie. Call on app start + after auth changes.
 *  One short retry absorbs a transient network blip ("Failed to fetch") without
 *  surfacing an unhandled rejection to the user. */
export async function refreshSession(): Promise<NeonUser | null> {
  let response: Response | null = null;
  try {
    response = await req("/get-session");
  } catch {
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      response = await req("/get-session");
    } catch {
      response = null;
    }
  }
  if (!response) {
    // Transient network failure: keep the current in-memory session so the
    // already-rendered screen is not bounced to /login.
    return user;
  }
  try {
    const json = response.ok ? await response.json() : null;
    user = (json?.user as NeonUser) ?? null;
  } catch {
    // Keep the current user on a parse failure too.
    return user;
  }
  signedIn = !!user;
  if (!signedIn) jwt = null;
  emit();
  return user;
}

/** Data-API JWT for the signed-in user, or null when signed out (→ client uses anon). */
export async function getAccessToken(): Promise<string | null> {
  if (!signedIn) return null;
  if (jwt && jwt.expMs - 30_000 > Date.now()) return jwt.token;
  // After a network failure, wait a few seconds before asking again so a
  // transient outage cannot turn every query into a tight /token retry loop.
  if (Date.now() < tokenRetryAfter) return null;
  try {
    const r = await req("/token");
    if (!r.ok) {
      jwt = null;
      return null;
    }
    const { token } = (await r.json()) as { token: string };
    jwt = { token, expMs: jwtExpMs(token) };
    tokenRetryAfter = 0;
    return token;
  } catch {
    tokenRetryAfter = Date.now() + 5000;
    return null;
  }
}

async function errMessage(r: Response): Promise<string> {
  try {
    return (await r.json())?.message || `Request failed (${r.status})`;
  } catch {
    return `Request failed (${r.status})`;
  }
}

export async function signUp(email: string, password: string, name?: string): Promise<void> {
  const r = await req("/sign-up/email", { method: "POST", body: JSON.stringify({ email, password, name: name || email.split("@")[0] }) });
  if (!r.ok) {
    const error = new Error(await errMessage(r)) as Error & { status?: number };
    error.status = r.status;
    throw error;
  }
  jwt = null;
  await refreshSession();
}
export async function signIn(email: string, password: string): Promise<void> {
  const r = await req("/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!r.ok) {
    const error = new Error(await errMessage(r)) as Error & { status?: number };
    error.status = r.status;
    throw error;
  }
  jwt = null;
  await refreshSession();
}
/** Admin-only: set another user's password via the Neon Auth admin plugin. */
export async function adminSetUserPassword(userId: string, newPassword: string): Promise<void> {
  const r = await req("/admin/set-user-password", {
    method: "POST",
    body: JSON.stringify({ userId, newPassword }),
  });
  if (!r.ok) throw new Error(await errMessage(r));
}

export async function signOut(): Promise<void> {
  try {
    // MUST send a body: req() sets `Content-Type: application/json`, and
    // better-auth rejects an empty body as malformed JSON → 400, so the
    // server session is never invalidated and the user stays logged in
    // after refresh. `{}` is valid empty JSON and clears the session.
    await req("/sign-out", { method: "POST", body: "{}" });
  } finally {
    user = null;
    signedIn = false;
    jwt = null;
    emit();
  }
}
