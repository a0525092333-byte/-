import { createFileRoute } from "@tanstack/react-router";
import { EventAccountingPage } from "@/components/events/event-accounting";

export const Route = createFileRoute("/_app/events/$id_/accounting")({ component: AccountingRoute });

function AccountingRoute() {
  const { id } = Route.useParams();
  return <EventAccountingPage key={id} eventId={id} />;
}
