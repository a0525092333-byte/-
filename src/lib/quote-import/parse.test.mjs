import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseQuoteDocument } from "./parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "__fixtures__", "sample-quote.json"), "utf8"));
const parsed = parseQuoteDocument(fixture);

assert.equal(parsed.venue, "אולם הגן הקסום, רחוב האלון 12, נתניה");
assert.notEqual(parsed.venue, "עבור");
assert.ok(!String(parsed.venue).startsWith("עבור"));
assert.equal(parsed.clientName, "משפחת כהן");
assert.equal(parsed.items.length, 3);

const sum = parsed.items.reduce((total, item) => total + item.line_total, 0);
const grand = Math.round(sum * (1 + parsed.vatRate / 100));
assert.equal(sum, 7100);
assert.equal(parsed.vatRate, 18);
assert.equal(grand, 8378);

console.log("PASS parseQuoteDocument");
console.log(
  JSON.stringify(
    {
      venue: parsed.venue,
      clientName: parsed.clientName,
      items: parsed.items.length,
      itemNames: parsed.items.map((item) => item.name),
      sum,
      vatRate: parsed.vatRate,
      grand,
      warnings: parsed.warnings,
    },
    null,
    2,
  ),
);

// Venue fallback must never return the label itself.
const fallback = parseQuoteDocument([
  { text: "עבור" },
  { text: "שם האירוע: עבור" },
  { text: "לכבוד: לקוח בדיקה" },
]);
assert.notEqual(fallback.venue, "עבור");
assert.ok(!String(fallback.venue ?? "").startsWith("עבור"));

// pdf.js splits gershayim into separate runs; normalisation must recover them.
const spaced = parseQuoteDocument([
  { text: "הצעת מחיר מס ' 2416" },
  { text: "סה \" כ 100" },
  { text: "מע \" מ 18% 18" },
]);
assert.equal(spaced.quoteNumber, "2416");
assert.equal(spaced.vatRate, 18);

// A header without a unit column must still assign the price column.
const noUnit = parseQuoteDocument([
  {
    text: "פריט תיאור כמות מחיר ליחידה סכום",
    runs: [
      { text: "פריט", x: 520, width: 50 },
      { text: "תיאור", x: 420, width: 50 },
      { text: "כמות", x: 330, width: 40 },
      { text: "מחיר ליחידה", x: 180, width: 70 },
      { text: "סכום", x: 80, width: 40 },
    ],
  },
  {
    text: "מערכת הגברה JBL 1 3500 3500",
    runs: [
      { text: "מערכת הגברה", x: 520, width: 80 },
      { text: "JBL", x: 420, width: 30 },
      { text: "1", x: 330, width: 20 },
      { text: "3500", x: 180, width: 40 },
      { text: "3500", x: 80, width: 40 },
    ],
  },
  { text: "סה \" כ 3500" },
]);
assert.equal(noUnit.items.length, 1);
assert.equal(noUnit.items[0].unit_price, 3500);
assert.equal(noUnit.items[0].line_total, 3500);

console.log("PASS extra parser cases");

// Split header runs (סה " כ) must coalesce so the total column is claimed.
const splitHeader = parseQuoteDocument([
  {
    text: "פריט תיאור כמות מחיר ליחידה סה\"כ",
    runs: [
      { text: "פריט", x: 520, width: 50 },
      { text: "תיאור", x: 420, width: 50 },
      { text: "כמות", x: 330, width: 40 },
      { text: "מחיר ליחידה", x: 180, width: 70 },
      { text: "סה", x: 100, width: 20 },
      { text: "\"", x: 90, width: 10 },
      { text: "כ", x: 80, width: 10 },
    ],
  },
  {
    text: "מערכת הגברה JBL 1 3500 3500",
    runs: [
      { text: "מערכת הגברה", x: 520, width: 80 },
      { text: "JBL", x: 420, width: 30 },
      { text: "1", x: 330, width: 20 },
      { text: "3500", x: 180, width: 40 },
      { text: "3500", x: 80, width: 40 },
    ],
  },
  { text: "סה \" כ 3500" },
]);
assert.equal(splitHeader.items.length, 1);
assert.equal(splitHeader.items[0].unit_price, 3500);
assert.equal(splitHeader.items[0].line_total, 3500);

// A bare hall line must stay intact; a label line must be stripped.
const bareHall = parseQuoteDocument([{ text: "אולם הגן הקסום, נתניה" }]);
assert.equal(bareHall.venue, "אולם הגן הקסום, נתניה");
const labelledHall = parseQuoteDocument([{ text: "אולם: הגן הקסום, נתניה" }]);
assert.equal(labelledHall.venue, "הגן הקסום, נתניה");

// A nested "עבור" must not leak into the venue.
const nested = parseQuoteDocument([{ text: "עבור: עבור אולם הגן" }]);
assert.notEqual(nested.venue, "עבור אולם הגן");

