import * as neonAuth from "@/integrations/neon/auth";

export type PaperlessDocType = "payment_request" | "invoice" | "invoice_receipt" | "receipt";

export const PAPERLESS_DOC_LABELS: Record<PaperlessDocType, string> = {
  payment_request: "חשבון עסקה / דרישת תשלום",
  invoice: "חשבונית מס",
  invoice_receipt: "חשבונית מס קבלה",
  receipt: "קבלה",
};

export type PaperlessStatusResponse = {
  ready: boolean;
  reason: string;
  message: string | null;
  keyPresent: boolean;
  configured: boolean;
  environment: string;
  baseUrl: string;
  documentPath: string;
  companyName: string | null;
};

async function buildAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  try {
    const getToken = (neonAuth as { getAccessToken?: () => Promise<string | null> }).getAccessToken;
    const token = getToken ? await getToken() : null;
    if (token) {
      headers.authorization = `Bearer ${token}`;
      return headers;
    }
  } catch {
    // fallback to /api/auth/token
  }
  try {
    const res = await fetch("/api/auth/token", { credentials: "include" });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      if (data?.token) headers.authorization = `Bearer ${data.token}`;
    }
  } catch {
    // ignore
  }
  return headers;
}

export async function fetchPaperlessStatus(): Promise<PaperlessStatusResponse> {
  const headers = await buildAuthHeaders();
  const res = await fetch("/api/paperless/status", { method: "GET", headers, credentials: "include" });
  if (!res.ok) throw new Error("לא הצלחנו לבדוק את סטטוס החיבור ל-Paperless");
  return (await res.json()) as PaperlessStatusResponse;
}

export async function savePaperlessConfig(input: {
  apiKey?: string;
  environment?: "production" | "sandbox";
  baseUrl?: string;
  documentPath?: string;
}): Promise<PaperlessStatusResponse> {
  const headers = await buildAuthHeaders();
  const res = await fetch("/api/paperless/settings", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || "שמירת הגדרות Paperless נכשלה");
  return data as PaperlessStatusResponse;
}

export async function probePaperlessConnection(): Promise<{ ok: boolean; message: string }> {
  const headers = await buildAuthHeaders();
  const res = await fetch("/api/paperless/probe", { method: "POST", headers, credentials: "include" });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, message: data?.message || "בדיקת החיבור נכשלה — ודא שמפתח ה-API הוזן ונשמר" };
  }
  if (data?.ok) {
    return { ok: true, message: "החיבור לשרת Paperless תקין ומפתח ה-API אומת בהצלחה" };
  }
  const detail = data?.results?.[0]?.message || "שרת Paperless דחה את הבקשה";
  return { ok: false, message: detail };
}

export async function issuePaperlessDocument(input: {
  quoteId: string;
  docType: PaperlessDocType;
  dueDate?: string | null;
  confirmReissue?: boolean;
}): Promise<
  | { ok: true; docNumber: string | null; docUrl: string | null; externalId: string | null }
  | { ok: false; error: string; message: string }
> {
  const headers = await buildAuthHeaders();
  const res = await fetch("/api/paperless/issue", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    return {
      ok: false,
      error: data?.error || "provider",
      message: data?.message || "הפקת המסמך ב-Paperless נכשלה",
    };
  }
  return {
    ok: true,
    docNumber: data.document?.docNumber ?? null,
    docUrl: data.document?.docUrl ?? null,
    externalId: data.document?.externalId ?? null,
  };
}
