import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSession } from "@/hooks/use-session";
import { useClients, useProfiles } from "@/hooks/use-data";
import { EventForm } from "@/components/event-form";
import { NoAccessScreen } from "@/components/require-full-scope";
import { PageSkeleton } from "@/components/shared";
import { isFullScope } from "@/lib/scope";

export const Route = createFileRoute("/_app/events/new")({ component: NewEventPage });

function NewEventPage() {
  const { profile, can, isAdmin } = useSession();
  const navigate = useNavigate();
  const fullScope = isFullScope(profile, isAdmin);
  const canCreate = fullScope && can("clients", "edit");
  const clientsQ = useClients(can("clients") || can("calendar") || can("finance") || can("crew"));
  const profilesQ = useProfiles(can("finance") || can("clients"));

  if (!canCreate) return <NoAccessScreen message="אין לך הרשאה לפתוח אירוע חדש." />;
  if (clientsQ.isLoading) return <PageSkeleton />;

  return (
    <EventForm
      open
      onOpenChange={(v) => {
        if (!v) navigate({ to: "/events" });
      }}
      event={null}
      clients={clientsQ.data ?? []}
      profiles={profilesQ.data ?? []}
      currentProfile={profile}
      isAdmin={isAdmin}
      onSaved={() => {}}
    />
  );
}
