import { currentUser, getAccessToken, refreshSession, signOut } from "@/integrations/neon/auth";
import { dataApiToken } from "@/integrations/neon/client";

async function resolveAdminToken(): Promise<string | null> {
  let token = await getAccessToken().catch(() => null);
  if (!token && !currentUser()) {
    await refreshSession().catch(() => null);
    token = await getAccessToken().catch(() => null);
  }
  return token;
}

async function postAuthJson<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown> = {},
  useDataToken = false,
): Promise<{ ok: boolean; status: number; data: T | null; message: string; error?: string }> {
  const token = useDataToken
    ? await dataApiToken().catch(() => null)
    : await resolveAdminToken();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(path, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    const ok = res.ok && data?.ok !== false;
    const message =
      (typeof data?.message === "string" && data.message) ||
      (typeof data?.error === "string" && data.error) ||
      `שגיאת שרת (HTTP ${res.status})`;
    const error = typeof data?.error === "string" ? data.error : undefined;
    return { ok, status: res.status, data, message, error };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      message: "לא הצלחנו להגיע לשרת — בדוק את החיבור ונסה שוב",
      error: "network",
    };
  }
}

export interface ResetPasswordResult {
  ok: boolean;
  password?: string;
  emailConfigured?: boolean;
  message: string;
  error?: string;
}

export async function resetUserPassword(userId: string): Promise<ResetPasswordResult> {
  const res = await postAuthJson<{
    ok?: boolean;
    password?: string;
    email_configured?: boolean;
    message?: string;
    error?: string;
  }>("/api/admin/reset-password", { user_id: userId });

  if (!res.ok || typeof res.data?.password !== "string" || !res.data.password) {
    return {
      ok: false,
      message: res.message,
      error: res.error,
    };
  }

  await postAuthJson("/api/admin/reset-password/audit", { user_id: userId }).catch(() => null);

  return {
    ok: true,
    password: res.data.password,
    emailConfigured: Boolean(res.data.email_configured),
    message: "",
  };
}

export async function sendPasswordResetEmail(
  userId: string,
  password: string,
): Promise<{ ok: boolean; message: string; error?: string }> {
  const res = await postAuthJson<{ ok?: boolean; message?: string; error?: string }>(
    "/api/admin/reset-password/email",
    { user_id: userId, password },
  );
  if (res.ok) {
    return { ok: true, message: "" };
  }
  return { ok: false, message: res.message, error: res.error };
}

export async function sendTestEmail(): Promise<{ ok: boolean; message: string; to?: string }> {
  const res = await postAuthJson<{ ok?: boolean; to?: string; message?: string }>(
    "/api/admin/email/test",
    {},
  );
  if (res.ok) {
    return {
      ok: true,
      message: "",
      to: typeof res.data?.to === "string" ? res.data.to : undefined,
    };
  }
  return { ok: false, message: res.message };
}

export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; message: string; error?: string }> {
  const res = await postAuthJson<{ ok?: boolean; message?: string; error?: string }>(
    "/api/account/change-password",
    { currentPassword, newPassword },
    true,
  );
  if (res.ok) {
    return { ok: true, message: "" };
  }
  return { ok: false, message: res.message, error: res.error };
}

export async function signOutCurrentSession(): Promise<void> {
  try {
    await signOut();
  } catch {
    // Ignore sign-out errors before redirect
  }
}
