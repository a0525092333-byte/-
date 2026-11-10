import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CalendarPlus, Copy, ExternalLink, FileText, Mail, Pencil, Printer } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useCompanySettings, useEvents, useQuote, useQuoteImages, useQuoteItems, useQuoteSections, useQuotes } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { ErrorState, LtrText, NoAccess, PageSkeleton, StatusPill } from "@/components/shared";
import { sameDisplayName, todayISO } from "@/lib/format";
import {
  QUOTE_STATUS_LABELS,
  computeQuoteTotals,
  dateShortYY,
  money0,
  money2,
  nextQuoteNumber,
  quoteIssueDate,
  quoteItemLineTotal,
  quoteItemQuantity,
  quoteTermsText,
  splitLines,
  weekdayLetter,
} from "@/lib/quotes";
import { QuoteEmailDialog } from "@/components/quotes/quote-email-dialog";
import { PaperlessIssueDialog } from "@/components/quotes/paperless-issue-dialog";

export const Route = createFileRoute("/_app/quotes/$id_/print")({ component: QuotePrintPage });

function QuotePrintPage() {
  const { id } = Route.useParams();
  const { user, profile, can, isAdmin } = useSession();
  const navigate = useNavigate();
  const canView = can("quotes");
  const canEdit = can("quotes", "edit");
  const canCreateEvent = canEdit && can("clients", "edit");
  const quoteQ = useQuote(id);
  const itemsQ = useQuoteItems(id);
  const imagesQ = useQuoteImages(id);
  const sectionsQ = useQuoteSections(id);
  const settingsQ = useCompanySettings(true);
  const quotesQ = useQuotes(canEdit);
  const clientsQ = useClients(canView);
  const eventsQ = useEvents(canView);
  const [busy, setBusy] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [paperlessOpen, setPaperlessOpen] = useState(false);

  const quote = quoteQ.data;
  const items = itemsQ.data ?? [];
  const images = imagesQ.data ?? [];
  const sections = sectionsQ.data ?? [];
  const settings = settingsQ.data;
  const quotes = quotesQ.data ?? [];
  const client = (clientsQ.data ?? []).find((c) => c.id === quote?.client_id) ?? null;
  const event = (eventsQ.data ?? []).find((e) => e.id === quote?.event_id) ?? null;
  const eventAddress = quote?.event_address?.trim() || event?.address || null;

  const totals = useMemo(
    () =>
      computeQuoteTotals(
        items,
        quote?.discount_type ?? "percent",
        quote?.discount_value ?? 0,
        quote?.vat_rate ?? 18,
      ),
    [items, quote?.discount_type, quote?.discount_value, quote?.vat_rate],
  );

  const termsText = quote ? quoteTermsText(quote) : "";
  const termLines = splitLines(termsText);
  const noteLines = splitLines(quote?.notes);
  const issueDate = quote ? quoteIssueDate(quote) : "";

  if (!canView) return <NoAccess moduleLabel="מודול הצעות המחיר" />;
  if (quoteQ.isLoading || itemsQ.isLoading || imagesQ.isLoading || sectionsQ.isLoading) return <PageSkeleton />;
  if (quoteQ.error || itemsQ.error || sectionsQ.error) {
    return (
      <ErrorState
        message="לא הצלחנו לטעון את ההצעה. נסה שוב."
        onRetry={() => {
          quoteQ.refetch();
          itemsQ.refetch();
          sectionsQ.refetch();
        }}
      />
    );
  }
  if (!quote) return <ErrorState message="ההצעה לא נמצאה." onRetry={() => quoteQ.refetch()} />;

  async function duplicateQuote() {
    if (!quote) return;
    setBusy(true);
    const newId = crypto.randomUUID();
    const newNumber = nextQuoteNumber(quotes.map((item) => item.quote_number), settings?.quote_number_prefix ?? "");
    const { error } = await db.from("quotes").insert({
      id: newId,
      quote_number: newNumber,
      client_id: quote.client_id,
      client_name: quote.client_name,
      client_address: quote.client_address,
      venue: quote.venue,
      subject: quote.subject,
      event_id: null,
      event_date: quote.event_date,
      quote_date: todayISO(),
      issue_date: todayISO(),
      valid_until: quote.valid_until,
      print_date: todayISO(),
      currency: "ILS",
      status: "draft",
      discount_type: quote.discount_type,
      discount_value: quote.discount_value,
      vat_rate: quote.vat_rate,
      notes: quote.notes,
      terms: quote.terms,
      terms_text: quote.terms_text,
      subtotal: totals.subtotal,
      discount_amount: totals.discountAmount,
      total_before_vat: totals.afterDiscount,
      vat_amount: totals.vatAmount,
      grand_total: totals.grandTotal,
      created_by: user?.id ?? null,
    });
    if (error) {
      setBusy(false);
      toast.error("לא הצלחנו לשכפל את ההצעה");
      return;
    }
    const sectionMap = new Map<string, string>();
    const newSections = sections.map((section, index) => {
      const sectionId = crypto.randomUUID();
      sectionMap.set(section.id, sectionId);
      return {
        id: sectionId,
        quote_id: newId,
        name: section.name,
        sort_order: index,
        show_section_totals: section.show_section_totals,
      };
    });
    if (newSections.length) {
      const { error: sectionError } = await db.from("quote_sections").insert(newSections);
      if (sectionError) {
        setBusy(false);
        toast.error("לא הצלחנו לשכפל את ההצעה");
        return;
      }
    }
    const newItems = items.map((item, index) => ({
      id: crypto.randomUUID(),
      quote_id: newId,
      section_id: item.section_id ? sectionMap.get(item.section_id) ?? null : null,
      sort_order: index,
      name: item.name,
      description: item.description,
      qty: quoteItemQuantity(item),
      quantity: quoteItemQuantity(item),
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: quoteItemLineTotal(item),
      is_optional: item.is_optional,
    }));
    if (newItems.length) {
      const { error: itemError } = await db.from("quote_items").insert(newItems);
      if (itemError) {
        setBusy(false);
        toast.error("לא הצלחנו לשכפל את ההצעה");
        return;
      }
    }
    setBusy(false);
    toast.success("ההצעה שוכפלה כהצעה עצמאית ללא שיוך לאירוע");
    navigate({ to: "/quotes/$id", params: { id: newId } });
  }

  async function createEvent() {
    if (!quote || quote.status !== "approved" || quote.event_id) return;
    setBusy(true);
    const { data, error } = await db
      .from<{ id: string }>("events")
      .insert({
        title: quote.subject || quote.venue || `אירוע ${quote.quote_number}`,
        client_id: quote.client_id,
        event_type: "אחר",
        event_date: quote.event_date || todayISO(),
        venue: quote.venue,
        address: quote.client_address,
        status: "נסגר",
        sales_rep_id: user?.id ?? null,
        sales_rep_name: profile?.full_name ?? null,
        notes: quote.notes,
        total_amount: totals.grandTotal,
      })
      .select("id")
      .single();
    if (error || !data?.id) {
      setBusy(false);
      toast.error("לא הצלחנו ליצור אירוע מההצעה");
      return;
    }
    await db.from("quotes").update({ event_id: data.id }).eq("id", quote.id);
    setBusy(false);
    toast.success("האירוע נוצר");
    navigate({ to: "/events/$id", params: { id: data.id } });
  }

  return (
    <div>
      <div className="print-hidden mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="outline">
          <Link to="/quotes"><ArrowRight className="size-4" /> חזרה להצעות</Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={QUOTE_STATUS_LABELS[quote.status]} />
          {canEdit ? (
            <Button asChild variant="outline">
              <Link to="/quotes/$id" params={{ id: quote.id }}><Pencil className="size-4" /> עריכה</Link>
            </Button>
          ) : null}
          <Button type="button" onClick={() => setEmailOpen(true)} disabled={!canEdit}>
            <Mail className="size-4" /> שלח הצעה ללקוח במייל
          </Button>
          {canEdit ? (
            <Button type="button" variant="outline" onClick={() => setPaperlessOpen(true)}>
              <FileText className="size-4" /> הפק מסמך ב-Paperless
            </Button>
          ) : null}
          {(quote as { paperless_url?: string | null }).paperless_url ? (
            <Button asChild variant="outline">
              <a href={(quote as { paperless_url?: string | null }).paperless_url ?? "#"} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> צפה בחשבונית {(quote as { paperless_document_number?: string | null }).paperless_document_number ?? ""}
              </a>
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" /> הדפסה / PDF
          </Button>
          {canEdit ? (
            <Button type="button" variant="outline" onClick={duplicateQuote} disabled={busy || quotesQ.isLoading}>
              <Copy className="size-4" /> שכפול
            </Button>
          ) : null}
          {canCreateEvent && quote.status === "approved" && !quote.event_id ? (
            <Button type="button" onClick={createEvent} disabled={busy}>
              <CalendarPlus className="size-4" /> צור אירוע מהצעה
            </Button>
          ) : null}
          {quote.event_id ? (
            <Button asChild variant="outline">
              <Link to="/events/$id" params={{ id: quote.event_id }}>פתח אירוע</Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="quote-document mx-auto max-w-[210mm] bg-white p-6 text-black shadow-sm sm:p-10 print:max-w-none print:p-0 print:shadow-none">
        <div className="border-b-2 border-black pb-3">
          <div className="flex justify-center">
            {settings?.logo_url ? (
              <img src={settings.logo_url} alt="" className="brand-logo-print-lg" />
            ) : (
              <img src="/brand/logo-print.png" alt="" className="brand-logo-print-lg" />
            )}
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="text-start">
              <h1 className="text-xl font-bold">{settings?.company_name || "נס מולטימדיה"}</h1>
              <div className="mt-1 space-y-0.5 text-xs text-gray-700">
                {settings?.tax_id ? <p>ח.פ/ע.מ: {settings.tax_id}</p> : null}
                {settings?.phone ? <p dir="ltr">{settings.phone}</p> : null}
                {settings?.email ? <p dir="ltr">{settings.email}</p> : null}
              </div>
            </div>
            <div className="text-start sm:text-end">
              <p className="text-lg font-bold">הצעת מחיר מס׳ {quote.quote_number}</p>
              <p className="mt-1 text-sm">תאריך הצעה: {dateShortYY(issueDate)}</p>
              <p className="text-sm">תאריך הדפסה: {dateShortYY(quote.print_date ?? todayISO())}</p>
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-1 text-sm">
          <p><span className="font-semibold">לכבוד:</span> {quote.client_name}</p>
          {quote.venue ? <p><span className="font-semibold">{quote.venue.trim().startsWith("ב") ? "עבור אירוע " : "עבור אירוע ב"}</span>{quote.venue.trim()}</p> : null}
          {eventAddress ? <p><span className="font-semibold">כתובת האירוע:</span> {eventAddress}</p> : null}
          {quote.client_address ? <p><span className="font-semibold">כתובת הלקוח:</span> {quote.client_address}</p> : null}
          {quote.event_date ? (
            <p><span className="font-semibold">בתאריך:</span> יום {weekdayLetter(quote.event_date)}, {dateShortYY(quote.event_date)}</p>
          ) : null}
          {quote.event_contact_name ? (
            <p>
              <span className="font-semibold">איש קשר באירוע:</span> {quote.event_contact_name}
              {quote.event_contact_phone ? <> · <span dir="ltr">{quote.event_contact_phone}</span></> : null}
            </p>
          ) : null}
          {quote.subject && !sameDisplayName(quote.subject, quote.client_name) ? <p><span className="font-semibold">נושא:</span> {quote.subject}</p> : null}
        </div>

        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-black bg-gray-100">
              <th className="w-8 px-2 py-2 text-start">מס׳</th>
              <th className="px-2 py-2 text-start">פריט / תיאור</th>
              <th className="w-28 px-2 py-2 text-start">מחיר ליחידה</th>
              <th className="w-20 px-2 py-2 text-start">כמות</th>
              <th className="w-32 px-2 py-2 text-start">סכום לפני מע״מ</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id} className="border-b border-gray-200 align-top">
                <td className="px-2 py-2 text-xs text-gray-600">{index + 1}</td>
                <td className="px-2 py-2">
                  {item.name ? <p className="font-medium"><LtrText>{item.name}</LtrText></p> : null}
                  {splitLines(item.description).map((line, lineIndex) => (
                    <p key={lineIndex} className="mt-0.5 text-xs text-gray-600"><LtrText>{line}</LtrText></p>
                  ))}
                  {item.is_optional ? <p className="mt-0.5 text-[10px] text-gray-500">אופציונלי</p> : null}
                </td>
                <td className="num px-2 py-2 text-xs">{money2(item.unit_price)}</td>
                <td className="px-2 py-2 text-xs">{quoteItemQuantity(item)} {item.unit ?? ""}</td>
                <td className="num px-2 py-2 text-xs font-medium">{money2(quoteItemLineTotal(item))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {images.length ? (
          <div className="mt-6">
            <h2 className="mb-2 text-base font-bold">תמונות</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {images.map((image) => (
                <figure key={image.id} className="break-inside-avoid">
                  <img
                    src={image.data_url}
                    alt={image.caption ?? ""}
                    className="w-full rounded border border-gray-200 object-contain"
                  />
                  {image.caption ? <figcaption className="mt-1 text-xs text-gray-600">{image.caption}</figcaption> : null}
                </figure>
              ))}
            </div>
          </div>
        ) : null}

        <div className="quote-totals mt-4 flex justify-end">
          <table className="w-full max-w-sm text-sm">
            <tbody>
              <tr>
                <td className="py-1 text-gray-700">סך הכול לפני הנחה</td>
                <td className="num py-1 text-end">{money2(totals.subtotal)}</td>
              </tr>
              {totals.discountAmount > 0 ? (
                <tr>
                  <td className="py-1 text-gray-700">
                    הנחה {quote.discount_type === "percent" ? `${Number(quote.discount_value)}%` : ""}
                  </td>
                  <td className="num py-1 text-end">{money2(totals.discountAmount)}</td>
                </tr>
              ) : null}
              <tr>
                <td className="py-1 text-gray-700">מחיר לפני מע״מ</td>
                <td className="num py-1 text-end">{money2(totals.afterDiscount)}</td>
              </tr>
              <tr>
                <td className="py-1 text-gray-700">מע״מ {Number(quote.vat_rate)}%</td>
                <td className="num py-1 text-end">{money2(totals.vatAmount)}</td>
              </tr>
              <tr className="border-t-2 border-black">
                <td className="py-2 font-bold">סה״כ לתשלום</td>
                <td className="num py-2 text-end font-bold">{money0(totals.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {noteLines.length ? (
          <div className="mt-6">
            <h2 className="mb-2 text-base font-bold">הערות</h2>
            <div className="space-y-1 text-sm">
              {noteLines.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          </div>
        ) : null}

        {termLines.length ? (
          <div className="mt-6">
            <h2 className="mb-2 text-base font-bold">תנאים / הסכם</h2>
            <ol className="list-decimal space-y-1 pe-5 text-sm">
              {termLines.map((line, index) => (
                <li key={index}>{line.replace(/^\s*(?:\.?\d+\s*[.)]?\s*)+/, "")}</li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          <div>
            <p className="text-sm font-semibold">המזמין</p>
            <div className="mt-8 border-t border-black pt-1 text-xs text-gray-600">חתימה :</div>
            <div className="mt-6 border-t border-black pt-1 text-xs text-gray-600">תאריך :</div>
          </div>
          <div>
            <p className="text-sm font-semibold">{settings?.company_name || "החברה"}</p>
            {settings?.address ? <p className="mt-0.5 text-xs text-gray-600">{settings.address}</p> : null}
            <div className="mt-8 border-t border-black pt-1 text-xs text-gray-600">חתימה :</div>
            <div className="mt-6 border-t border-black pt-1 text-xs text-gray-600">תאריך :</div>
          </div>
        </div>
      </div>

      <QuoteEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        quote={quote}
        defaultEmail={client?.email ?? ""}
      />
      <PaperlessIssueDialog
        open={paperlessOpen}
        onOpenChange={setPaperlessOpen}
        quote={quote}
        onIssued={() => {
          quoteQ.refetch();
          quotesQ.refetch();
        }}
      />
    </div>
  );
}
