/**
 * Heuristic parser for old quotation PDFs. Everything that can be tuned lives
 * here so a real sample can be handled by editing one file.
 *
 * The parser is deliberately dependency-free (no imports) so it can be unit
 * tested with plain Node as well as bundled by Vite.
 */

export type ExtractedRun = { text: string; x: number; width: number };
export type ExtractedLine = { page?: number; y?: number; text: string; runs?: ExtractedRun[] };

export type ParsedItem = {
  name: string;
  description: string | null;
  qty: number;
  quantity: number;
  unit: string | null;
  unit_price: number;
  unitPrice: number;
  line_total: number;
  lineTotal: number;
  sectionIndex: number;
};

export type ParsedSection = { name: string; sort_order: number };

export type ParsedQuote = {
  clientName: string | null;
  clientPhone: string | null;
  venue: string | null;
  eventDate: string | null;
  quoteDate: string | null;
  quoteNumber: string | null;
  guestCount: number | null;
  address: string | null;
  clientAddress: string | null;
  eventAddress: string | null;
  items: ParsedItem[];
  sections: ParsedSection[];
  discountType: "percent" | "amount";
  discountValue: number;
  discountAmount: number;
  subtotal: number;
  totalBeforeVat: number;
  vatRate: number;
  vatAmount: number;
  grandTotal: number;
  notes: string | null;
  terms: string | null;
  warnings: string[];
  rawText: string;
};

const NIQQUD = /[\u0591-\u05C7]/g;

