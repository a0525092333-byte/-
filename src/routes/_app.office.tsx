import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { OfficeWindow } from "@/components/office/office-window";

export const Route = createFileRoute("/_app/office")({ component: OfficePage });

function OfficePage() {
  const navigate = useNavigate();
  return <OfficeWindow open onClose={() => navigate({ to: "/" })} />;
}
