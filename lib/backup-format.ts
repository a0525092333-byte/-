// Keep this block identical to the server's BACKUP FORMAT block (parity-tested).
export const BACKUP_FORMAT = "hapaqa-click-backup";
export const BACKUP_VERSION = 2;
export const BACKUP_SKIPPED = ["assets", "project_config", "audit_logs"];
export const BACKUP_COLUMNS: Record<string, string[]> = {
  profiles: ["id", "email", "full_name", "phone", "role", "is_active", "hourly_rate", "approval_status", "approved_at", "approved_by", "created_at"],
  clients: ["id", "name", "contact_name", "phone", "email", "extra_email", "company", "address", "tax_id", "notes", "created_at"],
  price_catalog: ["id", "code", "name", "description", "section", "unit", "default_price", "vat_included", "is_active", "created_at"],
  crew_members: ["id", "full_name", "phone", "role_title", "crew_roles", "hourly_rate", "is_active", "user_id", "email", "created_at"],
  equipment_items: ["id", "name", "category", "quantity_total", "quantity_out", "min_quantity", "status", "notes", "created_at"],
  company_settings: ["id", "company_name", "logo_url", "tax_id", "address", "phone", "email", "default_vat_rate", "default_terms", "default_terms_text", "default_notes", "quote_number_prefix", "updated_at"],
  events: ["id", "title", "client_id", "event_type", "event_date", "start_date", "end_date", "start_time", "end_time", "warehouse_time", "ready_time", "venue", "address", "guest_count", "status", "sales_rep_id", "sales_rep_name", "notes", "total_amount", "created_at"],
  event_days: ["id", "event_id", "day_date", "warehouse_time", "ready_time", "start_time", "end_time", "notes", "sort_order", "created_at", "updated_at"],
  event_day_crew: ["id", "event_day_id", "crew_member_id", "role_text", "notes", "created_at"],
  meetings: ["id", "title", "user_id", "starts_at", "ends_at", "location", "kind", "event_id", "notes", "done", "created_at"],
  quotes: ["id", "quote_number", "client_id", "client_name", "client_address", "venue", "subject", "event_id", "event_date", "quote_date", "print_date", "issue_date", "valid_until", "event_address", "event_contact_id", "event_contact_name", "event_contact_phone", "currency", "status", "discount_type", "discount_value", "vat_rate", "notes", "terms", "terms_text", "subtotal", "discount_amount", "total_before_vat", "vat_amount", "grand_total", "paperless_document_id", "paperless_document_number", "paperless_document_type", "paperless_url", "paperless_issued_at", "paperless_total", "paperless_status", "last_sent_at", "last_sent_to", "created_by", "created_at", "updated_at"],
  quote_sections: ["id", "quote_id", "name", "sort_order", "show_section_totals", "created_at"],
  quote_items: ["id", "quote_id", "section_id", "sort_order", "name", "description", "qty", "quantity", "unit", "unit_price", "line_total", "is_optional", "created_at"],
  shifts: ["id", "event_id", "crew_member_id", "role_title", "starts_at", "ends_at", "status", "notes", "created_at"],
  equipment_assignments: ["id", "equipment_item_id", "event_id", "quantity", "out_at", "returned_at", "notes", "created_at"],
  finance_entries: ["id", "event_id", "kind", "amount", "status", "doc_number", "issued_at", "due_at", "paid_at", "notes", "created_by", "created_at"],
  time_entries: ["id", "user_id", "work_date", "start_time", "end_time", "break_minutes", "day_type", "shift_type", "travel_km", "travel_amount", "event_id", "note", "status", "approved_by", "approved_at", "entry_source", "created_by", "manually_edited", "edited_by", "edited_at", "edit_count", "created_at", "updated_at"],
  time_entry_additions: ["id", "entry_id", "add_type", "hours", "rate", "amount", "note", "created_at"],
  paperless_documents: ["id", "quote_id", "event_id", "client_id", "doc_type", "doc_number", "doc_url", "external_id", "amount", "status", "created_by", "created_at"],
  documents: ["id", "event_id", "name", "url", "uploaded_by", "created_at"],
  crew_documents: ["id", "crew_member_id", "doc_type", "file_url", "file_name", "mime", "size", "expiry_date", "uploaded_by", "uploaded_at", "updated_at"],
  user_permissions: ["user_id", "module", "can_view", "can_edit"],
};
export const BACKUP_TABLES: string[] = Object.keys(BACKUP_COLUMNS);
const BACKUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
const BACKUP_NUMBERS = new Set("hourly_rate default_price default_vat_rate total_amount discount_value vat_rate subtotal discount_amount total_before_vat vat_amount grand_total paperless_total qty quantity unit_price line_total amount travel_km travel_amount hours rate".split(" "));
const BACKUP_INTEGERS = new Set("guest_count quantity_total quantity_out min_quantity sort_order break_minutes edit_count size".split(" "));
const BACKUP_BOOLEANS = new Set("is_active vat_included done show_section_totals is_optional manually_edited can_view can_edit".split(" "));
const BACKUP_ARRAYS = new Set(["terms", "default_terms", "crew_roles"]);
const BACKUP_DATES = new Set("event_date start_date end_date day_date quote_date print_date issue_date valid_until issued_at due_at paid_at work_date out_at expiry_date".split(" "));
const BACKUP_TIMES = new Set(["start_time", "end_time", "warehouse_time", "ready_time"]);
const BACKUP_REQUIRED: Record<string, string[]> = {
  profiles: ["email", "full_name"], clients: ["name"], price_catalog: ["name"], crew_members: ["full_name"], equipment_items: ["name"],
  events: ["title", "event_date"], event_days: ["event_id", "day_date"], event_day_crew: ["event_day_id", "crew_member_id"], meetings: ["title", "starts_at"],
  quotes: ["quote_number", "client_name"], quote_sections: ["quote_id", "name"], quote_items: ["quote_id", "name"], shifts: ["event_id", "crew_member_id", "starts_at"],
  equipment_assignments: ["equipment_item_id", "event_id", "quantity"], finance_entries: ["event_id", "kind"], time_entries: ["user_id", "work_date"],
  time_entry_additions: ["entry_id", "add_type"], paperless_documents: ["doc_type"], documents: ["event_id", "name", "url"], crew_documents: ["crew_member_id", "doc_type", "file_url"],
};
const BACKUP_NOT_NULL: Record<string, string[]> = {
  profiles: ["role", "is_active", "approval_status", "created_at"], clients: ["created_at"], price_catalog: ["default_price", "vat_included", "is_active", "created_at"],
  crew_members: ["role_title", "crew_roles", "is_active", "created_at"], equipment_items: ["category", "quantity_total", "quantity_out", "min_quantity", "status", "created_at"],
  company_settings: ["company_name", "default_vat_rate", "default_terms", "quote_number_prefix", "updated_at"], events: ["event_type", "status", "total_amount", "created_at"],
  event_days: ["sort_order", "created_at", "updated_at"], event_day_crew: ["created_at"], meetings: ["kind", "done", "created_at"],
  quotes: ["quote_date", "currency", "status", "discount_type", "discount_value", "vat_rate", "terms", "created_at", "updated_at"], quote_sections: ["sort_order", "show_section_totals", "created_at"],
  quote_items: ["sort_order", "qty", "quantity", "unit_price", "is_optional", "created_at"], shifts: ["role_title", "status", "created_at"], equipment_assignments: ["out_at", "created_at"],
  finance_entries: ["amount", "status", "created_at"], time_entries: ["break_minutes", "day_type", "shift_type", "travel_km", "travel_amount", "status", "entry_source", "manually_edited", "edit_count", "created_at", "updated_at"],
  time_entry_additions: ["hours", "rate", "amount", "created_at"], paperless_documents: ["status", "created_at"], documents: ["created_at"], crew_documents: ["uploaded_at", "updated_at"], user_permissions: ["can_view", "can_edit"],
};
const BACKUP_ENUMS: Record<string, string[]> = {
  role: ["admin", "sales", "accounting", "crew", "warehouse"],
  approval_status: ["pending", "approved", "rejected"],
  module: ["calendar", "clients", "finance", "crew", "equipment", "users", "attendance", "quotes", "office", "backup", "search"],
  day_type: ["work", "vacation", "sick", "reserve", "holiday", "absence"],
  shift_type: ["day", "evening", "night"],
  entry_source: ["clock", "manual"],
  add_type: ["overtime_125", "overtime_150", "night", "shabbat", "holiday", "oncall", "meal", "travel", "other"],
  discount_type: ["percent", "fixed", "amount"],
  "events.status": ["ממתין לסגירה", "נסגר", "ממתין לתשלום", "שולם"],
  "meetings.kind": ["פגישה", "שיחה", "מעקב", "אירוע"],
  "finance_entries.kind": ["הצעת מחיר", "חוזה", "חשבונית", "תשלום", "הוצאה"],
  "finance_entries.status": ["ממתין", "שולם", "באיחור"],
  "shifts.status": ["משובץ", "אושר", "הגיע", "לא הגיע"],
  "equipment_items.status": ["במחסן", "בשטח", "בתיקון"],
  "quotes.status": ["draft", "sent", "approved", "rejected", "cancelled"],
  "time_entries.status": ["draft", "submitted", "approved"],
  "paperless_documents.status": ["issued", "failed", "check", "unverified", "pending"],
  "crew_documents.doc_type": ["id_card", "driver_license", "height_license"],
};

function backupRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function backupCanonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(node: unknown): string {
    if (node === null || typeof node === "string" || typeof node === "boolean") return JSON.stringify(node);
    if (typeof node === "number" && Number.isFinite(node)) return JSON.stringify(node);
    if (typeof node !== "object" || node === null || seen.has(node)) throw new Error("invalid_json");
    if (!Array.isArray(node) && !backupRecord(node)) throw new Error("invalid_json");
    seen.add(node);
    const keys = Reflect.ownKeys(node);
    if (keys.some((key) => typeof key !== "string" || BACKUP_UNSAFE.has(key))) throw new Error("invalid_json");
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(node, key);
      if (!d || !("value" in d) || (!d.enumerable && !(Array.isArray(node) && key === "length"))) throw new Error("invalid_json");
    }
    let result: string;
    if (Array.isArray(node)) {
      if (keys.length !== node.length + 1 || !node.every((_, i) => Object.hasOwn(node, i))) throw new Error("invalid_json");
      result = "[" + Array.from(node, encode).join(",") + "]";
    } else {
      const record = node as Record<string, unknown>;
      result = "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + encode(record[key])).join(",") + "}";
    }
    seen.delete(node);
    return result;
  }
  return encode(value);
}

export async function backupChecksum(data: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(backupCanonicalJson(data));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function backupValueValid(table: string, column: string, value: unknown): boolean {
  if (column === "id" && table === "company_settings") return value === 1;
  if (value === null) return !(BACKUP_REQUIRED[table] || []).includes(column) && !(BACKUP_NOT_NULL[table] || []).includes(column);
  if (column === "id" || column.endsWith("_id") && !["external_id", "paperless_document_id", "tax_id"].includes(column) || ["created_by", "approved_by", "edited_by", "uploaded_by"].includes(column)) return typeof value === "string" && BACKUP_UUID.test(value);
  if (BACKUP_BOOLEANS.has(column)) return typeof value === "boolean";
  if (BACKUP_INTEGERS.has(column) || column === "quantity" && table === "equipment_assignments") return typeof value === "number" && Number.isSafeInteger(value) && value >= (column === "quantity" ? 1 : 0) && value <= (column === "size" ? Number.MAX_SAFE_INTEGER : 2147483647);
  if (BACKUP_NUMBERS.has(column)) return typeof value === "number" && Number.isFinite(value) &&
    (!(table === "time_entries" && ["travel_km", "travel_amount"].includes(column) || table === "time_entry_additions" && ["hours", "rate", "amount"].includes(column)) || value >= 0);
  if (BACKUP_ARRAYS.has(column)) return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (typeof value !== "string") return false;
  const choices = BACKUP_ENUMS[table + "." + column] || BACKUP_ENUMS[column];
  if (choices && !choices.includes(value)) return false;
  if (BACKUP_DATES.has(column)) return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (BACKUP_TIMES.has(column)) return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value);
  if (column.endsWith("_at")) return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value) && Number.isFinite(Date.parse(value));
  return true;
}

