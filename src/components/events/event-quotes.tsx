import type { ComponentProps } from "react";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useQuotes } from "@/hooks/use-data";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatusPill } from "@/components/shared";
import { QUOTE_STATUS_LABELS, money0 } from "@/lib/quotes";
import type { QuoteStatus } from "@/lib/types";

type ButtonProps = ComponentProps<typeof Button>;

export function EventQuoteButton({
  eventId,
  canCreate,
  variant = "outline",
  size = "sm",
  className,
}: {
  eventId: string;
  canCreate: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  if (!canCreate) return null;
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Link to="/quotes/new" search={{ event: eventId, date: undefined }}>
        <FileText className="size-4" />
        הצעת מחיר
      </Link>
    </Button>
  );
}

export function EventQuotesSection({
  eventId,
  canView,
  canCreate,
}: {
  eventId: string;
  canView: boolean;
  canCreate: boolean;
}) {
  const quotesQ = useQuotes(canView);
  if (!canView) return null;
  const quotes = (quotesQ.data ?? []).filter((quote) => quote.event_id === eventId);
  return (
    <SectionCard
      title="הצעות מחיר לאירוע"
      description={quotes.length ? `${quotes.length} הצעות משויכות` : "הצעות מחיר שייווצרו מהאירוע יופיעו כאן"}
      action={canCreate ? <EventQuoteButton eventId={eventId} canCreate={canCreate} /> : null}
    >
      {quotesQ.isLoading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">טוען הצעות מחיר…</p>
      ) : quotesQ.error ? (
        <p className="py-4 text-center text-sm text-muted-foreground">לא הצלחנו לטעון את הצעות המחיר.</p>
      ) : !quotes.length ? (
        <EmptyState
          icon={FileText}
          title="אין עדיין הצעות מחיר לאירוע"
          description="אפשר ליצור הצעת מחיר חדשה שמשויכת לאירוע הזה."
          action={canCreate ? <EventQuoteButton eventId={eventId} canCreate={canCreate} /> : undefined}
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {quotes.map((quote) => (
            <li key={quote.id} className="flex flex-col gap-2 px-1 py-3 sm:flex-row sm:items-center sm:justify-between">
              <Link
                to="/quotes/$id"
                params={{ id: quote.id }}
                className="min-w-0 flex-1 hover:bg-muted/40"
              >
                <p className="truncate text-sm font-semibold text-foreground">{quote.quote_number}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {quote.client_name}
                  {quote.subject ? ` · ${quote.subject}` : ""}
                </p>
              </Link>
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-sm font-bold text-foreground">{money0(quote.grand_total)}</span>
                <StatusPill status={QUOTE_STATUS_LABELS[quote.status as QuoteStatus] ?? quote.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
