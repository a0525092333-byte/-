import type { Module, Role, UserPermission } from "./types";

export const MODULES: { key: Module; label: string; description: string }[] = [
  { key: "calendar", label: "יומן", description: "פגישות, מעקבים ואירועים" },
  { key: "clients", label: "לקוחות ואירועים", description: "כרטיסי לקוח וניהול אירועים" },
  { key: "finance", label: "כספים", description: "הצעות מחיר, חשבוניות ותשלומים" },
  { key: "crew", label: "צוות בשטח", description: "אנשי צוות ומשמרות" },
  { key: "equipment", label: "ציוד ומחסן", description: "קטלוג, שיבוץ והחזרות" },
  { key: "users", label: "ניהול משתמשים", description: "תפקידים והרשאות" },
  { key: "attendance", label: "שעון נוכחות", description: "דיווח שעות, תוספות ונסיעות" },
  { key: "quotes", label: "הצעות מחיר", description: "בניית הצעות מחיר, מחירון והדפסה" },
  { key: "office", label: "מצב משרד", description: "יומן שבועי ושיבוץ צוות מול האירועים" },
  { key: "backup", label: "גיבוי ושחזור", description: "ייצוא, שחזור וגיבוי אוטומטי" },
  { key: "search", label: "חיפוש חכם", description: "חיפוש גלובלי בכל סוגי התוכן" },
];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "מנהל",
  sales: "איש מכירות",
  accounting: "הנהלת חשבונות",
  crew: "צוות בשטח",
  warehouse: "מחסנאי",
};

export const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "admin", label: "מנהל" },
  { value: "sales", label: "איש מכירות" },
  { value: "accounting", label: "הנהלת חשבונות" },
  { value: "crew", label: "צוות בשטח" },
  { value: "warehouse", label: "מחסנאי" },
];

type Preset = Record<Module, { view: boolean; edit: boolean }>;

export const ROLE_PRESETS: Record<Role, Preset> = {
  admin: {
    calendar: { view: true, edit: true },
    clients: { view: true, edit: true },
    finance: { view: true, edit: true },
    crew: { view: true, edit: true },
    equipment: { view: true, edit: true },
    users: { view: true, edit: true },
    attendance: { view: true, edit: true },
    quotes: { view: true, edit: true },
    office: { view: true, edit: true },
    backup: { view: true, edit: true },
    search: { view: true, edit: true },
  },
  sales: {
    calendar: { view: true, edit: true },
    clients: { view: true, edit: true },
    finance: { view: false, edit: false },
    crew: { view: true, edit: false },
    equipment: { view: false, edit: false },
    users: { view: false, edit: false },
    attendance: { view: false, edit: false },
    quotes: { view: true, edit: true },
    office: { view: false, edit: false },
    backup: { view: false, edit: false },
    search: { view: false, edit: false },
  },
  accounting: {
    calendar: { view: true, edit: false },
    clients: { view: true, edit: false },
    finance: { view: true, edit: true },
    crew: { view: false, edit: false },
    equipment: { view: false, edit: false },
    users: { view: false, edit: false },
    attendance: { view: false, edit: false },
    quotes: { view: true, edit: false },
    office: { view: false, edit: false },
    backup: { view: false, edit: false },
    search: { view: false, edit: false },
  },
  crew: {
    calendar: { view: true, edit: false },
    clients: { view: false, edit: false },
    finance: { view: false, edit: false },
    crew: { view: true, edit: false },
    equipment: { view: true, edit: false },
    users: { view: false, edit: false },
    attendance: { view: false, edit: false },
    quotes: { view: false, edit: false },
    office: { view: false, edit: false },
    backup: { view: false, edit: false },
    search: { view: false, edit: false },
  },
  warehouse: {
    calendar: { view: true, edit: false },
    clients: { view: false, edit: false },
    finance: { view: false, edit: false },
    crew: { view: false, edit: false },
    equipment: { view: true, edit: false },
    users: { view: false, edit: false },
    attendance: { view: false, edit: false },
    quotes: { view: false, edit: false },
    office: { view: false, edit: false },
    backup: { view: false, edit: false },
    search: { view: false, edit: false },
  },
};

