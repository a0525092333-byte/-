import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/quotes")({ component: QuotesLayout });

function QuotesLayout() {
  return <Outlet />;
}
