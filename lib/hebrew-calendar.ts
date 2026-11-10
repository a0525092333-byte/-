/**
 * Self-contained Hebrew (Jewish) calendar arithmetic + Israeli holiday table.
 * No network, no external package: works offline and instantly.
 *
 * The conversion follows the standard molad + dechiyot algorithm (Calendrical
 * Calculations): Hebrew year -> elapsed days -> Rosh Hashanah fixed date, then
 * month lengths (long Marcheshvan / short Kislev) and the leap-year cycle.
 * Fixed dates are Rata Die (1 Jan 1 = 1); Gregorian dates are converted through
 * UTC midnight so the local timezone never shifts a day.
 */

const HEBREW_EPOCH = -1373427;
const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_FIXED = 719163;

export type HolidayCategory = "chag" | "tzom" | "moed" | "modern" | "rosh_chodesh";

export type Holiday = { name: string; category: HolidayCategory };

export type HebrewDate = {
  year: number;
  month: number;
  day: number;
  monthName: string;
  dayGematriya: string;
  monthGematriya: string;
  yearGematriya: string;
  formatted: string;
};

const MONTH_NAMES: Record<number, string> = {
  1: "ניסן",
  2: "אייר",
  3: "סיון",
  4: "תמוז",
  5: "אב",
  6: "אלול",
  7: "תשרי",
  8: "חשוון",
  9: "כסלו",
  10: "טבת",
  11: "שבט",
  12: "אדר",
  13: "אדר ב׳",
};

const GEMATRIYA_ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const GEMATRIYA_TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const GEMATRIYA_HUNDREDS = ["", "ק", "ר", "ש", "ת"];

function gematriyaLetters(value: number): string {
  let n = Math.abs(Math.trunc(value));
  let out = "";
  while (n >= 400) {
    out += "ת";
    n -= 400;
  }
  out += GEMATRIYA_HUNDREDS[Math.floor(n / 100)];
  n %= 100;
  if (n === 15) {
    out += "טו";
  } else if (n === 16) {
    out += "טז";
  } else {
    out += GEMATRIYA_TENS[Math.floor(n / 10)];
    out += GEMATRIYA_ONES[n % 10];
  }
  return out;
}

/** Render a number in Hebrew gematriya with geresh / gershayim. */
export function renderGematriya(value: number, options?: { thousands?: boolean }): string {
  let n = Math.abs(Math.trunc(value));
  if (options?.thousands) n %= 1000;
  if (!n) return "";
  const letters = gematriyaLetters(n);
  if (letters.length === 1) return `${letters}׳`;
  return `${letters.slice(0, -1)}״${letters.slice(-1)}`;
}

function isHebrewLeapYear(year: number): boolean {
  return ((7 * year + 1) % 19) < 7;
}

function lastMonthOfYear(year: number): number {
  return isHebrewLeapYear(year) ? 13 : 12;
}

function elapsedDays(year: number): number {
  const monthsElapsed = Math.floor((235 * year - 234) / 19);
  const partsElapsed = 12084 + 13753 * monthsElapsed;
  let day = 29 * monthsElapsed + Math.floor(partsElapsed / 25920);
  if ((3 * (day + 1)) % 7 < 3) day += 1;
  return day;
}

function yearLengthCorrection(year: number): number {
  const ny0 = elapsedDays(year - 1);
  const ny1 = elapsedDays(year);
  const ny2 = elapsedDays(year + 1);
  if (ny2 - ny1 === 356) return 2;
  if (ny1 - ny0 === 382) return 1;
  return 0;
}

function hebrewNewYear(year: number): number {
  return HEBREW_EPOCH + elapsedDays(year) + yearLengthCorrection(year);
}

function daysInHebrewYear(year: number): number {
  return hebrewNewYear(year + 1) - hebrewNewYear(year);
}

function longMarcheshvan(year: number): boolean {
  return daysInHebrewYear(year) % 10 === 5;
}

function shortKislev(year: number): boolean {
  return daysInHebrewYear(year) % 10 === 3;
}

