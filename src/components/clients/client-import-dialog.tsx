import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { dataApiToken } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import { num } from "@/lib/format";
import { notifyDataChanged } from "@/lib/data-events";
import { cn } from "@/lib/utils";
import type { Client } from "@/lib/types";

type TargetField = "name" | "contact_name" | "phone" | "email" | "company" | "address" | "tax_id" | "notes";
type Mapping = Record<TargetField, number | null>;
type Step = "upload" | "map" | "preview" | "importing" | "done";

type MappedRow = {
  rowNumber: number;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  address: string | null;
  tax_id: string | null;
  notes: string | null;
  valid: boolean;
  duplicate: boolean;
  duplicateId: string | null;
};

type ImportError = { row: number; name: string; reason: string };
type ImportResult = { added: number; updated: number; skipped: number; rejected: ImportError[] };

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const TEMPLATE_HEADERS = ["שם לקוח", "איש קשר", "טלפון", "אימייל", "חברה", "כתובת", "ח.פ / ת.ז", "הערות"];
const TEMPLATE_EXAMPLE = ["משפחת כהן", "דנה כהן", "050-1234567", "dana@example.co.il", "כהן הפקות", "רחוב הרצל 1, תל אביב", "512345678", "לקוח לדוגמה"];

const TARGET_FIELDS: { key: TargetField; label: string; required?: boolean }[] = [
  { key: "name", label: "שם לקוח", required: true },
  { key: "contact_name", label: "איש קשר" },
  { key: "phone", label: "טלפון" },
  { key: "email", label: "אימייל" },
  { key: "company", label: "חברה" },
  { key: "address", label: "כתובת" },
  { key: "tax_id", label: "ח.פ / ת.ז" },
  { key: "notes", label: "הערות" },
];

const FIELD_ALIASES: Record<TargetField, string[]> = {
  name: ["שם", "שם לקוח", "לקוח", "שם הלקוח", "name", "client", "client name", "customer", "company name"],
  contact_name: ["איש קשר", "שם איש קשר", "איש קשר ראשי", "contact", "contact person", "contact name"],
  phone: ["טלפון", "נייד", "פלאפון", "מס טלפון", "מס' טלפון", "phone", "mobile", "tel", "telephone", "cell"],
  email: ["אימייל", "דואל", "דוא\"ל", "מייל", "email", "e-mail", "mail"],
  company: ["חברה", "שם חברה", "חברה/עסק", "company", "business", "organization"],
  address: ["כתובת", "address", "street"],
  tax_id: [
    "ח.פ", "ת.ז", "ח.פ/ת.ז", "ח.פ.", "חפ", "תז", "ת\"ז", "מספר עוסק", "ע.מ", "עוסק מורשה", "מספר חברה", "מס' עוסק",
    "tax id", "taxid", "vat", "vat id", "vat number", "company number", "company id", "id number", "business id",
  ],
  notes: ["הערות", "הערה", "notes", "remarks", "comment", "comments"],
};

