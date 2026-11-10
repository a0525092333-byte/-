export type Role = "admin" | "sales" | "accounting" | "crew" | "warehouse";
export type Module = "calendar" | "clients" | "finance" | "crew" | "equipment" | "users" | "attendance" | "quotes" | "office" | "backup" | "search";

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: Role;
  is_active: boolean;
  hourly_rate: number | null;
  created_at: string;
  approval_status: "pending" | "approved" | "rejected";
  approved_at: string | null;
  approved_by: string | null;
};

export type UserPermission = {
  user_id: string;
  module: Module;
  can_view: boolean;
  can_edit: boolean;
};

export type InvitePermission = {
  module: Module;
  can_view: boolean;
  can_edit: boolean;
};

export type Invite = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  permissions: InvitePermission[];
  status: "pending" | "accepted" | "cancelled";
  invited_by: string;
  created_at: string;
  accepted_at: string | null;
  last_sent_at: string | null;
  last_send_error: string | null;
  send_count: number;
};

export type Client = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  extra_email: string | null;
  company: string | null;
  address: string | null;
  tax_id: string | null;
  notes: string | null;
  created_at: string;
};

export type ClientContact = {
  id: string;
  client_id: string;
  full_name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  sort_order: number;
  created_at: string;
};

export type EventWithBudget = EventRow & {
  quotes?: { grand_total: number | null; created_at: string }[];
};

export type EventRow = {
  id: string;
  title: string;
  client_id: string | null;
  event_type: string;
  event_date: string;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  warehouse_time: string | null;
  ready_time: string | null;
  venue: string | null;
  address: string | null;
  guest_count: number | null;
  status: string;
  sales_rep_id: string | null;
  sales_rep_name: string | null;
  notes: string | null;
  total_amount: number | null;
  created_at: string;
};

export type Meeting = {
  id: string;
  title: string;
  user_id: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  kind: string;
  event_id: string | null;
  notes: string | null;
  done: boolean;
};

