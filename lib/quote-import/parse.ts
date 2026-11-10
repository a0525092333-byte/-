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

/** pdf.js often splits gershayim into separate runs: "סה \" כ" -> "סה\"כ". */
function normalizeGershayim(value: string): string {
  return value.replace(/ð/g, "נ").replace(/\s*(["״׳'])\s*/g, "$1");
}

/** Merge runs that pdf.js split apart (e.g. "סה" + '"' + "כ") before matching. */
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
    // dd/mm/yy
    const yearA = match[3].length === 2 ? `20${match[3]}` : match[3];
    const ddmm = isoDate(yearA, match[2], match[1]);
    if (ddmm) candidates.push(ddmm);
    // yy/mm/dd — RTL extraction can reverse the three groups.
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
  // The PDF font maps נ to ð and sometimes emits a leading ב prefix.
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
    items.sort((a, b) => a.x - b.x).map((item) => item.text).join("");
  return {
    name: joinRunsRtl(buckets.name),
    unitPriceText: joinAsc(buckets.unit_price),
    qtyText: joinAsc(buckets.qty),
    totalText: joinAsc(buckets.total),
  };
}

function parseItemRow(
  line: ExtractedLine,
  columns: Partial<Record<ColumnKey, ColumnRange>>,
  sectionIndex: number,
): ParsedItem | null {
  const cells = rowCells(line, columns);
  const qty = parseNumber(cells.qtyText);
  const unitPrice = parseNumber(cells.unitPriceText);
  const total = parseNumber(cells.totalText);
  const rawName = stripBullets(cells.name);
  if (!rawName && !qty && !unitPrice && !total) return null;
  let name = rawName;
  let description: string | null = null;
  const paren = rawName.search(/[()]/);
  if (paren > 0) {
    name = rawName.slice(0, paren).trim();
    description = stripBullets(rawName.slice(paren));
  }
  const quantity = qty || (unitPrice ? 1 : 0);
  const lineTotal = total || Math.round(qty * unitPrice * 100) / 100;
  return {
    name: name || "פריט",
    description,
    qty: quantity,
    quantity,
    unit: null,
    unit_price: unitPrice,
    unitPrice,
    line_total: lineTotal,
    lineTotal,
    sectionIndex,
  };
}

function isTableHeader(text: string): boolean {
  return text.includes("פריט") && text.includes("כמות") && text.includes("מחיר");
}

function parseItems(entries: { page: ExtractedLine; text: string }[]): {
  items: ParsedItem[];
  sections: ParsedSection[];
} {
  const items: ParsedItem[] = [];
  const sections: ParsedSection[] = [{ name: "כללי", sort_order: 0 }];
  let sectionIndex = 0;
  let headerIndex = -1;
  let columns: Partial<Record<ColumnKey, ColumnRange>> = {};

  for (let i = 0; i < entries.length; i++) {
    if (isTableHeader(entries[i].text)) {
      headerIndex = i;
      columns = headerColumns(entries[i].page);
      break;
    }
  }
  if (headerIndex === -1) return { items, sections };
  const swapDimensions = entries[headerIndex].text.includes("#");

  for (let i = headerIndex + 1; i < entries.length; i++) {
    const entry = entries[i];
    const text = entry.text;
    if (isStop(text) || /^תאריך/.test(text) || /^חתימה/.test(text)) break;
    if (isTableHeader(text)) continue;

    const cells = rowCells(entry.page, columns);
    const nameText = stripBullets(cells.name);
    const hasNumbers = /\d/.test(cells.unitPriceText + cells.qtyText + cells.totalText);
    const qty = parseNumber(cells.qtyText);
    const unitPrice = parseNumber(cells.unitPriceText);
    const total = parseNumber(cells.totalText);
    const allZero = !qty && !unitPrice && !total;

    if (nameText.endsWith(":") && allZero) {
      const name = nameText.replace(/[:：]\s*$/, "").trim();
      if (name) {
        sections.push({ name, sort_order: sections.length });
        sectionIndex = sections.length - 1;
      }
      continue;
    }

    if (hasNumbers) {
      const item = parseItemRow(entry.page, columns, sectionIndex);
      if (item) items.push(item);
      continue;
    }

    if (items.length) {
      const last = items[items.length - 1];
      const rawContinuation = fixLatinPrefix(textFromRuns(entry.page));
      const hasBullet = /^[\s\-–—•·]/.test(rawContinuation);
      const continuation = stripBullets(rawContinuation);
      if (continuation) {
        if (last.description) {
          const combined = `${last.description} ${continuation}`;
          const shortMirrored = /^\)/.test(last.description) && /\($/.test(continuation) && combined.length <= 24;
          if (shortMirrored) {
            last.name = `${last.name} ${combined}`;
            last.description = null;
          } else {
            last.description = combined;
          }
        } else if (hasBullet) {
          last.description = continuation;
        } else {
          last.name = `${last.name} ${continuation}`;
        }
      }
    }
  }

  for (const item of items) {
    item.name = fixBrackets(fixPunctuationSpacing(fixHebrewDigitSpacing(item.name)));
    if (swapDimensions) {
      item.name = item.name.replace(/(\d+(?:\.\d+)?)\*(\d+(?:\.\d+)?)/, (_, a, b) => `${b}*${a}`);
    }
    if (item.description) item.description = fixBrackets(fixPunctuationSpacing(item.description));
  }

  return { items, sections };
}

function parseTotals(entries: { page: ExtractedLine; text: string }[]): {
  subtotal: number | null;
  discountType: "percent" | "amount";
  discountValue: number;
  discountAmount: number;
  totalBeforeVat: number | null;
  vatRate: number;
  vatAmount: number | null;
  grandTotal: number | null;
} {
  let subtotal: number | null = null;
  let discountType: "percent" | "amount" = "percent";
  let discountValue = 0;
  let discountAmount = 0;
  let totalBeforeVat: number | null = null;
  let vatRate = 18;
  let vatAmount: number | null = null;
  let grandTotal: number | null = null;

  for (const entry of entries) {
    const compact = entry.text.replace(/\s+/g, "");
    const groups = numericGroups(entry.page);
    if ((compact.includes('סה"כ') || compact.includes("סךהכול")) && compact.includes("הנחה") && !compact.includes("מחירלפני")) {
      if (groups[0] != null) subtotal = groups[0];
    } else if (compact.includes("הנחה") && compact.includes("%")) {
      discountType = "percent";
      discountAmount = groups[0] ?? 0;
      discountValue = groups[1] ?? 0;
    } else if (compact.includes("הנחה")) {
      discountType = "amount";
      discountValue = groups[0] ?? 0;
      discountAmount = groups[0] ?? 0;
    } else if (compact.includes("מחירלפני") && compact.includes("מע")) {
      if (groups[0] != null) totalBeforeVat = groups[0];
    } else if (compact.includes('מע"מ') && compact.includes("%")) {
      vatRate = groups[groups.length - 1] ?? 18;
      vatAmount = groups.length >= 2 ? groups[groups.length - 2] : null;
      grandTotal = groups[0] ?? null;
    } else if (compact.includes("מחיר כולל") || compact.includes("מחירכולל")) {
      if (groups[0] != null) grandTotal = groups[0];
    }
  }

  return { subtotal, discountType, discountValue, discountAmount, totalBeforeVat, vatRate, vatAmount, grandTotal };
}

function parseNotes(entries: { page: ExtractedLine; text: string }[]): string | null {
  const start = entries.findIndex((entry) => entry.text.trim().startsWith("הערות"));
  if (start === -1) return null;
  const parts: string[] = [];
  for (let i = start + 1; i < entries.length; i++) {
    const text = entries[i].text;
    const compact = text.replace(/\s+/g, "");
    if (compact.includes("תנאי")) break;
    if (/^חתימה/.test(text) || /^תאריך/.test(text)) break;
    const line = stripBullets(fixLatinPrefix(textFromRuns(entries[i].page)));
    if (line) parts.push(line);
  }
  return parts.length ? parts.join("\n") : null;
}

export function parseQuoteDocument(pages: ExtractedLine[]): ParsedQuote {
  const entries = pages
    .map((page) => ({ page, text: normalizeGershayim(clean(page.text)) }))
    .filter((entry) => entry.text);
  const lines = entries.map((entry) => entry.text);
  const rawText = lines.join("\n");
  const warnings: string[] = [];

  const rawClientName = firstValue(lines, ["לכבוד", "שם הלקוח", "לקוח:"]);
  const clientName = rawClientName ? fixClientName(rawClientName) : null;
  if (!clientName) warnings.push("לא זוהה שם לקוח");

  const clientPhone = normalizePhone(firstValue(lines, ["נייד", "טלפון", "נייד:"]));

  const venue = parseVenue(entries);
  if (!venue) warnings.push("לא זוהה מקום האירוע");

  const eventDate = firstDate(
    lines,
    ["תאריך האירוע", "תאריך הארוע", "בתאריך", "מועד", "תאריך"],
    ["הצעה", "הפקה", "הדפסה"],
  );
  if (!eventDate) warnings.push("לא זוהה תאריך האירוע");

  const quoteDate = firstDate(lines, ["ת. הצעה", "ת.הצעה", "תאריך הצעה", "תאריך הפקה"]);
  if (!quoteDate) warnings.push("לא זוהה תאריך ההצעה");

  const quoteNumber = parseQuoteNumber(lines);
  if (!quoteNumber) warnings.push("לא זוהה מספר הצעה");

  const guestValue = firstValue(lines, ["כמות מוזמנים", "מס' אורחים", "אורחים"]);
  const guestCount = guestValue ? parseNumber(guestValue) || null : null;

  const clientAddress = parseClientAddress(lines);
  const eventAddress = firstValue(lines, ["כתובת האירוע", "כתובת הארוע"]);

  const { items, sections } = parseItems(entries);
  if (!items.length) warnings.push("לא זוהו פריטים בהצעה");

  const printed = parseTotals(entries);
  const notes = parseNotes(entries);
  const terms = collectTerms(lines);

  const round2 = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
  const itemsSubtotal = round2(items.reduce((sum, item) => sum + item.line_total, 0));
  const subtotal = printed.subtotal ?? itemsSubtotal;
  if (printed.subtotal != null && Math.abs(itemsSubtotal - printed.subtotal) > 1) {
    warnings.push(
      `סכום הפריטים (${itemsSubtotal.toLocaleString("he-IL")}) אינו תואם לסה"כ המודפס (${printed.subtotal.toLocaleString("he-IL")})`,
    );
  }
  const discountType = printed.discountType;
  const discountValue = printed.discountValue;
  const discountAmount = printed.discountAmount;
  const totalBeforeVat = printed.totalBeforeVat ?? round2(Math.max(0, subtotal - discountAmount));
  const vatRate = printed.vatRate;
  const vatAmount = printed.vatAmount ?? round2(totalBeforeVat * ((Number(vatRate) || 0) / 100));
  const grandTotal = printed.grandTotal ?? Math.round(totalBeforeVat + vatAmount);

  return {
    clientName,
    clientPhone,
    venue,
    eventDate,
    quoteDate,
    quoteNumber,
    guestCount,
    address: clientAddress,
    clientAddress,
    eventAddress,
    items,
    sections,
    discountType,
    discountValue,
    discountAmount,
    subtotal,
    totalBeforeVat,
    vatRate,
    vatAmount,
    grandTotal,
    notes,
    terms,
    warnings,
    rawText,
  };
}
