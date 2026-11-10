import { getAccessToken } from "@/integrations/neon/auth";
import { notifyDataChanged } from "@/lib/data-events";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken().catch(() => null);
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(path, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok && data?.ok === true, status: res.status, data };
}

export type SaveQuoteResult =
  | { ok: true; id: string; version: number | null }
  | { ok: false; error: string; message: string; existingId?: string };

export async function saveQuote(payload: {
  quote: Record<string, unknown> & { id: string };
  sections: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
  /** Internal crew/warehouse notes — stored server-side, shown only in the event report. */
  fieldNotes?: string;
}): Promise<SaveQuoteResult> {
  try {
    const { ok, data } = await postJson("/api/quotes/save", payload);
    if (!ok) {
      return {
        ok: false,
        error: String(data?.error ?? "save_failed"),
        message: data?.message || "לא הצלחנו לשמור את ההצעה. נסה שוב.",
        existingId: data?.existingId ? String(data.existingId) : undefined,
      };
    }
    notifyDataChanged(["quotes", "events"]);
    return { ok: true, id: String(data.id), version: data.version ?? null };
  } catch {
    return { ok: false, error: "network", message: "לא הצלחנו לשמור את ההצעה — בדוק את החיבור ונסה שוב" };
  }
}

export async function restoreQuoteVersion(
  quoteId: string,
  versionId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { ok, data } = await postJson(`/api/quotes/${quoteId}/restore-version`, { versionId });
    if (!ok) return { ok: false, message: data?.message || "שחזור הגרסה נכשל" };
    notifyDataChanged(["quotes", "events"]);
    return { ok: true };
  } catch {
    return { ok: false, message: "לא הצלחנו לשחזר את הגרסה — בדוק את החיבור ונסה שוב" };
  }
}

/** Load the internal crew/warehouse notes for a quote (server-only table). */
export async function fetchQuoteFieldNotes(quoteId: string): Promise<string> {
  const res = await fetch(`/api/quotes/${quoteId}/field-notes`, { headers: await authHeaders() });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok || !data?.ok) throw new Error(data?.message || "לא הצלחנו לטעון את הערות הצוות");
  return typeof data.notes === "string" ? data.notes : "";
}
