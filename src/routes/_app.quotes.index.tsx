import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Copy, FileText, Plus, Printer, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useAllQuoteItems, useClients, useQuotes } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { ConfirmDialog } from "@/components/ui/overlay";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClientPicker } from "@/components/clients/client-picker";
import { clientPickerCopy } from "@/content/client-picker";
import { Select } from "@/components/ui/controls";
import { num, todayISO } from "@/lib/format";
import {
  QUOTE_STATUS_LABELS,
  QUOTE_STATUS_OPTIONS,
  computeQuoteTotals,
  dateShortYY,
  money0,
  nextQuoteNumber,
  quoteItemLineTotal,
  quoteItemQuantity,
} from "@/lib/quotes";
import type { Quote, QuoteItem, QuoteSection, QuoteStatus } from "@/lib/types";

export const Route = createFileRoute("/_app/quotes/")({ component: QuotesListPage });

function QuotesListPage() {
  const { user, can, isAdmin } = useSession();
  const navigate = useNavigate();
  const canView = can("quotes");
  const canEdit = can("quotes", "edit");
  const quotesQ = useQuotes(canView);
  const itemsQ = useAllQuoteItems(canView);
  const clientsQ = useClients(canView);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | QuoteStatus>("all");
  const [clientId, setClientId] = useState("all");
  const [month, setMonth] = useState("");
  const [deleting, setDeleting] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);

  const quotes = quotesQ.data ?? [];
  const items = itemsQ.data ?? [];
  const clients = clientsQ.data ?? [];

  const grandTotal = (quote: Quote) =>
    quote.grand_total != null
      ? Number(quote.grand_total)
      : computeQuoteTotals(
          items.filter((item) => item.quote_id === quote.id),
          quote.discount_type,
          quote.discount_value,
          quote.vat_rate,
        ).grandTotal;

  const filtered = useMemo(
    () =>
      quotes.filter((quote) => {
        const query = search.trim().toLowerCase();
        if (query && !`${quote.quote_number} ${quote.client_name} ${quote.venue ?? ""}`.toLowerCase().includes(query)) {
          return false;
        }
        if (status !== "all" && quote.status !== status) return false;
        if (clientId !== "all" && quote.client_id !== clientId) return false;
        if (month && !(quote.event_date ?? "").startsWith(month)) return false;
        return true;
      }),
    [quotes, search, status, clientId, month],
  );

  if (!canView) return <NoAccess moduleLabel="מודול הצעות המחיר" />;
  if (quotesQ.isLoading || itemsQ.isLoading) return <PageSkeleton />;
  if (quotesQ.error || itemsQ.error) {
    return (
      <ErrorState
        message="לא הצלחנו לטעון את הצעות המחיר. נסה שוב."
        onRetry={() => {
          quotesQ.refetch();
          itemsQ.refetch();
        }}
      />
    );
  }

  async function duplicateQuote(quote: Quote) {
    setBusy(true);
    const { data: sections, error: sectionsError } = await db
      .from<QuoteSection[]>("quote_sections")
      .select("*")
      .eq("quote_id", quote.id)
      .order("sort_order", { ascending: true });
    if (sectionsError) {
      setBusy(false);
      toast.error("לא הצלחנו לשכפל את ההצעה");
      return;
    }
    const { data: quoteItems, error: itemsError } = await db
      .from<QuoteItem[]>("quote_items")
      .select("*")
      .eq("quote_id", quote.id)
      .order("sort_order", { ascending: true });
    if (itemsError) {
      setBusy(false);
      toast.error("לא הצלחנו לשכפל את ההצעה");
      return;
    }
    const newId = crypto.randomUUID();
    const newNumber = nextQuoteNumber(quotes.map((item) => item.quote_number));
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
      terms: Array.isArray(quote.terms) ? quote.terms : [],
      terms_text: quote.terms_text,
      subtotal: quote.subtotal,
      discount_amount: quote.discount_amount,
      total_before_vat: quote.total_before_vat,
      vat_amount: quote.vat_amount,
      grand_total: quote.grand_total,
      created_by: user?.id ?? null,
    });
    if (error) {
      setBusy(false);
      toast.error("לא הצלחנו לשכפל את ההצעה");
      return;
    }
    const sectionMap = new Map<string, string>();
    const newSections = (sections ?? []).map((section, index) => {
      const id = crypto.randomUUID();
      sectionMap.set(section.id, id);
      return {
        id,
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
    const newItems = (quoteItems ?? []).map((item, index) => ({
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

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const { error } = await db.from("quotes").delete().eq("id", deleting.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את ההצעה");
      return;
    }
    toast.success("ההצעה נמחקה");
    setDeleting(null);
    quotesQ.refetch();
  }

  return (
    <div>
      <PageHeader
        title="הצעות מחיר"
        description={`${num(quotes.length)} הצעות מחיר`}
        actions={
          canEdit ? (
            <Button asChild>
              <Link to="/quotes/new" search={{ date: undefined, event: undefined }}><Plus className="size-4" /> הצעת מחיר חדשה</Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי מספר, לקוח או מקום"
            className="h-11 pe-9"
            aria-label="חיפוש הצעות"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as "all" | QuoteStatus)} aria-label="סינון לפי סטטוס">
          <option value="all">כל הסטטוסים</option>
          {QUOTE_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <ClientPicker clients={clients} value={clientId === "all" ? "" : clientId} onChange={(id) => setClientId(id || "all")} emptyLabel={clientPickerCopy.all} />
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-11" aria-label="סינון לפי חודש" />
      </div>

      {!filtered.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={FileText}
            title={quotes.length ? "לא נמצאו הצעות" : "עדיין אין הצעות מחיר"}
            description={quotes.length ? "נסה לשנות את הסינון." : "הצעת מחיר חדשה תאפשר לבנות סעיפים, מחירים והדפסה."}
            action={canEdit ? <Button asChild><Link to="/quotes/new" search={{ date: undefined, event: undefined }}><Plus className="size-4" /> הצעת מחיר חדשה</Link></Button> : undefined}
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-start font-medium">מספר</th>
                <th className="px-3 py-2 text-start font-medium">לקוח</th>
                <th className="px-3 py-2 text-start font-medium">תאריך אירוע</th>
                <th className="px-3 py-2 text-start font-medium">סה״כ</th>
                <th className="px-3 py-2 text-start font-medium">סטטוס</th>
                <th className="px-3 py-2 text-start font-medium">פעולות</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtered.map((quote) => (
                <tr key={quote.id}>
                  <td className="px-3 py-3 font-medium text-foreground">{quote.quote_number}</td>
                  <td className="px-3 py-3">
                    <p className="text-foreground">{quote.client_name}</p>
                    <p className="text-xs text-muted-foreground">{quote.venue || "—"}</p>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{quote.event_date ? dateShortYY(quote.event_date) : "—"}</td>
                  <td className="num px-3 py-3 font-semibold text-foreground">{money0(grandTotal(quote))}</td>
                  <td className="px-3 py-3"><StatusPill status={QUOTE_STATUS_LABELS[quote.status]} /></td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/quotes/$id" params={{ id: quote.id }}>פתיחה</Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/quotes/$id/print" params={{ id: quote.id }}>
                          <Printer className="size-4" /> הדפסה
                        </Link>
                      </Button>
                      {canEdit ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => duplicateQuote(quote)} disabled={busy}>
                          <Copy className="size-4" /> שכפול
                        </Button>
                      ) : null}
                      {canEdit && (isAdmin || quote.created_by === user?.id) ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => setDeleting(quote)} disabled={busy}>
                          <Trash2 className="size-4" /> מחיקה
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(value) => !value && setDeleting(null)}
        title="מחיקת הצעת מחיר"
        description={`האם למחוק את הצעה ${deleting?.quote_number ?? ""}? הפעולה תמחק גם את הסעיפים והשורות.`}
        onConfirm={remove}
        busy={busy}
      />
    </div>
  );
}
