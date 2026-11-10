import type { DiscountType, QuoteItem, QuoteStatus } from "./types";

export const DEFAULT_TERMS = [
  "חתימה על מסמך זה מהווה אישור על ביצוע העבודה.",
  "ההצעה אינה כוללת בדיקה ואישור מהנדס חשמל וקונסטרוקציה.",
  "המזמין מתחייב לדאוג לגישה נוחה למקום האירוע.",
  "באחריות הלקוח לדאוג לשמירה על הציוד בשטח, כולל נזק או אובדן.",
  "ההצעה אינה כוללת במה, אלא אם צוין במפורש.",
];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "טיוטה",
  sent: "נשלחה",
  approved: "מאושרת",
  rejected: "נדחתה",
  cancelled: "בוטלה",
};

export const QUOTE_STATUS_OPTIONS: { value: QuoteStatus; label: string }[] = [
  { value: "draft", label: "טיוטה" },
  { value: "sent", label: "נשלחה" },
  { value: "approved", label: "מאושרת" },
  { value: "rejected", label: "נדחתה" },
  { value: "cancelled", label: "בוטלה" },
];

export function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function lineTotal(item: {
  qty?: number | string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
}): number {
  const qty = Number(item.quantity ?? item.qty ?? 0);
  return Math.round(qty * Number(item.unit_price ?? 0) * 100) / 100;
}

export function computeQuoteTotals(
  items: { qty?: number | string | null; quantity?: number | string | null; unit_price?: number | string | null }[],
  discountType: DiscountType,
  discountValue: number,
  vatRate: number,
) {
  const subtotal = round2(items.reduce((sum, item) => sum + lineTotal(item), 0));
  const discountAmount = round2(
    discountType === "percent" ? subtotal * ((Number(discountValue) || 0) / 100) : Number(discountValue) || 0,
  );
  const afterDiscount = round2(Math.max(0, subtotal - discountAmount));
  const vatAmount = round2(afterDiscount * ((Number(vatRate) || 0) / 100));
  const grandTotal = Math.round(afterDiscount + vatAmount);
  return { subtotal, discountAmount, afterDiscount, vatAmount, grandTotal };
}

export function money2(value: number | string | null | undefined): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

export function money0(value: number | string | null | undefined): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

export function nextQuoteNumber(existing: string[], prefix = ""): string {
  const numbers = existing
    .map((value) => Number(String(value ?? "").replace(/[^\d]/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  const max = numbers.length ? Math.max(...numbers) : 2400;
  return `${prefix}${max + 1}`;
}

export function weekdayLetter(date: string | null | undefined): string {
  if (!date) return "";
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", { weekday: "narrow" }).format(parsed);
}

export function splitLines(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function quoteTermsText(quote: { terms_text?: string | null; terms?: string[] | null }): string {
  if (quote.terms_text && quote.terms_text.trim()) return quote.terms_text;
  return (quote.terms ?? []).join("\n");
}

export function quoteIssueDate(quote: { issue_date?: string | null; quote_date?: string | null }): string {
  return quote.issue_date ?? quote.quote_date ?? "";
}

export function quoteItemQuantity(item: { quantity?: number | string | null; qty?: number | string | null }): number {
  return Number(item.quantity ?? item.qty ?? 0);
}

export function quoteItemLineTotal(item: {
  line_total?: number | string | null;
  quantity?: number | string | null;
  qty?: number | string | null;
  unit_price?: number | string | null;
}): number {
  if (item.line_total != null) return Number(item.line_total);
  return lineTotal(item);
}

export function dateShortYY(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${String(parsed.getDate()).padStart(2, "0")}/${String(parsed.getMonth() + 1).padStart(2, "0")}/${String(parsed.getFullYear()).slice(-2)}`;
}
