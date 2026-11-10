import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { currentUser, subscribe, getAccessToken } from "@/integrations/neon/auth";
import { db } from "@/integrations/neon/client";
import { accountingCopy as copy } from "@/content/event-accounting";
import type { FinanceEntry, PaperlessDocument } from "@/lib/types";

export type AccountingReference = {
  id: string; event_id: string; doc_type: string; doc_number: string;
  document_date: string | null; notes: string | null; doc_url: string | null;
  created_by: string; created_at: string; updated_at: string;
};
export type AccountingSummary = Pick<AccountingReference, "event_id" | "doc_type" | "doc_number">;
export type EventAccounting = {
  event: { id: string; title: string; total_amount: number | null };
  finance: FinanceEntry[];
  paperless: Omit<PaperlessDocument, "raw_response" | "error_message">[];
  references: AccountingReference[];
  files?: AccountingFile[];
  scanAvailable?: boolean;
};

export type AccountingFile = {
  id: string; event_id: string; file_name: string; mime: string; size_bytes: number; uploaded_at: string;
  scan_status: string; scan_result: Partial<AccountingFile> & { warnings?: string[] } | null;
  doc_type: string; doc_number: string | null; document_date: string | null;
  supplier: string | null; customer: string | null; amount: number | null; vat: number | null;
  notes: string | null; confirmed_at: string | null; reference_id: string | null;
};

export async function accountingRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw Object.assign(new Error(copy.accessError), { status: 401, code: "unauthorized" });
  const response = await fetch(path, { ...init, cache: "no-store", headers: { "content-type": "application/json", ...init.headers, authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) throw Object.assign(new Error(copy.loadError), { status: response.status, code: data?.error ?? "unavailable" });
  return data as T;
}

export function useAccountingAccess() {
  const user = useSyncExternalStore(subscribe, currentUser, currentUser);
  const query = useQuery({
    queryKey: ["event-accounting-access", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      return await accountingRequest<{ canView: boolean; canEdit: boolean }>("/api/event-accounting/access");
    },
    staleTime: 20_000,
    refetchInterval: (query) => query.state.status === "error" ? false : 20_000,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  return { ...query, userId: user?.id, canView: !!user && !query.isError && query.data?.canView === true, canEdit: !!user && !query.isError && query.data?.canView === true && query.data?.canEdit === true };
}

export function useAccountingSummaries(eventIds: string[], enabled: boolean, userId?: string) {
  const ids = [...new Set(eventIds)].sort();
  return useQuery({
    queryKey: ["event-accounting", userId, "summary", ids],
    enabled: enabled && !!userId && ids.length > 0,
    queryFn: async () => {
      const result: AccountingSummary[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const { data, error } = await db.rpc<AccountingSummary[]>("event_accounting_summary", { p_event_ids: ids.slice(i, i + 500) });
        // No accounting access is not an error for the screen: show nothing.
        if (error && (error.code === "42501" || /access denied/i.test(error.message ?? ""))) return [];
        if (error) throw new Error(copy.loadError);
        result.push(...(data ?? []));
      }
      return result;
    },
    retry: 0,
  });
}

export function useEventAccounting(eventId: string, enabled: boolean, userId?: string) {
  return useQuery({
    queryKey: ["event-accounting", userId, "event", eventId],
    enabled: enabled && !!userId && !!eventId,
    queryFn: async ({ signal }) => {
      const token = await getAccessToken();
      if (!token) throw Object.assign(new Error(copy.accessError), { status: 401 });
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/accounting`, { headers: { authorization: `Bearer ${token}` }, signal, cache: "no-store" });
      if (!response.ok) throw Object.assign(new Error(copy.loadError), { status: response.status });
      const data = await response.json();
      if (!data?.ok || !data.event) throw new Error(copy.loadError);
      return data as EventAccounting;
    },
    retry: 0,
  });
}

export function accountingSummaryText(rows: AccountingSummary[]) {
  return rows.length ? [...new Set(rows.map((row) => `${copy.docTypes[row.doc_type] ?? row.doc_type} - ${row.doc_number}`))].join(" · ") : copy.empty;
}

export function safeAccountingLink(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
