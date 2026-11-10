import { useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { FloatingWindow } from "@/components/floating-window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select } from "@/components/ui/controls";
import { LtrText } from "@/components/shared";
import { useSession } from "@/hooks/use-session";
import { useCompanySettings } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { createClient, findClientByName } from "@/lib/clients";
import { saveQuote } from "@/lib/quote-save";
import { computeQuoteTotals, money2, nextQuoteNumber } from "@/lib/quotes";
import { todayISO } from "@/lib/format";
import { parseQuoteDocument, type ParsedQuote } from "@/lib/quote-import/parse";
import { notifyDataChanged } from "@/lib/data-events";
import { cn } from "@/lib/utils";
import type { Client } from "@/lib/types";

type FormState = {
  clientName: string;
  venue: string;
  eventDate: string;
  quoteDate: string;
  quoteNumber: string;
  discountType: "percent" | "amount";
  discountValue: string;
  vatRate: string;
};

function emptyForm(): FormState {
  return {
    clientName: "",
    eventDate: "",
    venue: "",
    quoteDate: "",
    quoteNumber: "",
    discountType: "percent",
    discountValue: "0",
    vatRate: "18",
  };
}

export function QuoteImportButton() {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  if (!can("quotes", "edit")) return null;
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileUp className="size-4" />
        ייבוא הצעה קיימת
      </Button>
      <QuoteImportWindow open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function QuoteImportWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, can } = useSession();
  const settingsQ = useCompanySettings(open);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();
  const [parsed, setParsed] = useState<ParsedQuote | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [duplicatePrompt, setDuplicatePrompt] = useState(false);
  const [success, setSuccess] = useState<{ eventId: string; quoteNumber: string } | null>(null);
  const canFinance = can("finance", "view");

  const totals = useMemo(() => {
    if (!parsed) return null;
    return computeQuoteTotals(
      parsed.items.map((item) => ({ qty: item.qty, unit_price: item.unit_price })),
      form.discountType,
      Number(form.discountValue) || 0,
      Number(form.vatRate) || 0,
    );
  }, [parsed, form.discountType, form.discountValue, form.vatRate]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setParsed(null);
    setForm(emptyForm());
    setError(null);
    setBusy(false);
    setDragOver(false);
    setRawOpen(false);
    setDuplicatePrompt(false);
    setSuccess(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function close() {
    reset();
    onClose();
  }

  async function handleFile(file: File) {
    setError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("יש להעלות קובץ PDF");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("הקובץ גדול מדי — עד 15MB");
      return;
    }
    setBusy(true);
    try {
      const { extractPdfLines, hasExtractableText } = await import("@/lib/quote-import/extract");
      const lines = await extractPdfLines(file);
      if (!lines.length || !hasExtractableText(lines)) {
        setError("הקובץ סרוק ואין בו טקסט לפענוח — יש להעלות PDF דיגיטלי");
        return;
      }
      const result = parseQuoteDocument(lines);
      setParsed(result);
      setForm({
        clientName: result.clientName ?? "",
        venue: result.venue ?? "",
        eventDate: result.eventDate ?? "",
        quoteDate: result.quoteDate ?? todayISO(),
        quoteNumber: result.quoteNumber ?? "",
        discountType: result.discountType,
        discountValue: String(result.discountValue || 0),
        vatRate: String(result.vatRate ?? 18),
      });
    } catch {
      setError("לא הצלחנו לקרוא את הקובץ — נסה PDF אחר");
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport(force = false) {
    if (!parsed) return;
    if (!form.clientName.trim()) {
      setError("נא להזין שם לקוח");
      return;
    }
    if (!form.quoteDate) {
      setError("נא להזין תאריך הצעה");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const eventDate = form.eventDate || form.quoteDate;
      const { data: clientRows } = await db.from<Client[]>("clients").select("id,name").limit(5000);
      const existingClient = findClientByName(clientRows ?? [], form.clientName.trim());
      if (!force && existingClient) {
        const { data: sameEvents } = await db
          .from<{ id: string }[]>("events")
          .select("id")
          .eq("client_id", existingClient.id)
          .eq("event_date", eventDate);
        const eventIds = (sameEvents ?? []).map((row) => row.id);
        if (eventIds.length) {
          const { data: existingQuotes } = await db
            .from<{ id: string }[]>("quotes")
            .select("id")
            .in("event_id", eventIds);
          if ((existingQuotes ?? []).length) {
            setDuplicatePrompt(true);
            setBusy(false);
            return;
          }
        }
      }

      const client = await createClient({ name: form.clientName.trim(), phone: parsed.clientPhone, address: parsed.clientAddress });
      if (client.error || !client.id) throw new Error(client.error?.message || "client");

      const eventId = crypto.randomUUID();
      const { error: eventError } = await db.from("events").insert({
        id: eventId,
        title: form.clientName.trim(),
        client_id: client.id,
        event_type: "אחר",
        event_date: eventDate,
        start_date: eventDate,
        end_date: eventDate,
        venue: form.venue.trim() || null,
        address: parsed.eventAddress ?? null,
        guest_count: parsed.guestCount ?? null,
        status: "ממתין לסגירה",
        sales_rep_id: profile?.id ?? null,
        sales_rep_name: profile?.full_name ?? null,
        total_amount: 0,
        notes: parsed.notes ?? null,
      });
      if (eventError) throw new Error(eventError.message);

      const { data: quoteRows } = await db.from<{ quote_number: string }[]>("quotes").select("quote_number");
      const existingNumbers = (quoteRows ?? []).map((row) => row.quote_number);
      let quoteNumber = form.quoteNumber.trim();
      let numberWarning = false;
      if (!quoteNumber || existingNumbers.includes(quoteNumber)) {
        quoteNumber = nextQuoteNumber(existingNumbers, settingsQ.data?.quote_number_prefix ?? "");
        numberWarning = true;
      }

      const sectionRows = parsed.sections.map((section, index) => ({
        id: crypto.randomUUID(),
        name: section.name,
        sort_order: index,
        show_section_totals: true,
      }));
      const itemRows = parsed.items.map((item, index) => ({
        id: crypto.randomUUID(),
        section_id: sectionRows[item.sectionIndex]?.id ?? sectionRows[0]?.id ?? null,
        sort_order: index,
        name: item.name,
        description: item.description,
        qty: item.qty,
        quantity: item.qty,
        unit: item.unit,
        unit_price: item.unit_price,
        line_total: item.line_total,
        is_optional: false,
      }));
      const computed = computeQuoteTotals(
        parsed.items.map((item) => ({ qty: item.qty, unit_price: item.unit_price })),
        form.discountType,
        Number(form.discountValue) || 0,
        Number(form.vatRate) || 0,
      );
      const result = await saveQuote({
        quote: {
          id: crypto.randomUUID(),
          quote_number: quoteNumber,
          client_id: client.id,
          client_name: form.clientName.trim(),
          client_address: parsed.clientAddress ?? null,
          venue: form.venue.trim() || null,
          subject: null,
          event_id: eventId,
          event_date: form.eventDate || null,
          quote_date: form.quoteDate,
          issue_date: form.quoteDate,
          valid_until: null,
          print_date: todayISO(),
          currency: "ILS",
          status: "draft",
          discount_type: form.discountType,
          discount_value: Number(form.discountValue) || 0,
          vat_rate: Number(form.vatRate) || 0,
          notes: parsed.notes ?? null,
          terms: (parsed.terms ?? "").split("\n").map((term) => term.trim()).filter(Boolean),
          terms_text: parsed.terms ?? null,
          subtotal: computed.subtotal,
          discount_amount: computed.discountAmount,
          total_before_vat: computed.afterDiscount,
          vat_amount: computed.vatAmount,
          grand_total: computed.grandTotal,
        },
        sections: sectionRows,
        items: itemRows,
      });
      if (!result.ok) throw new Error(result.message);

      notifyDataChanged(["events", "quotes", "clients"]);
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["quotes"] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      setSuccess({ eventId, quoteNumber });
      if (numberWarning) toast.warning("מספר ההצעה היה תפוס — הוקצה מספר חדש");
      toast.success(`נוצרו אירוע והצעת מחיר מס' ${quoteNumber}`);
    } catch {
      setError("לא הצלחנו ליצור את האירוע וההצעה. נסה שוב.");
    } finally {
      setBusy(false);
    }
  }

  const warned = (field: string) => Boolean(parsed?.warnings.some((warning) => warning.includes(field)));

  return (
    <FloatingWindow open={open} onClose={close} title="סוכן ייבוא הצעות" storageKey="vincen:quote-import">
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {success ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                נוצרו אירוע והצעת מחיר מס' <span className="font-semibold">{success.quoteNumber}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate({ to: "/events/$id", params: { id: success.eventId } });
                  }}
                >
                  פתח את האירוע
                </Button>
                <Button type="button" variant="outline" onClick={reset}>
                  ייבוא הצעה נוספת
                </Button>
              </div>
            </div>
          ) : !parsed ? (
            <div className="space-y-3">
              <div
                data-no-drag
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  const file = event.dataTransfer.files?.[0];
                  if (file) void handleFile(file);
                }}
                className={cn(
                  "relative flex touch-manipulation flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border-2 border-dashed p-8 text-center transition-colors",
                  dragOver ? "border-primary bg-accent/40" : "border-border bg-card",
                )}
              >
                <input
                  id={fileInputId}
                  ref={inputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  aria-label="בחירת קובץ PDF"
                  disabled={busy}
                  className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void handleFile(file);
                  }}
                />
                <div className="pointer-events-none flex flex-col items-center justify-center gap-3">
                  {busy ? <Loader2 className="size-8 animate-spin text-muted-foreground" /> : <Upload className="size-8 text-muted-foreground" />}
                  <div>
                    <p className="text-sm font-semibold text-foreground">גרירת קובץ PDF לכאן</p>
                    <p className="mt-1 text-xs text-muted-foreground">קובץ אחד, עד 15MB</p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none inline-flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border bg-background px-4 text-sm font-medium text-foreground shadow-xs"
                  >
                    בחירת קובץ
                  </span>
                </div>
              </div>
              {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="שם לקוח" htmlFor="qi-client" error={warned("שם לקוח") ? "לא זוהה — נא להשלים" : null}>
                  <Input id="qi-client" value={form.clientName} onChange={(event) => set("clientName", event.target.value)} className={cn("h-11", warned("שם לקוח") && "border-red-400")} />
                </Field>
                <Field label="מקום האירוע" htmlFor="qi-venue" error={warned("מקום האירוע") ? "לא זוהה — נא להשלים" : null}>
                  <Input id="qi-venue" value={form.venue} onChange={(event) => set("venue", event.target.value)} className={cn("h-11", warned("מקום האירוע") && "border-red-400")} />
                </Field>
                <Field label="תאריך האירוע" htmlFor="qi-event-date" error={warned("תאריך האירוע") ? "לא זוהה — נא להשלים" : null}>
                  <Input id="qi-event-date" type="date" value={form.eventDate} onChange={(event) => set("eventDate", event.target.value)} className={cn("h-11", warned("תאריך האירוע") && "border-red-400")} />
                </Field>
                <Field label="תאריך הצעה" htmlFor="qi-quote-date" hint="אם לא יוזן תאריך אירוע — האירוע ייווצר בתאריך ההצעה" error={warned("תאריך ההצעה") ? "לא זוהה — נא להשלים" : null}>
                  <Input id="qi-quote-date" type="date" value={form.quoteDate} onChange={(event) => set("quoteDate", event.target.value)} className={cn("h-11", warned("תאריך ההצעה") && "border-red-400")} />
                </Field>
                <Field label="מספר הצעה" htmlFor="qi-number" error={warned("מספר הצעה") ? "לא זוהה — יוקצה מספר חדש" : null}>
                  <Input id="qi-number" value={form.quoteNumber} onChange={(event) => set("quoteNumber", event.target.value)} className={cn("h-11", warned("מספר הצעה") && "border-red-400")} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="סוג הנחה" htmlFor="qi-discount-type">
                    <Select id="qi-discount-type" value={form.discountType} onChange={(event) => set("discountType", event.target.value as FormState["discountType"])}>
                      <option value="percent">אחוז</option>
                      <option value="amount">סכום</option>
                    </Select>
                  </Field>
                  <Field label="הנחה" htmlFor="qi-discount-value">
                    <Input id="qi-discount-value" type="number" min={0} step="any" inputMode="decimal" value={form.discountValue} onChange={(event) => set("discountValue", event.target.value)} className="h-11" />
                  </Field>
                </div>
                <Field label='מע"מ %' htmlFor="qi-vat">
                  <Input id="qi-vat" type="number" min={0} step="any" inputMode="decimal" value={form.vatRate} onChange={(event) => set("vatRate", event.target.value)} className="h-11" />
                </Field>
              </div>

              <div className="rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <p className="text-sm font-semibold text-foreground">{parsed.items.length} פריטים</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground">
                        <th className="px-3 py-2 text-start font-medium">שם</th>
                        <th className="px-3 py-2 text-start font-medium">תיאור</th>
                        <th className="px-3 py-2 text-start font-medium">כמות</th>
                        <th className="px-3 py-2 text-start font-medium">יחידה</th>
                        {canFinance ? <th className="px-3 py-2 text-start font-medium">מחיר ליחידה</th> : null}
                        {canFinance ? <th className="px-3 py-2 text-start font-medium">סכום</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.items.map((item, index) => (
                        <tr key={`${item.name}-${index}`} className="border-t border-border/60">
                          <td className="px-3 py-2 font-medium text-foreground"><LtrText>{item.name}</LtrText></td>
                          <td className="px-3 py-2 text-muted-foreground"><LtrText>{item.description ?? "—"}</LtrText></td>
                          <td className="px-3 py-2 text-muted-foreground">{item.qty}</td>
                          <td className="px-3 py-2 text-muted-foreground">{item.unit ?? "—"}</td>
                          {canFinance ? <td className="px-3 py-2 text-muted-foreground">{money2(item.unit_price)}</td> : null}
                          {canFinance ? <td className="px-3 py-2 text-muted-foreground">{money2(item.line_total)}</td> : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {canFinance && totals ? (
                  <div className="space-y-1 border-t border-border px-3 py-2 text-sm">
                    <div className="flex justify-between text-muted-foreground"><span>ביניים</span><span>{money2(totals.subtotal)}</span></div>
                    {totals.discountAmount > 0 ? (
                      <div className="flex justify-between text-muted-foreground"><span>הנחה</span><span>{money2(totals.discountAmount)}</span></div>
                    ) : null}
                    <div className="flex justify-between text-muted-foreground"><span>מע"מ</span><span>{money2(totals.vatAmount)}</span></div>
                    <div className="flex justify-between font-semibold text-foreground"><span>סה"כ לתשלום</span><span>{money2(totals.grandTotal)}</span></div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-border bg-card">
                <button
                  type="button"
                  onClick={() => setRawOpen((value) => !value)}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-foreground"
                >
                  <span>הטקסט שזוהה</span>
                  <span className="text-xs text-muted-foreground">{rawOpen ? "הסתרה" : "הצגה"}</span>
                </button>
                {rawOpen ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs text-muted-foreground" dir="rtl">
                    {parsed.rawText}
                  </pre>
                ) : null}
              </div>

              {parsed.warnings.length ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {parsed.warnings.join(" · ")}
                </div>
              ) : null}

              {duplicatePrompt ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <p>קיים כבר אירוע עם הצעת מחיר ללקוח זה בתאריך האירוע. ליצור אירוע נוסף בכל זאת?</p>
                  <div className="mt-2 flex gap-2">
                    <Button type="button" size="sm" onClick={() => { setDuplicatePrompt(false); void confirmImport(true); }} disabled={busy}>
                      המשך בכל זאת
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setDuplicatePrompt(false)} disabled={busy}>
                      ביטול
                    </Button>
                  </div>
                </div>
              ) : null}

              {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
            </div>
          )}
        </div>

        {!success ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-4 py-3">
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              ביטול
            </Button>
            {parsed ? (
              <Button type="button" onClick={() => void confirmImport(false)} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                צור אירוע והצעה
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </FloatingWindow>
  );
}
