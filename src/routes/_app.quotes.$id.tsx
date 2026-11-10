import { createFileRoute } from "@tanstack/react-router";
import { QuoteBuilder } from "@/components/quotes/quote-builder";

export const Route = createFileRoute("/_app/quotes/$id")({ component: EditQuotePage });

function EditQuotePage() {
  const { id } = Route.useParams();
  return <QuoteBuilder quoteId={id} />;
}
