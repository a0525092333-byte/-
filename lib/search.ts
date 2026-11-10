/**
 * Shared smart-search helpers: normalization, multi-word AND matching, scoring,
 * date parsing and match highlighting. Used by the /search screen.
 */

const NIQQUD = /[\u0591-\u05C7]/g;
const PUNCTUATION = /["'`׳״.,;:!?()[\]{}<>/\\|*_+=~^%$#@-]/g;

export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(NIQQUD, "")
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

export function matchesAllTerms(text: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const haystack = normalizeSearchText(text);
  return terms.every((term) => haystack.includes(term));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Higher is better: exact primary > primary prefix > word start > substring. */
export function scoreText(primary: string, secondary: string, terms: string[]): number {
  const p = normalizeSearchText(primary);
  const s = normalizeSearchText(secondary);
  let score = 0;
  for (const term of terms) {
    if (p === term) score += 100;
    else if (p.startsWith(term)) score += 60;
    else if (new RegExp(`(^|\\s)${escapeRegExp(term)}`).test(p)) score += 40;
    else if (p.includes(term)) score += 20;
    else if (s.includes(term)) score += 10;
  }
  return score;
}

const pad2 = (value: string) => value.padStart(2, "0");

/** Accepts dd/mm/yyyy, dd.mm.yy and yyyy-mm-dd; returns an ISO yyyy-mm-dd date. */
export function parseDateQuery(query: string): string | null {
  const q = query.trim();
  let match = q.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (match) return `${match[3]}-${pad2(match[2])}-${pad2(match[1])}`;
  match = q.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2})$/);
  if (match) return `20${match[3]}-${pad2(match[2])}-${pad2(match[1])}`;
  match = q.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return null;
}

export function dateMatches(value: string | null | undefined, isoDate: string): boolean {
  if (!value) return false;
  return value.slice(0, 10) === isoDate;
}

export type HighlightPart = { text: string; match: boolean };

/** Split text into plain/matched parts for <mark> rendering. */
export function highlightParts(text: string, terms: string[]): HighlightPart[] {
  if (!text) return [];
  const usable = terms.filter(Boolean);
  if (!usable.length) return [{ text, match: false }];
  const pattern = new RegExp(`(${usable.map(escapeRegExp).join("|")})`, "gi");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), match: false });
    parts.push({ text: match[0], match: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts.length ? parts : [{ text, match: false }];
}