export const SUPER_ADMIN_EMAIL = "a0525092333@gmail.com";

/** Shown when anyone but the account owner tries to delete an event. */
export const EVENT_DELETE_OWNER_ONLY_MESSAGE = "רק בעל החשבון יכול למחוק אירועים";

/** The owner account keeps unlimited access so the app can never lock itself out. */
export function isSuperAdmin(email: string | null | undefined): boolean {
  return (email ?? "").trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}

export function can(
  perms: UserPermission[] | undefined,
  isSuperAdmin: boolean,
  module: Module,
  action: "view" | "edit" = "view",
): boolean {
  if (isSuperAdmin) return true;
  const row = (perms ?? []).find((p) => p.module === module);
  if (!row) return false;
  return action === "edit" ? !!row.can_edit : !!row.can_view || !!row.can_edit;
}

export function canView(
  perms: UserPermission[] | undefined,
  isSuperAdmin: boolean,
  module: Module,
): boolean {
  return can(perms, isSuperAdmin, module, "view");
}

export function canEdit(
  perms: UserPermission[] | undefined,
  isSuperAdmin: boolean,
  module: Module,
): boolean {
  return can(perms, isSuperAdmin, module, "edit");
}

const PATH_MODULES: { prefix: string; module: Module }[] = [
  { prefix: "/calendar", module: "calendar" },
  { prefix: "/office", module: "office" },
  { prefix: "/clients", module: "clients" },
  { prefix: "/finance", module: "finance" },
  { prefix: "/quotes", module: "quotes" },
  { prefix: "/crew", module: "crew" },
  { prefix: "/equipment", module: "equipment" },
  { prefix: "/attendance-report", module: "attendance" },
  { prefix: "/attendance", module: "attendance" },
  { prefix: "/my-documents", module: "attendance" },
  { prefix: "/users", module: "users" },
  { prefix: "/backup", module: "backup" },
  { prefix: "/search", module: "search" },
];

/** Route guard: a module URL is allowed only when the matrix grants view. */
export function canAccessPath(
  pathname: string,
  can: (module: Module, action?: "view" | "edit") => boolean,
): boolean {
  if (pathname === "/" || pathname === "/settings" || pathname.startsWith("/settings/")) return true;
  if (pathname === "/events" || pathname.startsWith("/events/")) {
    return (["clients", "calendar", "crew", "finance", "equipment"] as Module[]).some((m) => can(m, "view"));
  }
  const match = PATH_MODULES.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );
  return match ? can(match.module, "view") : true;
}


const HOME_PRIORITY: { path: string; module: Module }[] = [
  { path: "/calendar", module: "calendar" },
  { path: "/attendance", module: "attendance" },
  { path: "/clients", module: "clients" },
  { path: "/quotes", module: "quotes" },
  { path: "/finance", module: "finance" },
  { path: "/crew", module: "crew" },
  { path: "/equipment", module: "equipment" },
  { path: "/office", module: "office" },
  { path: "/search", module: "search" },
  { path: "/backup", module: "backup" },
  { path: "/users", module: "users" },
];

/** First module the user may view; "/" renders the no-permission screen. */
export function firstAllowedPath(
  can: (module: Module, action?: "view" | "edit") => boolean,
): string {
  const hit = HOME_PRIORITY.find((entry) => can(entry.module, "view"));
  return hit ? hit.path : "/";
}

export function presetRows(role: Role): { module: Module; can_view: boolean; can_edit: boolean }[] {
  const preset = ROLE_PRESETS[role] ?? ROLE_PRESETS.sales;
  return MODULES.map((m) => ({
    module: m.key,
    can_view: preset[m.key].view,
    can_edit: preset[m.key].edit,
  }));
}