function backupDataValid(data: unknown): boolean {
  if (!backupRecord(data)) return false;
  for (const table of Object.keys(data)) {
    if (!Object.hasOwn(BACKUP_COLUMNS, table)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(data, table);
    if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) return false;
    const rows = descriptor.value;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!backupRecord(row)) return false;
      const pk = table === "user_permissions" ? ["user_id", "module"] : ["id"];
      if (pk.some((column) => !Object.hasOwn(row, column) || row[column] === null)) return false;
      if ((BACKUP_REQUIRED[table] || []).some((column) => !Object.hasOwn(row, column))) return false;
      if (Object.keys(row).some((column) => !BACKUP_COLUMNS[table].includes(column))) return false;
      for (const column of Object.keys(row)) {
        const field = Object.getOwnPropertyDescriptor(row, column);
        if (!field || !("value" in field) || !backupValueValid(table, column, field.value)) return false;
      }
      const key = JSON.stringify(pk.map((column) => row[column]));
      if (ids.has(key)) return false;
      ids.add(key);
    }
  }
  return true;
}

export function sanitizeBackupData(data: unknown): Record<string, Record<string, unknown>[]> {
  if (!backupRecord(data)) throw new Error("invalid_schema");
  const clean: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    const descriptor = Object.getOwnPropertyDescriptor(data, table);
    if (!descriptor) continue;
    if (!("value" in descriptor) || !Array.isArray(descriptor.value)) throw new Error("invalid_schema");
    clean[table] = descriptor.value.map((row: unknown) => {
      if (!backupRecord(row)) throw new Error("invalid_schema");
      const out: Record<string, unknown> = {};
      for (const column of BACKUP_COLUMNS[table]) {
        const field = Object.getOwnPropertyDescriptor(row, column);
        if (!field) continue;
        if (!("value" in field)) throw new Error("invalid_schema");
        // Validate/copy only allowlisted values; unknown secret fields are never read.
        backupCanonicalJson(field.value);
        if (!backupValueValid(table, column, field.value)) throw new Error("invalid_schema");
        out[column] = JSON.parse(backupCanonicalJson(field.value));
      }
      return out;
    });
  }
  if (!backupDataValid(clean)) throw new Error("invalid_schema");
  return clean;
}

