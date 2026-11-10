/**
 * App-wide "data changed" signal. Every successful write goes through the
 * shared data client (or one of the server-route helpers), which calls
 * notifyDataChanged(scope). Screens that need live data (office mode) subscribe
 * and refetch in place — no page reload, no lost UI state.
 */

export type DataScope =
  | "events"
  | "crew"
  | "clients"
  | "quotes"
  | "equipment"
  | "attendance"
  | "finance"
  | "meetings"
  | "documents"
  | "catalog"
  | "users"
  | "all";

const CHANNEL = "nes-data";
const DATA_EVENT = "nes:data-changed";
const EDITING_EVENT = "nes:editing-changed";

const editing = new Set<string>();

export function notifyDataChanged(scope: DataScope | DataScope[] = "all") {
  const scopes = Array.isArray(scope) ? scope : [scope];
  const detail = { scopes };
  try {
    window.dispatchEvent(new CustomEvent(DATA_EVENT, { detail }));
  } catch {
    /* window unavailable */
  }
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(detail);
    channel.close();
  } catch {
    /* BroadcastChannel unavailable */
  }
}

export function subscribeDataChanged(handler: (scopes: DataScope[]) => void): () => void {
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<{ scopes?: DataScope[] }>).detail;
    handler(detail?.scopes?.length ? detail.scopes : ["all"]);
  };
  window.addEventListener(DATA_EVENT, onLocal);
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ scopes?: DataScope[] }>) => {
      handler(event.data?.scopes?.length ? event.data.scopes : ["all"]);
    };
  } catch {
    channel = null;
  }
  return () => {
    window.removeEventListener(DATA_EVENT, onLocal);
    channel?.close();
  };
}

/** Mark a form/dialog with unsaved state so background refreshes are queued. */
export function setEditingActive(id: string, active: boolean) {
  if (active) editing.add(id);
  else editing.delete(id);
  try {
    window.dispatchEvent(new CustomEvent(EDITING_EVENT, { detail: { active: editing.size > 0 } }));
  } catch {
    /* window unavailable */
  }
}

export function isEditingActive(): boolean {
  return editing.size > 0;
}

export function subscribeEditing(handler: (active: boolean) => void): () => void {
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<{ active?: boolean }>).detail;
    handler(Boolean(detail?.active));
  };
  window.addEventListener(EDITING_EVENT, onLocal);
  return () => window.removeEventListener(EDITING_EVENT, onLocal);
}

/** Map a table name to the scope its writes affect. */
export function scopeForTable(table: string): DataScope {
  if (table === "events" || table === "event_days" || table === "event_day_crew") return "events";
  if (table === "shifts" || table === "crew_members" || table === "crew_documents") return "crew";
  if (table === "clients" || table === "client_contacts") return "clients";
  if (table === "quotes" || table === "quote_items" || table === "quote_sections" || table === "quote_versions") return "quotes";
  if (table === "equipment_items" || table === "equipment_assignments") return "equipment";
  if (table === "time_entries" || table === "time_entry_additions") return "attendance";
  if (table === "finance_entries") return "finance";
  if (table === "meetings") return "meetings";
  if (table === "documents") return "documents";
  if (table === "price_catalog") return "catalog";
  if (table === "profiles" || table === "user_permissions" || table === "invites") return "users";
  return "all";
}
