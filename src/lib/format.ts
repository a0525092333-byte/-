const ILS = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  maximumFractionDigits: 0,
});

const NUM = new Intl.NumberFormat("he-IL");

export function money(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return ILS.format(Number.isFinite(n) ? n : 0);
}

export function num(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return NUM.format(Number.isFinite(n) ? n : 0);
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateShort(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "—";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

export function dateLong(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric" }).format(d);
}

export function weekdayShort(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "";
  return new Intl.DateTimeFormat("he-IL", { weekday: "short" }).format(d);
}

export function monthLabel(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(d);
}

export function timeShort(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.includes("T")) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    }
  }
  const m = value.match(/(\d{1,2}):(\d{2})/);
  if (!m) return "—";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** A time range kept LTR inside RTL text (prevents bidi reversal). */
export function timeRange(start: string | null | undefined, end: string | null | undefined): string {
  const a = timeShort(start);
  const b = timeShort(end);
  if (a === "—" && b === "—") return "—";
  return `\u2066${a}–${b}\u2069`;
}

/** Local calendar key (yyyy-mm-dd) for a date or timestamp. */
export function dateKey(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "—";
  return `${dateShort(d)} · ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function toDateInput(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function toTimeInput(value: string | null | undefined): string {
  if (!value) return "";
  const m = value.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

export function todayISO(): string {
  return toDateInput(new Date());
}

export function isPastDate(value: string | null | undefined): boolean {
  const d = toDate(value);
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

export function daysFromNow(value: string | null | undefined): number {
  const d = toDate(value);
  if (!d) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "לילה טוב";
  if (h < 12) return "בוקר טוב";
  if (h < 17) return "צהריים טובים";
  if (h < 21) return "אחר הצהריים טובים";
  return "ערב טוב";
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((p) => p[0]).join("");
}

/** True when two display names are the same after trimming/collapsing spaces and
 *  lower-casing. Used to suppress a redundant client line when the event title
 *  already equals the client name. */
export function sameDisplayName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (value: string | null | undefined) =>
    (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const left = norm(a);
  return Boolean(left) && left === norm(b);
}
