import { getAccessToken } from "@/integrations/neon/auth";

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmailInput(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function uniqueEmails(list: string[], excludeEmail?: string): string[] {
  const excluded = excludeEmail?.trim().toLowerCase() || "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const clean = item.trim().toLowerCase();
    if (!clean || (excluded && clean === excluded) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export async function fetchQuoteCcEmails(): Promise<string[]> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch("/api/quotes/cc-settings", {
      method: "GET",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return Array.isArray(data?.emails) ? uniqueEmails(data.emails.map(String)) : [];
  } catch {
    return [];
  }
}

export async function saveQuoteCcEmails(
  emails: string[],
): Promise<{ ok: true; emails: string[] } | { ok: false; message: string }> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch("/api/quotes/cc-settings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ emails: uniqueEmails(emails) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return { ok: false, message: data?.message || "לא הצלחנו לשמור את רשימת הנמענים הקבועים" };
    }
    return {
      ok: true,
      emails: Array.isArray(data.emails) ? uniqueEmails(data.emails.map(String)) : uniqueEmails(emails),
    };
  } catch {
    return { ok: false, message: "לא הצלחנו לשמור את רשימת הנמענים הקבועים — בדוק את החיבור ונסה שוב" };
  }
}

export async function sendQuoteEmail(
  quoteId: string,
  to: string,
  message: string,
  cc?: string[],
): Promise<{ ok: true; to: string; cc: string[] } | { ok: false; message: string }> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch(`/api/quotes/${quoteId}/send-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        to,
        message,
        ...(cc !== undefined ? { cc } : {}),
      }),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      return { ok: false, message: data?.message || "שליחת ההצעה נכשלה" };
    }
    return {
      ok: true,
      to: data.to,
      cc: Array.isArray(data.cc) ? data.cc : [],
    };
  } catch {
    return { ok: false, message: "לא הצלחנו לשלוח את ההצעה — בדוק את החיבור ונסה שוב" };
  }
}