export async function validateBackupSnapshot(snapshot: unknown): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
  const fail = (error: string) => ({ ok: false as const, error, message: error === "legacy_backup" ? "לגיבוי גרסה 1 אין בדיקת שלמות. השחזור נחסם; יש ליצור גיבוי חדש בגרסה 2." : error === "checksum_mismatch" || error === "invalid_checksum" ? "בדיקת שלמות הגיבוי נכשלה. לא בוצעו שינויים; יש לבחור קובץ תקין או ליצור גיבוי חדש." : "מבנה הגיבוי או הנתונים אינו תקין. לא בוצעו שינויים; יש לבחור גיבוי תקין בגרסה 2." });
  try {
    if (!backupRecord(snapshot) || !backupRecord(snapshot.meta)) return fail("invalid_backup");
    if (snapshot.meta.version === 1) return fail("legacy_backup");
    const meta = snapshot.meta;
    if (Object.keys(snapshot).some((key) => !["meta", "data"].includes(key)) || meta.format !== BACKUP_FORMAT || meta.version !== BACKUP_VERSION) return fail("invalid_backup");
    if (Object.keys(meta).some((key) => !["app", "format", "version", "checksum", "created_at", "kind", "created_by_email", "counts", "total_rows", "skipped"].includes(key))) return fail("invalid_metadata");
    if (typeof meta.checksum !== "string" || !/^[0-9a-f]{64}$/.test(meta.checksum)) return fail("invalid_checksum");
    if (!backupDataValid(snapshot.data)) return fail("invalid_schema");
    backupCanonicalJson(snapshot);
    if (!backupRecord(meta.counts) || !Number.isSafeInteger(meta.total_rows) || meta.total_rows < 0 || !Array.isArray(meta.skipped) || meta.skipped.some((table: unknown) => typeof table !== "string" || ![...BACKUP_TABLES, ...BACKUP_SKIPPED].includes(table))) return fail("invalid_metadata");
    if (meta.app !== undefined && typeof meta.app !== "string" || meta.created_by_email !== undefined && meta.created_by_email !== null && typeof meta.created_by_email !== "string" || meta.kind !== undefined && !["manual", "auto"].includes(meta.kind) || meta.created_at !== undefined && (typeof meta.created_at !== "string" || !Number.isFinite(Date.parse(meta.created_at)))) return fail("invalid_metadata");
    if (new Set(meta.skipped).size !== meta.skipped.length || BACKUP_SKIPPED.some((table) => !meta.skipped.includes(table)) || meta.skipped.some((table: string) => Object.hasOwn(snapshot.data, table))) return fail("invalid_metadata");
    if (Object.keys(meta.counts).length !== Object.keys(snapshot.data).length || Object.entries(snapshot.data).some(([table, rows]) => meta.counts[table] !== (rows as unknown[]).length)) return fail("invalid_metadata");
    const total = Object.values(snapshot.data).reduce((sum: number, rows) => sum + (rows as unknown[]).length, 0);
    if (total !== meta.total_rows) return fail("invalid_metadata");
    if (await backupChecksum(snapshot.data) !== meta.checksum) return fail("checksum_mismatch");
    return { ok: true };
  } catch {
    return fail("invalid_backup");
  }
}
// END BACKUP FORMAT