function hebrewMonthLength(year: number, month: number): number {
  if ([2, 4, 6, 10, 13].includes(month)) return 29;
  if (month === 12 && !isHebrewLeapYear(year)) return 29;
  if (month === 8 && !longMarcheshvan(year)) return 29;
  if (month === 9 && shortKislev(year)) return 29;
  return 30;
}

function hebrewToFixed(year: number, month: number, day: number): number {
  let fixed = hebrewNewYear(year) + day - 1;
  if (month < 7) {
    for (let m = 7; m <= lastMonthOfYear(year); m += 1) fixed += hebrewMonthLength(year, m);
    for (let m = 1; m < month; m += 1) fixed += hebrewMonthLength(year, m);
  } else {
    for (let m = 7; m < month; m += 1) fixed += hebrewMonthLength(year, m);
  }
  return fixed;
}

function hebrewFromFixed(fixed: number): { year: number; month: number; day: number } {
  let year = Math.floor((fixed - HEBREW_EPOCH) / 366);
  while (hebrewNewYear(year + 1) <= fixed) year += 1;
  while (hebrewNewYear(year) > fixed) year -= 1;
  let day = fixed - hebrewNewYear(year) + 1;
  let month = 7;
  const last = lastMonthOfYear(year);
  for (;;) {
    const length = hebrewMonthLength(year, month);
    if (day <= length) break;
    day -= length;
    month = (month % last) + 1;
  }
  return { year, month, day };
}

function fixedFromDate(date: Date): number {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(utc / MS_PER_DAY) + UNIX_EPOCH_FIXED;
}

function monthName(year: number, month: number): string {
  if (month === 12 && isHebrewLeapYear(year)) return "אדר א׳";
  return MONTH_NAMES[month] ?? "";
}

export function getHebrewDate(date: Date): HebrewDate {
  const { year, month, day } = hebrewFromFixed(fixedFromDate(date));
  const name = monthName(year, month);
  const dayGematriya = renderGematriya(day);
  const yearGematriya = renderGematriya(year, { thousands: true });
  return {
    year,
    month,
    day,
    monthName: name,
    dayGematriya,
    monthGematriya: renderGematriya(month),
    yearGematriya,
    formatted: `${dayGematriya} ${name} ${yearGematriya}`,
  };
}

/** The Hebrew month(s) a Gregorian month spans, e.g. "חשוון–כסלו תשפ״ז". */
export function getHebrewMonthLabel(date: Date): string {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const startHebrew = getHebrewDate(start);
  const endHebrew = getHebrewDate(end);
  const yearLabel =
    startHebrew.year === endHebrew.year
      ? startHebrew.yearGematriya
      : `${startHebrew.yearGematriya}–${endHebrew.yearGematriya}`;
  if (startHebrew.monthName === endHebrew.monthName) return `${startHebrew.monthName} ${yearLabel}`;
  return `${startHebrew.monthName}–${endHebrew.monthName} ${yearLabel}`;
}

function weekday(fixed: number): number {
  return fixed % 7; // 0 = Sunday, 6 = Saturday
}

const holidayCache = new Map<number, Map<number, Holiday[]>>();

function addHoliday(
  map: Map<number, Holiday[]>,
  year: number,
  month: number,
  day: number,
  name: string,
  category: HolidayCategory,
) {
  const fixed = hebrewToFixed(year, month, day);
  const list = map.get(fixed) ?? [];
  list.push({ name, category });
  map.set(fixed, list);
}

