import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accountingSummaryText, useAccountingAccess, useAccountingSummaries } from "@/hooks/use-event-accounting";
import { accountingCopy } from "@/content/event-accounting";

export function EventAccountingButton({ eventId }: { eventId: string }) {
  const access = useAccountingAccess();
  if (!access.canView) return null;
  return <Button asChild type="button" size="sm" variant="outline">
    <Link to="/events/$id/accounting" params={{ id: eventId }}><FileText className="size-4" />{accountingCopy.title}</Link>
  </Button>;
}

export function EventAccountingSummaryLink({ eventId }: { eventId: string }) {
  const access = useAccountingAccess();
  const query = useAccountingSummaries([eventId], access.canView, access.userId);
  if (!access.canView) return null;
  const text = query.isError ? accountingCopy.unavailable : query.isSuccess ? accountingSummaryText(query.data ?? []) : accountingCopy.loading;
  return <Link to="/events/$id/accounting" params={{ id: eventId }} className="block min-h-11 break-words py-2 text-xs font-medium text-primary underline underline-offset-2">{text}</Link>;
}
