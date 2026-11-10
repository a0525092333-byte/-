import { createFileRoute } from "@tanstack/react-router";
import { QuoteBuilder } from "@/components/quotes/quote-builder";

export const Route = createFileRoute("/_app/quotes/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    event: typeof search.event === "string" ? search.event : undefined,
  }),
  component: NewQuotePage,
});

function NewQuotePage() {
  const { date, event } = Route.useSearch();
  return <QuoteBuilder initialDate={date} initialEventId={event} />;
}