function buildHolidays(year: number): Map<number, Holiday[]> {
  const map = new Map<number, Holiday[]>();

  // Major chag
  addHoliday(map, year, 7, 1, "ראש השנה", "chag");
  addHoliday(map, year, 7, 2, "ראש השנה", "chag");
  addHoliday(map, year, 7, 9, "ערב יום כיפור", "chag");
  addHoliday(map, year, 7, 10, "יום כיפור", "chag");
  addHoliday(map, year, 7, 15, "סוכות", "chag");
  for (let day = 16; day <= 20; day += 1) addHoliday(map, year, 7, day, "חול המועד סוכות", "chag");
  addHoliday(map, year, 7, 21, "הושענא רבה", "chag");
  addHoliday(map, year, 7, 22, "שמחת תורה / שמיני עצרת", "chag");
  addHoliday(map, year, 1, 15, "פסח", "chag");
  for (let day = 16; day <= 20; day += 1) addHoliday(map, year, 1, day, "חול המועד פסח", "chag");
  addHoliday(map, year, 1, 21, "שביעי של פסח", "chag");
  addHoliday(map, year, 3, 6, "שבועות", "chag");

  // Fast days (with the standard Shabbat postponements)
  const gedaliah = weekday(hebrewToFixed(year, 7, 3)) === 6 ? 4 : 3;
  addHoliday(map, year, 7, gedaliah, "צום גדליה", "tzom");
  addHoliday(map, year, 10, 10, "עשרה בטבת", "tzom");
  const adar = isHebrewLeapYear(year) ? 13 : 12;
  const esther = weekday(hebrewToFixed(year, adar, 13)) === 6 ? 11 : 13;
  addHoliday(map, year, adar, esther, "תענית אסתר", "tzom");
  const tammuz = weekday(hebrewToFixed(year, 4, 17)) === 6 ? 18 : 17;
  addHoliday(map, year, 4, tammuz, "צום שבעה עשר בתמוז", "tzom");
  const av = weekday(hebrewToFixed(year, 5, 9)) === 6 ? 10 : 9;
  addHoliday(map, year, 5, av, "תשעה באב", "tzom");

  // Chanukah: 8 days from 25 Kislev (may cross into Tevet)
  let chanukah = hebrewToFixed(year, 9, 25);
  for (let index = 1; index <= 8; index += 1) {
    const h = hebrewFromFixed(chanukah);
    addHoliday(map, h.year, h.month, h.day, `חנוכה ${index}`, "moed");
    chanukah += 1;
  }

  addHoliday(map, year, 11, 15, "ט״ו בשבט", "moed");
  addHoliday(map, year, adar, 14, "פורים", "moed");
  addHoliday(map, year, adar, 15, "שושן פורים", "moed");
  addHoliday(map, year, 2, 18, "ל״ג בעומר", "moed");

  // Rosh Chodesh: 1st of each month (except Tishrei = Rosh Hashanah) and the
  // 30th of the previous month when it has 30 days.
  for (let month = 1; month <= lastMonthOfYear(year); month += 1) {
    if (month !== 7) addHoliday(map, year, month, 1, "ראש חודש", "rosh_chodesh");
    const previous = month === 1 ? lastMonthOfYear(year) : month - 1;
    if (hebrewMonthLength(year, previous) === 30) addHoliday(map, year, previous, 30, "ראש חודש", "rosh_chodesh");
  }

  // Modern / national days (with the standard shifts)
  const shoahBase = weekday(hebrewToFixed(year, 1, 27));
  const shoah = shoahBase === 5 ? 26 : shoahBase === 0 ? 28 : 27;
  addHoliday(map, year, 1, shoah, "יום הזיכרון לשואה ולגבורה", "modern");
  const zikaronBase = weekday(hebrewToFixed(year, 2, 4));
  const zikaron = zikaronBase === 4 || zikaronBase === 5 ? 3 : 4;
  addHoliday(map, year, 2, zikaron, "יום הזיכרון לחללי מערכות ישראל", "modern");
  const atzmautBase = weekday(hebrewToFixed(year, 2, 5));
  const atzmaut = atzmautBase === 5 ? 4 : atzmautBase === 6 ? 3 : 5;
  addHoliday(map, year, 2, atzmaut, "יום העצמאות", "modern");
  addHoliday(map, year, 2, 28, "יום ירושלים", "modern");
  addHoliday(map, year, 11, 30, "יום המשפחה", "modern");
  addHoliday(map, year, 8, 29, "סיגד", "modern");

  return map;
}

export function getHolidays(date: Date): Holiday[] {
  const fixed = fixedFromDate(date);
  const { year } = hebrewFromFixed(fixed);
  let map = holidayCache.get(year);
  if (!map) {
    map = buildHolidays(year);
    holidayCache.set(year, map);
  }
  return map.get(fixed) ?? [];
}
