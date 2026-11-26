import { createFileRoute } from "@tanstack/react-router";
import { OfficeBoard } from "@/components/office/office-board";

export const Route = createFileRoute("/_app/office")({ component: OfficePage });

function OfficePage() {
  return <OfficeBoard />;
}
// END OF FILE - src/routes/_app.office.tsx