const EMPTY_MAPPING: Mapping = {
  name: null,
  contact_name: null,
  phone: null,
  email: null,
  company: null,
  address: null,
  tax_id: null,
  notes: null,
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'׳״]/g, "")
    .replace(/[\s\-_/\\.,:;()]+/g, "");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function nullIfEmpty(value: string): string | null {
  return value ? value : null;
}

function normalizeTaxId(value: string): string {
  return value.trim().replace(/^['\u2019]+/, "").trim();
}

const TAX_ID_CONTAINS_ALIASES = [
  "ח.פ", "ת.ז", "ח.פ/ת.ז", "מספר עוסק", "עוסק מורשה", "עוסק פטור", "מספר חברה",
  "tax id", "tax id number", "vat id", "vat number", "company number", "company id",
  "id number", "business number", "business id",
];

function detectMapping(headers: string[]): Mapping {
  const used = new Set<number>();
  const result: Mapping = { ...EMPTY_MAPPING };
  for (const field of TARGET_FIELDS) {
    const aliases = FIELD_ALIASES[field.key].map(normalizeHeader);
    const index = headers.findIndex((header, i) => !used.has(i) && aliases.includes(normalizeHeader(header)));
    if (index !== -1) {
      result[field.key] = index;
      used.add(index);
    }
  }
  // Tax-ID "contains" pass runs before the generic fields so a header like
  // "ח.פ של הלקוח" is not stolen by the name alias "לקוח".
  if (result.tax_id == null) {
    const aliases = TAX_ID_CONTAINS_ALIASES.map(normalizeHeader);
    const index = headers.findIndex(
      (header, i) => !used.has(i) && aliases.some((alias) => normalizeHeader(header).includes(alias)),
    );
    if (index !== -1) {
      result.tax_id = index;
      used.add(index);
    }
  }
  for (const field of TARGET_FIELDS) {
    if (field.key === "tax_id" || result[field.key] != null) continue;
    const aliases = FIELD_ALIASES[field.key].map(normalizeHeader);
    const index = headers.findIndex(
      (header, i) => !used.has(i) && aliases.some((alias) => normalizeHeader(header).includes(alias)),
    );
    if (index !== -1) {
      result[field.key] = index;
      used.add(index);
    }
  }
  // A file whose only name column is "שם חברה" / "חברה" / "Organization" gives
  // that column to `company` first; reuse it for `name` so the import is not
  // blocked. Each field reads its own column, so one column can feed both.
  if (result.name == null && result.company != null) {
    result.name = result.company;
  }
  return result;
}

function buildMappedRows(rows: string[][], mapping: Mapping, existing: Client[]): MappedRow[] {
  const byName = new Map<string, Client>();
  const byPhone = new Map<string, Client>();
  const byEmail = new Map<string, Client>();
  for (const client of existing) {
    byName.set(normalizeName(client.name), client);
    if (client.phone) {
      const phone = normalizePhone(client.phone);
      if (phone) byPhone.set(phone, client);
    }
    if (client.email) {
      const email = client.email.trim().toLowerCase();
      if (email) byEmail.set(email, client);
    }
  }
  return rows.map((row, index) => {
    const value = (field: TargetField) => {
      const column = mapping[field];
      return column == null ? "" : clean(row[column]);
    };
    const name = value("name");
    const phone = value("phone").replace(/[^\d+]/g, "");
    const email = value("email").trim().toLowerCase();
    const duplicate = phone
      ? byPhone.get(normalizePhone(phone))
      : email
        ? byEmail.get(email)
        : name
          ? byName.get(normalizeName(name))
          : undefined;
    return {
      rowNumber: index + 2,
      name,
      contact_name: nullIfEmpty(value("contact_name")),
      phone: nullIfEmpty(phone),
      email: nullIfEmpty(value("email")),
      company: nullIfEmpty(value("company")),
      address: nullIfEmpty(value("address")),
      tax_id: nullIfEmpty(normalizeTaxId(value("tax_id"))),
      notes: nullIfEmpty(value("notes")),
      valid: Boolean(name),
      duplicate: Boolean(duplicate),
      duplicateId: duplicate?.id ?? null,
    };
  });
}

function hebrewImportError(error: { message: string; code?: string }): string {
  const code = error.code ?? "";
  const message = error.message.toLowerCase();
  if (code === "42501" || message.includes("row-level security")) {
    return "אין הרשאה לייבא לקוחות. ודא שיש לך הרשאת עריכה למודול הלקוחות.";
  }
  if (code === "23502") return "שורה חסרה שדה חובה (שם לקוח).";
  if (code === "23505") return "לקוח כפול.";
  if (code === "PGRST204" || message.includes("column")) return "אחד השדות אינו קיים בטבלת הלקוחות.";
  return "שגיאה בייבוא השורות. בדוק את הנתונים ונסה שוב.";
}

function csvCell(value: string | number): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ClientImportDialog({
  open,
  onOpenChange,
  existingClients,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingClients: Client[];
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({ ...EMPTY_MAPPING });
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setStep("upload");
    setFileName("");
    setFileSize(0);
    setWorkbook(null);
    setSheetNames([]);
    setSelectedSheet("");
    setHeaders([]);
    setRows([]);
    setMapping({ ...EMPTY_MAPPING });
    setDragOver(false);
    setError(null);
    setProgress({ done: 0, total: 0 });
    setResult(null);
  }, [open]);

  function loadSheet(wb: XLSX.WorkBook, name: string) {
    const sheet = wb.Sheets[name];
    if (!sheet) {
      setError("הגליון שנבחר ריק.");
      return;
    }
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" }) as string[][];
    const cleaned = matrix
      .map((row) => row.map((cell) => clean(cell)))
      .filter((row) => row.some((cell) => cell !== ""));
    if (!cleaned.length) {
      setError("הגליון ריק.");
      return;
    }
    const headerRow = cleaned[0].map((header, index) => header || `עמודה ${index + 1}`);
    setHeaders(headerRow);
    setRows(cleaned.slice(1));
    setMapping(detectMapping(headerRow));
    setError(null);
  }

  async function parseFile(file: File) {
    setError(null);
    if (file.size > MAX_FILE_SIZE) {
      setError("הקובץ גדול מדי. הגודל המקסימלי הוא 10MB.");
      return;
    }
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["xlsx", "xls", "csv"].includes(extension)) {
      setError("סוג הקובץ אינו נתמך. יש לבחור קובץ אקסל (xlsx/xls) או CSV.");
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: false, raw: false });
      if (!wb.SheetNames.length) {
        setError("לא נמצאו גליונות בקובץ.");
        return;
      }
      setWorkbook(wb);
      setSheetNames(wb.SheetNames);
      setSelectedSheet(wb.SheetNames[0]);
      setFileName(file.name);
      setFileSize(file.size);
      loadSheet(wb, wb.SheetNames[0]);
      setStep("map");
    } catch {
      setError("לא הצלחנו לקרוא את הקובץ. ודא שהוא קובץ אקסל או CSV תקין.");
    }
  }

  function onSheetChange(name: string) {
    setSelectedSheet(name);
    if (workbook) loadSheet(workbook, name);
  }

  function updateMapping(field: TargetField, value: string) {
    setMapping((current) => ({ ...current, [field]: value === "" ? null : Number(value) }));
  }

  const mappedRows = useMemo(
    () => buildMappedRows(rows, mapping, existingClients),
    [rows, mapping, existingClients],
  );
  const validRows = mappedRows.filter((row) => row.valid);
  const invalidRows = mappedRows.filter((row) => !row.valid);
  const duplicateRows = mappedRows.filter((row) => row.valid && row.duplicate);
  const nameMapped = mapping.name != null;

  async function runImport() {
    if (importingRef.current) return;
    importingRef.current = true;
    const rejected: ImportError[] = invalidRows.map((row) => ({
      row: row.rowNumber,
      name: row.name || "—",
      reason: "חסר שם לקוח",
    }));
    setStep("importing");
    setProgress({ done: 0, total: validRows.length });
    try {
      const token = await dataApiToken();
      const response = await fetch("/api/clients/import", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          rows: validRows.map((row) => ({
            rowNumber: row.rowNumber,
            name: row.name,
            contact_name: row.contact_name,
            phone: row.phone,
            email: row.email,
            company: row.company,
            address: row.address,
            tax_id: row.tax_id,
            notes: row.notes,
          })),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const message =
          data?.message ||
          (response.status === 403
            ? "אין לך הרשאה לייבא לקוחות."
            : "הייבוא נכשל — לא נשמרו שינויים. נסה שוב.");
        setResult({ added: 0, updated: 0, skipped: 0, rejected: [...rejected, { row: 0, name: "—", reason: message }] });
        setStep("done");
        return;
      }
      setResult({
        added: Number(data.added) || 0,
        updated: Number(data.updated) || 0,
        skipped: Number(data.skipped) || 0,
        rejected: [...rejected, ...(Array.isArray(data.rejected) ? data.rejected : [])],
      });
      setProgress({ done: validRows.length, total: validRows.length });
      setStep("done");
      notifyDataChanged("clients");
      onImported();
    } catch {
      setResult({
        added: 0,
        updated: 0,
        skipped: 0,
        rejected: [...rejected, { row: 0, name: "—", reason: "לא הצלחנו להתחבר לשרת — נסה שוב." }],
      });
      setStep("done");
    } finally {
      importingRef.current = false;
    }
  }

  function downloadTemplate() {
    try {
      const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, "לקוחות");
      const data = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "תבנית-ייבוא-לקוחות.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("לא הצלחנו ליצור את התבנית. נסה שוב.");
    }
  }

  function downloadErrors() {
    if (!result?.rejected.length) return;
    const lines = [
      ["שורה", "שם לקוח", "סיבה"],
      ...result.rejected.map((item) => [String(item.row), item.name, item.reason]),
    ];
    const csv = "\uFEFF" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "שגיאות-ייבוא-לקוחות.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="ייבוא לקוחות מקובץ אקסל"
      description="ייבוא לקוחות מקובץ אקסל או CSV שיוצא ממערכת אחרת"
      size="xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {step === "upload" ? (
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>ביטול</Button>
          ) : null}
          {step === "map" ? (
            <>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep("upload")}>בחירת קובץ אחר</Button>
              <Button type="button" className="w-full sm:w-auto" disabled={!nameMapped} onClick={() => setStep("preview")}>המשך לתצוגה מקדימה</Button>
            </>
          ) : null}
          {step === "preview" ? (
            <>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep("map")}>חזרה למיפוי</Button>
              <Button type="button" className="w-full sm:w-auto" disabled={!validRows.length} onClick={runImport}>ייבוא {num(validRows.length)} לקוחות</Button>
            </>
          ) : null}
          {step === "importing" ? (
            <Button type="button" className="w-full sm:w-auto" disabled>מייבא…</Button>
          ) : null}
          {step === "done" ? (
            <>
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setStep("upload")}>טען קובץ נוסף</Button>
              <Button type="button" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>סיום</Button>
            </>
          ) : null}
        </div>
      }
    >
      {step === "upload" ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-accent/40 p-3 text-xs leading-relaxed text-accent-foreground">
            <p className="font-medium">איך זה עובד</p>
            <p className="mt-1">בוחרים קובץ אקסל או CSV, ממפים את העמודות, בודקים תצוגה מקדימה ואז מייבאים. לקוחות כפולים מזוהים לפי טלפון או שם.</p>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) parseFile(file);
            }}
            className={cn(
              "rounded-2xl border-2 border-dashed p-6 text-center transition-colors",
              dragOver ? "border-primary bg-accent/50" : "border-border bg-card",
            )}
          >
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <FileSpreadsheet className="size-6" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-foreground">גרור לכאן קובץ אקסל או CSV</p>
            <p className="mt-1 text-xs text-muted-foreground">או בחר קובץ מהמכשיר. עד 10MB.</p>
            <Button type="button" variant="outline" className="mt-4 h-11 w-full sm:w-auto" onClick={() => inputRef.current?.click()}>
              <Upload className="size-4" /> בחירת קובץ
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) parseFile(file);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              <Download className="size-4" /> הורדת תבנית אקסל
            </button>
            <p className="text-xs text-muted-foreground">התבנית כוללת את העמודות שהמערכת מזהה אוטומטית.</p>
          </div>
          {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </div>
      ) : null}

      {step === "map" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 p-3 text-xs">
            <span className="font-medium text-foreground">{fileName}</span>
            <span className="text-muted-foreground">{Math.max(1, Math.round(fileSize / 1024))} KB · {num(rows.length)} שורות</span>
          </div>

          {sheetNames.length > 1 ? (
            <Field label="גליון" htmlFor="import-sheet">
              <Select id="import-sheet" value={selectedSheet} onChange={(e) => onSheetChange(e.target.value)}>
                {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </Select>
            </Field>
          ) : null}

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">מיפוי עמודות</p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    <th className="px-3 py-2 text-start font-medium">שדה במערכת</th>
                    <th className="px-3 py-2 text-start font-medium">עמודה בקובץ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {TARGET_FIELDS.map((field) => (
                    <tr key={field.key}>
                      <td className="px-3 py-2 font-medium text-foreground">
                        {field.label}
                        {field.required ? <span className="text-red-600"> *</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        <Select
                          value={mapping[field.key] == null ? "" : String(mapping[field.key])}
                          onChange={(e) => updateMapping(field.key, e.target.value)}
                          aria-label={`מיפוי ${field.label}`}
                        >
                          <option value="">לא לייבא</option>
                          {headers.map((header, index) => (
                            <option key={`${header}-${index}`} value={index}>{header}</option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">תצוגה מקדימה (5 שורות ראשונות)</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    {headers.map((header, index) => (
                      <th key={`${header}-${index}`} className="whitespace-nowrap px-2 py-1.5 text-start font-medium">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.slice(0, 5).map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {headers.map((_, columnIndex) => (
                        <td key={columnIndex} className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{row[columnIndex] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-foreground">
              {nameMapped ? `${num(validRows.length)} לקוחות לייבוא` : "בחר עמודה לשם לקוח"}
            </span>
            <span className="text-muted-foreground">{num(invalidRows.length)} שורות לא תקינות</span>
          </div>

          {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </div>
      ) : null}

      {step === "preview" ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-muted/50 p-3 text-sm">
            <p className="font-medium text-foreground">
              {num(mappedRows.length)} שורות נקראו · {num(validRows.length)} תקינות · {num(duplicateRows.length)} כפולות · {num(invalidRows.length)} שגויות
            </p>
          </div>

          <div className="rounded-xl border border-border bg-accent/40 p-3 text-xs leading-relaxed text-accent-foreground">
            לקוחות קיימים (לפי טלפון, אימייל או שם) יעודכנו אוטומטית — שדות ריקים יושלמו וערכים שהשתנו יתעדכנו. לא ייווצרו כפילויות.
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-2 py-2 text-start font-medium">#</th>
                  <th className="px-2 py-2 text-start font-medium">שם לקוח</th>
                  <th className="px-2 py-2 text-start font-medium">איש קשר</th>
                  <th className="px-2 py-2 text-start font-medium">טלפון</th>
                  <th className="px-2 py-2 text-start font-medium">אימייל</th>
                  <th className="px-2 py-2 text-start font-medium">חברה</th>
                  <th className="px-2 py-2 text-start font-medium">כתובת</th>
                  {mapping.tax_id != null ? <th className="px-2 py-2 text-start font-medium">ח.פ / ת.ז</th> : null}
                  <th className="px-2 py-2 text-start font-medium">הערות</th>
                  <th className="px-2 py-2 text-start font-medium">סטטוס</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {mappedRows.slice(0, 20).map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-2 py-1.5 text-muted-foreground">{row.rowNumber}</td>
                    <td className="px-2 py-1.5 font-medium text-foreground">{row.name || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{row.contact_name || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground" dir="ltr">{row.phone || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground" dir="ltr">{row.email ?? "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{row.company || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{row.address || "—"}</td>
                    {mapping.tax_id != null ? <td className="px-2 py-1.5 text-muted-foreground" dir="ltr">{row.tax_id || "—"}</td> : null}
                    <td className="max-w-[180px] px-2 py-1.5 text-muted-foreground"><span className="line-clamp-2">{row.notes || "—"}</span></td>
                    <td className="px-2 py-1.5">
                      {!row.valid ? (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">שגוי</span>
                      ) : row.duplicate ? (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">קיים במערכת</span>
                      ) : (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">תקין</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mappedRows.length > 20 ? (
            <p className="text-xs text-muted-foreground">מוצגות 20 שורות מתוך {num(mappedRows.length)}.</p>
          ) : null}
        </div>
      ) : null}

      {step === "importing" ? (
        <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
          <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">מייבא… {num(progress.done)}/{num(progress.total)}</p>
          <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {step === "done" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="size-6" aria-hidden="true" />
            </div>
            <p className="text-lg font-bold text-foreground">הייבוא הסתיים</p>
            <p className="mt-1 text-sm text-muted-foreground">
              נוספו {num(result?.added ?? 0)} · עודכנו {num(result?.updated ?? 0)} · דולגו {num(result?.skipped ?? 0)}
            </p>
          </div>
          {result?.rejected.length ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" aria-hidden="true" /> {num(result.rejected.length)} שורות לא יובאו
              </p>
              <p className="mt-1 text-xs">אפשר להוריד דוח שגיאות מפורט ולנסות שוב.</p>
              <Button type="button" variant="outline" className="mt-3 h-11 w-full sm:w-auto" onClick={downloadErrors}>
                <Download className="size-4" /> הורדת דוח שגיאות
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