export type FinanceEntry = {
  id: string;
  event_id: string;
  kind: string;
  amount: number;
  status: string;
  doc_number: string | null;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type CrewMember = {
  id: string;
  full_name: string;
  phone: string | null;
  role_title: string;
  crew_roles: string[];
  hourly_rate: number | null;
  is_active: boolean;
  user_id: string | null;
  email: string | null;
};

export type CrewDocType = "id_card" | "driver_license" | "height_license";

export type CrewDocument = {
  id: string;
  crew_member_id: string;
  doc_type: CrewDocType;
  file_url: string;
  file_name: string | null;
  mime: string | null;
  size: number | null;
  expiry_date: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  updated_at: string;
};

export type Shift = {
  id: string;
  event_id: string;
  crew_member_id: string;
  role_title: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  notes: string | null;
};

export type EquipmentItem = {
  id: string;
  name: string;
  category: string;
  quantity_total: number;
  quantity_out: number;
  min_quantity: number;
  status: string;
  notes: string | null;
};

export type DocumentRow = {
  id: string;
  event_id: string;
  name: string;
  url: string;
  uploaded_by: string | null;
  created_at: string;
};

export type EquipmentAssignment = {
  id: string;
  equipment_item_id: string;
  event_id: string;
  quantity: number;
  out_at: string;
  returned_at: string | null;
  notes: string | null;
};

export type DayType = "work" | "vacation" | "sick" | "reserve" | "holiday" | "absence";
export type ShiftType = "day" | "evening" | "night";
export type EntryStatus = "draft" | "submitted" | "approved";
export type AdditionType =
  | "overtime_125"
  | "overtime_150"
  | "night"
  | "shabbat"
  | "holiday"
  | "oncall"
  | "meal"
  | "travel"
  | "other";

export type TimeEntry = {
  id: string;
  user_id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  day_type: DayType;
  shift_type: ShiftType;
  travel_km: number;
  travel_amount: number;
  event_id: string | null;
  note: string | null;
  status: EntryStatus;
  approved_by: string | null;
  approved_at: string | null;
  entry_source: "clock" | "manual";
  created_by: string | null;
  manually_edited: boolean;
  edited_by: string | null;
  edited_at: string | null;
  edit_count: number;
  created_at: string;
  updated_at: string;
};

export type TimeEntryAddition = {
  id: string;
  entry_id: string;
  add_type: AdditionType;
  hours: number;
  rate: number;
  amount: number;
  note: string | null;
  created_at: string;
};

export type QuoteStatus = "draft" | "sent" | "approved" | "rejected" | "cancelled";
export type DiscountType = "percent" | "fixed" | "amount";

export type Quote = {
  id: string;
  quote_number: string;
  client_id: string | null;
  client_name: string;
  client_address: string | null;
  venue: string | null;
  subject: string | null;
  event_id: string | null;
  event_date: string | null;
  quote_date: string;
  print_date: string | null;
  issue_date: string | null;
  valid_until: string | null;
  event_address?: string | null;
  event_contact_id?: string | null;
  event_contact_name?: string | null;
  event_contact_phone?: string | null;
  currency: string;
  status: QuoteStatus;
  discount_type: DiscountType;
  discount_value: number;
  vat_rate: number;
  notes: string | null;
  terms: string[];
  terms_text: string | null;
  subtotal: number | null;
  discount_amount: number | null;
  total_before_vat: number | null;
  vat_amount: number | null;
  grand_total: number | null;
  paperless_document_id: string | null;
  paperless_document_number: string | null;
  paperless_document_type: string | null;
  paperless_url: string | null;
  paperless_issued_at: string | null;
  paperless_total: number | null;
  paperless_status: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type QuoteSection = {
  id: string;
  quote_id: string;
  name: string;
  sort_order: number;
  show_section_totals: boolean;
  created_at: string;
};

export type QuoteItem = {
  id: string;
  quote_id: string;
  section_id: string | null;
  sort_order: number;
  name: string;
  description: string | null;
  qty: number;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number | null;
  is_optional: boolean;
  created_at: string;
};

export type QuoteImage = {
  id: number;
  quote_id: string;
  position: number;
  mime: string;
  data_url: string;
  caption: string | null;
  created_at: string;
};

export type QuoteVersionSnapshot = {
  quote: Quote;
  sections: QuoteSection[];
  items: QuoteItem[];
};

export type QuoteVersion = {
  id: string;
  quote_id: string;
  event_id: string | null;
  version_number: number;
  snapshot: QuoteVersionSnapshot;
  total: number | null;
  label: string | null;
  created_by: string | null;
  created_at: string;
};

export type PriceCatalogItem = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  section: string | null;
  unit: string | null;
  default_price: number;
  vat_included: boolean;
  is_active: boolean;
  created_at: string;
};

export type CompanySettings = {
  id: number;
  company_name: string;
  logo_url: string | null;
  tax_id: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  default_vat_rate: number;
  default_terms: string[];
  default_terms_text: string | null;
  default_notes: string | null;
  quote_number_prefix: string | null;
  paperless_environment: string;
  paperless_base_url: string;
  paperless_auth_style: string;
  paperless_document_path: string;
  backup_drive_enabled: boolean;
  backup_drive_url: string | null;
  backup_drive_folder: string | null;
  updated_at: string;
};

export type BackupRow = {
  id: string;
  created_at: string;
  kind: "manual" | "auto";
  created_by: string | null;
  created_by_email: string | null;
  counts: Record<string, number>;
  total_rows: number;
  size_bytes: number;
  note: string | null;
  drive_status: string | null;
  drive_url: string | null;
  drive_file_id: string | null;
  drive_error: string | null;
  drive_sent_at: string | null;
};

export type PaperlessDocType = "invoice" | "invoice_receipt" | "payment_request" | "receipt";
export type PaperlessDocumentStatus = "issued" | "failed" | "check" | "unverified" | "pending";

export type PaperlessDocument = {
  id: string;
  quote_id: string | null;
  event_id: string | null;
  client_id: string | null;
  doc_type: string;
  doc_number: string | null;
  doc_url: string | null;
  external_id: string | null;
  amount: number | null;
  status: PaperlessDocumentStatus;
  raw_response: unknown;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
};

export type EventDay = {
  id: string;
  event_id: string;
  day_date: string;
  warehouse_time: string | null;
  ready_time: string | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type EventDayCrew = {
  id: string;
  event_day_id: string;
  crew_member_id: string;
  role_text: string | null;
  notes: string | null;
  created_at: string;
};