function clean(value: string): string {
  return String(value ?? "")
    .replace(NIQQUD, "")
    .replace(/ð/g, "נ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGershayim(value: string): string {
  return value.replace(/ð/g, "נ").replace(/\s*(["״׳'])\s*/g, "$1");
}

function coalesceRuns(runs: ExtractedRun[]): ExtractedRun[] {
  const out: ExtractedRun[] = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = prev.x - (run.x + run.width);
      if (gap < 6) {
        const right = prev.x + prev.width;
        prev.text = normalizeGershayim(prev.text + run.text);
        prev.x = run.x;
        prev.width = Math.max(prev.width, right - run.x);
        continue;
      }
    }
    out.push({ ...run, text: normalizeGershayim(run.text) });
  }
  return out;
}

function parseNumber(value: string): number {
  const text = clean(value)
    .replace(/₪/g, "")
    .replace(/ש["״']?ח/g, "")
    .replace(/,/g, "")
    .replace(/\s/g, "");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

const HEBREW_MONTHS: Record<string, number> = {
  ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6,
  יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12,
};

function isoDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDate(value: string): string | null {
  const text = clean(value).replace(/\s*([./-])\s*/g, "$1");
  let match = text.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (match) return isoDate(match[1], match[2], match[3]);

  match = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (match) {
    const currentYear = new Date().getFullYear();
    const candidates: string[] = [];
    const yearA = match[3].length === 2 ? `20${match[3]}` : match[3];
    const ddmm = isoDate(yearA, match[2], match[1]);
    if (ddmm) candidates.push(ddmm);
    if (match[1].length <= 2) {
      const yymm = isoDate(`20${match[1]}`, match[2], match[3]);
      if (yymm) candidates.push(yymm);
    }
    if (candidates.length) {
      candidates.sort(
        (a, b) =>
          Math.abs(Number(a.slice(0, 4)) - currentYear) -
          Math.abs(Number(b.slice(0, 4)) - currentYear),
      );
      return candidates[0];
    }
  }

  match = text.match(/(\d{1,2})\s+ב?([א-ת]+)\s+(\d{4})/);
  if (match) {
    const month = HEBREW_MONTHS[match[2]];
    if (month) return isoDate(match[3], String(month), match[1]);
  }
  return null;
}

function afterLabel(line: string, label: string): string | null {
  const index = line.indexOf(label);
  if (index === -1) return null;
  return line.slice(index + label.length).replace(/^[\s:：\-–—]+/, "").trim();
}

function firstValue(lines: string[], labels: string[]): string | null {
  for (const line of lines) {
    for (const label of labels) {
      if (!line.includes(label)) continue;
      const rest = afterLabel(line, label);
      if (rest) return rest;
    }
  }
  return null;
}

function firstDate(lines: string[], labels: string[], exclude: string[] = []): string | null {
  for (const line of lines) {
    if (exclude.some((word) => line.includes(word))) continue;
    for (const label of labels) {
      if (!line.includes(label)) continue;
      const rest = afterLabel(line, label);
      const date = rest ? parseDate(rest) : null;
      if (date) return date;
    }
  }
  return null;
}

function validVenue(value: string | null | undefined): value is string {
  if (!value) return false;
  const text = value.trim();
  if (!text || text === "עבור" || text.startsWith("עבור")) return false;
  if (/נייד|טלפון|פקס|איש קשר|דוא"ל|@/.test(text)) return false;
  if (/\d[\d\s\-]{6,}/.test(text)) return false;
  return true;
}

function fixClientName(value: string): string {
  return value
    .replace(/([א-ת]{2,})\s+([א-ת])\s+([א-ת])(?=\s|$)/g, "$1$2$3")
    .replace(/^([א-ת])\s+([א-ת])\s+([א-ת]{2,})\s+/, "$1$2$3 ")
    .replace(/^([א-ת])\s+([א-ת]{2,})\s+/, "$1$2 ")
    .replace(/\s+/g, " ")
    .trim();
}

function fixBrackets(value: string): string {
  let text = value.trim();
  text = text.replace(/\)\s*([^()]*?)\s*\(/g, "($1)");
  if (text.startsWith(")") && text.endsWith("(")) return `(${text.slice(1, -1).trim()})`;
  return text;
}

function fixPunctuationSpacing(value: string): string {
  return value.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}

function fixHebrewDigitSpacing(value: string): string {
  return value.replace(/([\u0590-\u05FF])(\d)/g, "$1 $2");
}

function stripBullets(value: string): string {
  return value
    .replace(/[•·]/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/^[\s\-–—]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fixLatinPrefix(value: string): string {
  const match = value.match(/^([A-Za-z0-9]+)\s*(.+)$/);
  if (match && /[\u0590-\u05FF]/.test(match[2])) return `${match[2]} ${match[1]}`;
  return value;
}

function joinRunsRtl(runs: { text: string; x: number; width: number }[]): string {
  const sorted = [...runs].sort((a, b) => b.x - a.x);
  let out = "";
  let prev: { text: string; x: number; width: number } | null = null;
  for (const run of sorted) {
    if (prev) {
      const gap = prev.x - (run.x + run.width);
      const charWidth = prev.text.length ? prev.width / prev.text.length : 0;
      const spaceWidth = Math.max(charWidth, 1);
      if (gap > spaceWidth * 0.25) out += " ";
    }
    out += run.text;
    prev = run;
  }
  return out.replace(/\s+/g, " ").trim();
}

function textFromRuns(line: ExtractedLine): string {
  const runs = line.runs ?? [];
  if (!runs.length) return line.text;
  return joinRunsRtl(runs);
}

function numericGroups(line: ExtractedLine): number[] {
  const runs = (line.runs ?? [])
    .filter((run) => /[\d.,]/.test(run.text) && !/^[₪%]+$/.test(run.text.trim()))
    .sort((a, b) => a.x - b.x);
  const groups: { text: string; x: number; width: number }[][] = [];
  for (const run of runs) {
    const last = groups[groups.length - 1];
    if (last) {
      const prev = last[last.length - 1];
      if (run.x - (prev.x + prev.width) < 25) {
        last.push(run);
        continue;
      }
    }
    groups.push([run]);
  }
  return groups.map((group) => parseNumber(group.map((run) => run.text).join("")));
}

const VENUE_NOUNS = ["מלון", "אולם", "גני", "גן", "בית", "מתחם", "מרכז", "מועדון", "כפר", "אצטדיון", "היכל"];

function stripVenuePrefix(value: string): string {
  const text = value.trim();
  if (text.startsWith("ב") && VENUE_NOUNS.some((noun) => text.slice(1).startsWith(noun))) return text.slice(1);
  if (text.startsWith("ה") && VENUE_NOUNS.some((noun) => text.slice(1).startsWith(noun))) return text.slice(1);
  return text;
}

function formatVenue(value: string): string {
  const text = value.trim();
  if (!text.includes(",") && /\sאולם\s/.test(text)) {
    return text.replace(/\s+אולם\s+/, ", אולם ");
  }
  return text;
}

function normalizeVenue(value: string): string {
  let text = value.replace(/ð/g, "נ").replace(/\s+/g, " ").trim();
  text = text.replace(/^בב(?=נ)/, "ב");
  return formatVenue(stripVenuePrefix(text));
}

function parseVenue(entries: { page: ExtractedLine; text: string }[]): string | null {
  const lines = entries.map((entry) => entry.text);
  for (const entry of entries) {
    const line = entry.text;
    const index = line.indexOf("עבור");
    if (index === -1 || index > 2) continue;
    const runs = entry.page.runs ?? [];
    const labelRun = runs.find((run) => run.text.includes("עבור"));
    const phoneRun = runs.find((run) => run.text.includes("נייד"));
    const venueRuns = labelRun
      ? runs.filter((run) => run.x < labelRun.x && (!phoneRun || run.x > phoneRun.x))
      : [];
    let rest = venueRuns.length
      ? joinRunsRtl(venueRuns)
      : line.slice(index + "עבור".length);
    rest = rest.replace(/^[\s:：\-–—]+/, "");
    if (rest.startsWith("אירוע ב ")) rest = rest.slice("אירוע ב ".length);
    else if (rest.startsWith("אירוע ")) rest = rest.slice("אירוע ".length);
    else if (rest.startsWith("ה ")) rest = rest.slice(2);
    rest = normalizeVenue(rest.replace(/^[\s:：\-–—]+/, ""));
    if (validVenue(rest)) return rest;
  }

  const eventName = firstValue(lines, ["שם האירוע", "שם הארוע"]);
  if (validVenue(eventName)) return eventName;

  const dateLine = lines.find((line) => line.includes("תאריך האירוע") || line.includes("תאריך הארוע"));
  if (dateLine) {
    const label = dateLine.includes("תאריך הארוע") ? "תאריך הארוע" : "תאריך האירוע";
    const rest = afterLabel(dateLine, label);
    if (rest) {
      const withoutDate = rest
        .replace(/\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/, "")
        .replace(/^[\s,،\-–—]+/, "")
        .trim();
      if (validVenue(withoutDate)) return withoutDate;
    }
  }

  const place = firstValue(lines, ["מקום האירוע", "מקום הארוע"]);
  if (validVenue(place)) return place;

  const placeLine = lines.find(
    (line) => line.includes("מקום") && !line.includes("מקום האירוע") && !line.includes("מקום הארוע"),
  );
  if (placeLine) {
    const value = afterLabel(placeLine, "מקום");
    if (validVenue(value)) return value;
  }

  const hallLabel = lines.find((line) => /^אולם\s*[:：\-–—]/.test(line));
  if (hallLabel) {
    const value = afterLabel(hallLabel, "אולם");
    if (validVenue(value)) return value;
  }
  const hallBare = lines.find((line) => /^אולם\s+/.test(line));
  if (validVenue(hallBare)) return hallBare;

  const addressVenue = firstValue(lines, ["כתובת האירוע", "כתובת הארוע"]);
  if (validVenue(addressVenue)) return addressVenue;

  return null;
}

function parseClientAddress(lines: string[]): string | null {
  for (const line of lines) {
    if (line.includes("כתובת האירוע") || line.includes("כתובת הארוע")) continue;
    const match = line.match(/^כתובת(?:\s+הלקוח)?\s*[:：]\s*(.+)$/);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function parseQuoteNumber(lines: string[]): string | null {
  const labelIndex = lines.findIndex((line) => /הצעת מחיר מס|מס['׳]?\s*הצעה/.test(line));
  if (labelIndex !== -1) {
    const same = lines[labelIndex].match(/מס['׳]?\s*(\d{2,6})/);
    if (same) return same[1];
    for (const offset of [1, -1, 2, -2]) {
      const line = lines[labelIndex + offset];
      if (!line) continue;
      const match = line.match(/^\s*(\d{3,5})\s*$/);
      if (match) {
        const value = Number(match[1]);
        if (value < 1900 || value > 2100) return match[1];
      }
    }
  }
  for (const line of lines.slice(0, 10)) {
    const match = line.match(/^\s*(\d{3,5})\s*$/);
    if (match) {
      const value = Number(match[1]);
      if (value < 1900 || value > 2100) return match[1];
    }
  }
  return null;
}

function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const text = clean(value).replace(/\s/g, "");
  const match = text.match(/(\d[\d-]{5,})/);
  if (!match) return null;
  const parts = match[1].split("-").filter(Boolean);
  if (parts.length === 2 && parts[0].length > parts[1].length) {
    return `${parts[1]}-${parts[0]}`;
  }
  return match[1];
}

function parseDiscount(lines: string[]): { type: "percent" | "amount"; value: number } {
  for (const line of lines) {
    if (!line.includes("הנחה")) continue;
    const value = parseNumber(line);
    return { type: line.includes("%") ? "percent" : "amount", value };
  }
  return { type: "percent", value: 0 };
}

function parseVat(lines: string[]): number {
  for (const line of lines) {
    if (!line.includes('מע"מ') && !line.includes("מע״מ")) continue;
    let match = line.match(/(\d{1,2}(?:\.\d+)?)\s*%/);
    if (match) return Number(match[1]);
    match = line.match(/%\s*(\d{1,2}(?:\.\d+)?)/);
    if (match) return Number(match[1]);
  }
  return 18;
}

function collectAfter(lines: string[], labels: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of labels) {
      if (!line.includes(label)) continue;
      const parts: string[] = [];
      const rest = afterLabel(line, label);
      if (rest) parts.push(rest);
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (isStop(next) || labels.some((item) => next.includes(item))) break;
        parts.push(next);
      }
      const value = parts.join("\n").trim();
      if (value) return value;
    }
  }
  return null;
}

function collectTerms(lines: string[]): string | null {
  const start = lines.findIndex((line) => line.replace(/\s+/g, "").includes("תנאיהסכם"));
  if (start === -1) return collectAfter(lines, ["תנאי תשלום", "תנאים"]);
  const parts: string[] = [];
  const rest = afterLabel(lines[start], "תנאי הסכם");
  if (rest) parts.push(rest);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^תאריך/.test(line) || /^חתימה/.test(line)) break;
    parts.push(line);
  }
  return parts.join("\n").trim() || null;
}

const HEADER_KEYWORDS = ["פריט", "תיאור", "שם הפריט", "כמות", "יח'", "יחידה", "מחיר", "מחיר ליחידה", "סכום", 'סה"כ', "סה״כ"];
const STOP_KEYWORDS = ['סה"כ', "סה״כ", "סך הכול", "ביניים", "הנחה", 'מע"מ', "מע״מ", "לתשלום"];

function isHeader(line: string): boolean {
  const matches = HEADER_KEYWORDS.filter((keyword) => line.includes(keyword));
  return new Set(matches).size >= 2;
}

function isStop(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  return (
    STOP_KEYWORDS.some((keyword) => line.startsWith(keyword)) ||
    line.includes("לתשלום") ||
    compact.includes("מחירלפנימע") ||
    compact.includes("מחירכוללמע") ||
    compact.includes("סךהכול") ||
    compact.includes('סה"כלתשלום')
  );
}

type ColumnKey = "index" | "name" | "unit_price" | "qty" | "total";

const COLUMN_KEYWORDS: Record<ColumnKey, string[]> = {
  index: ["#", "מס׳", "מס'"],
  name: ["שם הפריט", "פריט"],
  unit_price: ["מחיר ליחידה", "מחיר יח'", "מחיר"],
  qty: ["כמות"],
  total: ['מחיר לפני מע"מ', "סכום", 'סה"כ', "סה״כ"],
};

type ColumnRange = { center: number; left: number; right: number };

function headerColumns(line: ExtractedLine): Partial<Record<ColumnKey, ColumnRange>> {
  const columns: Partial<Record<ColumnKey, ColumnRange>> = {};
  const runs = coalesceRuns(line.runs ?? []);
  const claimed = new Set<number>();
  const keys = (Object.keys(COLUMN_KEYWORDS) as ColumnKey[]).sort((a, b) => {
    const maxA = Math.max(...COLUMN_KEYWORDS[a].map((keyword) => keyword.length));
    const maxB = Math.max(...COLUMN_KEYWORDS[b].map((keyword) => keyword.length));
    return maxB - maxA;
  });
  for (const key of keys) {
    const runIndex = runs.findIndex(
      (item, index) => !claimed.has(index) && COLUMN_KEYWORDS[key].some((keyword) => item.text.includes(keyword)),
    );
    if (runIndex === -1) continue;
    claimed.add(runIndex);
    const run = runs[runIndex];
    columns[key] = { center: run.x + run.width / 2, left: run.x, right: run.x + run.width };
  }
  return columns;
}

function assignColumn(run: ExtractedRun, columns: Partial<Record<ColumnKey, ColumnRange>>): ColumnKey | null {
  if (columns.index && run.x >= columns.index.left - 10) return "index";
  const numericKeys = ["unit_price", "qty", "total"] as const;
  const numericRight = Math.max(...numericKeys.map((key) => columns[key]?.right ?? -Infinity));
  if (run.x >= numericRight) return "name";
  let best: ColumnKey | null = null;
  let bestDistance = Infinity;
  for (const key of numericKeys) {
    const column = columns[key];
    if (!column) continue;
    const distance = Math.abs(run.x + run.width / 2 - column.center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best;
}

type RowCells = { name: string; unitPriceText: string; qtyText: string; totalText: string };

function rowCells(line: ExtractedLine, columns: Partial<Record<ColumnKey, ColumnRange>>): RowCells {
  const buckets: Record<ColumnKey, { text: string; x: number; width: number }[]> = {
    index: [], name: [], unit_price: [], qty: [], total: [],
  };
  for (const run of line.runs ?? []) {
    const key = assignColumn(run, columns);
    if (key) buckets[key].push({ text: run.text, x: run.x, width: run.width });
  }
  const joinAsc = (items: { text: string; x: number; width: number }[]) =>
    items.sort((a, b) => a.