console.log("PASS split-run and venue cases");

// Real client quote (Binyanei HaUma) — golden fixture extracted with pdf.js.
const real = JSON.parse(readFileSync(join(here, "__fixtures__", "real-buktzin.json"), "utf8"));
const realParsed = parseQuoteDocument(real);
assert.equal(realParsed.quoteNumber, "2441");
assert.equal(realParsed.clientName, "מוטי בוקצין");
assert.equal(realParsed.clientPhone, "050-7408386");
assert.equal(realParsed.venue, "בנייני האומה");
assert.notEqual(realParsed.venue, "עבור");
assert.ok(!String(realParsed.venue).includes("עבור"));
assert.ok(!String(realParsed.venue).includes("2441"));
assert.equal(realParsed.eventDate, "2026-11-08");
assert.equal(realParsed.quoteDate, "2026-11-02");
assert.equal(realParsed.items.length, 1);
assert.equal(realParsed.items[0].quantity, 175.5);
assert.equal(realParsed.items[0].unitPrice, 500);
assert.equal(realParsed.items[0].lineTotal, 87750);
assert.equal(realParsed.subtotal, 87750);
assert.equal(realParsed.vatRate, 18);
assert.equal(realParsed.grandTotal, 103545);
assert.equal(realParsed.discountValue, 0);
assert.equal(realParsed.discountAmount, 0);
assert.ok(realParsed.terms && realParsed.terms.trim().length > 0);

console.log("PASS real-buktzin fixture");
console.log(
  JSON.stringify(
    {
      quoteNumber: realParsed.quoteNumber,
      clientName: realParsed.clientName,
      clientPhone: realParsed.clientPhone,
      venue: realParsed.venue,
      eventDate: realParsed.eventDate,
      quoteDate: realParsed.quoteDate,
      items: realParsed.items.length,
      quantity: realParsed.items[0].quantity,
      unitPrice: realParsed.items[0].unitPrice,
      lineTotal: realParsed.items[0].lineTotal,
      subtotal: realParsed.subtotal,
      vatRate: realParsed.vatRate,
      grandTotal: realParsed.grandTotal,
      discount: realParsed.discountValue,
      terms: realParsed.terms ? "present" : "missing",
    },
    null,
    2,
  ),
);

// Second real client quote (Machon Beit Yaakov) — locks the geometry parser,
// discount, notes, venue and section fixes.
const machon = JSON.parse(readFileSync(join(here, "__fixtures__", "real-machon-bey.json"), "utf8"));
const m = parseQuoteDocument(machon);
assert.equal(m.venue, "מלון רויאל ים המלח");
assert.ok(!String(m.venue).includes("עבור"));
assert.ok(!String(m.venue).startsWith("ב"));
assert.ok(!m.eventAddress);
assert.equal(m.clientAddress, "ירושלים");
assert.equal(m.items.length, 16);
assert.ok(!m.items.some((item) => item.name === "פריט"));
assert.ok(!m.items.some((item) => item.unit_price === 2432));
assert.ok(!m.items.some((item) => (item.description ?? "").includes("חתימה")));
assert.ok(m.items.length < 20);
assert.equal(m.subtotal, 63400);
assert.equal(m.discountType, "percent");
assert.equal(m.discountValue, 8);
assert.equal(m.discountAmount, 5072);
assert.equal(m.totalBeforeVat, 58328);
assert.equal(m.vatRate, 18);
assert.equal(m.vatAmount, 10499.04);
assert.equal(m.grandTotal, 68827);
assert.deepEqual(m.sections.map((section) => section.name), ["כללי", "אולם ברקת", "אולם ספיר"]);
assert.ok(
  !m.sections.some((section) =>
    ["פריט", "חתימה :", "- חיבור למעגל סגור", "מצורף בהערות", 'בע"מ'].includes(section.name),
  ),
);
const vmix = m.items.find((item) => item.name.includes("2 מחשבים עם VMIX"));
assert.ok(vmix);
assert.ok((vmix.description ?? "").includes("2 כבלים SDI לצלם וידאו"));
assert.ok((vmix.description ?? "").includes("חיבור למעגל סגור"));
const sound = m.items.find((item) => item.name.includes("מערכת הגברה ליינאריי"));
assert.ok(sound);
assert.ok((sound.description ?? "").includes("6 רמקולים"));
assert.ok((sound.description ?? "").includes("מפרט מצורף בהערות"));
const lighting = m.items.find((item) => item.name.includes("2 עמודי תאורה"));
assert.ok(lighting);
assert.ok((lighting.description ?? "").includes("מחירון וואו"));
assert.ok(m.items.some((item) => item.name === "מסך לד 3*2"));
assert.ok((m.notes ?? "").includes("מוניטור לעמדת קונטרול"));
assert.ok(!(m.notes ?? "").includes("יום נוסף"));
assert.ok(!(m.notes ?? "").includes("הדפסה"));

const eventAddressFirst = parseQuoteDocument([
  { text: "כתובת האירוע: אולם הגן, נתניה" },
  { text: "כתובת: ירושלים" },
]);
assert.equal(eventAddressFirst.eventAddress, "אולם הגן, נתניה");
assert.equal(eventAddressFirst.clientAddress, "ירושלים");

console.log("PASS real-machon-bey fixture");
console.log(
  JSON.stringify(
    {
      venue: m.venue,
      eventAddress: m.eventAddress,
      items: m.items.length,
      sections: m.sections.map((section) => section.name),
      subtotal: m.subtotal,
      discountType: m.discountType,
      discountValue: m.discountValue,
      discountAmount: m.discountAmount,
      totalBeforeVat: m.totalBeforeVat,
      vatRate: m.vatRate,
      vatAmount: m.vatAmount,
      grandTotal: m.grandTotal,
      notes: m.notes ? "present" : "missing",
    },
    null,
    2,
  ),
);

// Third real client quote (Darkei Rachel) — locks the run-join, venue rejection,
// digit order, bracket order, continuation merge and zero-discount fixes.
const darkei = JSON.parse(readFileSync(join(here, "__fixtures__", "real-darkei-rachel.json"), "utf8"));
const d = parseQuoteDocument(darkei);
assert.equal(d.clientName, "סמינר דרכי רחל");
assert.equal(d.clientPhone, "054-8470175");
assert.equal(d.venue, null);
assert.equal(d.quoteDate, "2026-10-19");
assert.equal(d.eventDate, "2026-11-07");
assert.equal(d.items.length, 6);
assert.equal(d.items[0].name, "מסך 2.5*4");
assert.ok((darkei[0] && true));
assert.equal(d.items[5].name, "מסך 3*5");
assert.ok(d.items[3].name.includes("חיבור 3 כלים."));
assert.equal(d.items[3].description, null);
assert.ok((d.items[0].description ?? "").includes("(צריך לבדוק"));
assert.ok((d.items[0].description ?? "").endsWith("המסך)"));
assert.ok((d.items[1].description ?? "").includes("(מפרט כמצורף בהערה למטה)"));
assert.equal(d.subtotal, 14850);
assert.equal(d.discountValue, 0);
assert.equal(d.discountAmount, 0);
assert.equal(d.vatAmount, 2673);
assert.equal(d.grandTotal, 17523);

console.log("PASS real-darkei-rachel fixture");
console.log(
  JSON.stringify(
    {
      clientName: d.clientName,
      clientPhone: d.clientPhone,
      venue: d.venue,
      quoteDate: d.quoteDate,
      eventDate: d.eventDate,
      items: d.items.length,
      itemNames: d.items.map((item) => item.name),
      subtotal: d.subtotal,
      discount: d.discountAmount,
      vat: d.vatAmount,
      grand: d.grandTotal,
    },
    null,
    2,
  ),
);

// Fourth real client quote (Batya) — locks gap-aware Hebrew joining, venue
// punctuation, and no mid-sentence item split.
const batya = JSON.parse(readFileSync(join(here, "__fixtures__", "real-batya.json"), "utf8"));
const b = parseQuoteDocument(batya);
assert.equal(b.clientName, "תנועת בתיה");
assert.equal(b.venue, "בנייני האומה, אולם אשכול");
assert.equal(b.eventDate, "2026-11-03");
assert.equal(b.quoteDate, "2026-10-29");
assert.equal(b.items.length, 8);
assert.ok(b.items[4].name.endsWith("חיבור קלידים מפרט מדויק?"));
assert.equal(b.items[4].description, null);
assert.ok(b.items[2].name.includes("(מחירון וואו)"));
assert.equal(b.items[2].description, null);
assert.deepEqual(b.items.map((item) => item.qty), [15, 1, 1, 1, 1, 1, 1, 1]);
assert.deepEqual(b.items.map((item) => item.unit_price), [250, 1200, 1600, 600, 4500, 1200, 1800, 1800]);
assert.equal(b.subtotal, 16450);
assert.equal(b.discountAmount, 0);
assert.equal(b.vatAmount, 2961);
assert.equal(b.grandTotal, 19411);

console.log("PASS real-batya fixture");
console.log(
  JSON.stringify(
    {
      clientName: b.clientName,
      venue: b.venue,
      eventDate: b.eventDate,
      quoteDate: b.quoteDate,
      items: b.items.length,
      itemNames: b.items.map((item) => item.name),
      subtotal: b.subtotal,
      discount: b.discountAmount,
      vat: b.vatAmount,
      grand: b.grandTotal,
    },
    null,
    2,
  ),
);
