import { useMemo } from "react";
import { CalendarDays } from "lucide-react";
import { useCrewMembers, useEventDayCrew, useEventDays, useEvents, useShifts } from "@/hooks/use-data";
import { assignedEventIdsFor, calendarScopeForRole, eventMatchesCalendarScope } from "@/lib/calendar-scope";
import { dateShort } from "@/lib/format";
import type { Profile } from "@/lib/types";

/**
 * Read-only preview of the calendar a given user would see, using the same
 * scope helper as the calendar page. Rendered inside the admin's user-settings
 * dialog so the admin never sees their own calendar there.
 */
export function UserCalendarPreview({ profile }: { profile: Profile }) {
  const eventsQ = useEvents(true);
  const crewQ = useCrewMembers(true);
  const shiftsQ = useShifts(true);
  const eventDaysQ = useEventDays(undefined, true);
  const eventDayCrewQ = useEventDayCrew(true);

  const scope = calendarScopeForRole(profile.role);
  const assignedEventIds = useMemo(
    () =>
      assignedEventIdsFor(
        profile.id,
        crewQ.data ?? [],
        shiftsQ.data ?? [],
        eventDaysQ.data ?? [],
        eventDayCrewQ.data ?? [],
      ),
    [profile.id, crewQ.data, shiftsQ.data, eventDaysQ.data, eventDayCrewQ.data],
  );

  const events = useMemo(
    () =>
      (eventsQ.data ?? [])
        .filter((event) => eventMatchesCalendarScope(event, scope, profile.id, assignedEventIds))
        .sort((a, b) => (a.event_date ?? "").localeCompare(b.event_date ?? ""))
        .slice(0, 8),
    [eventsQ.data, scope, profile.id, assignedEventIds],
  );

  const loading =
    eventsQ.isLoading ||
    crewQ.isLoading ||
    shiftsQ.isLoading ||
    eventDaysQ.isLoading ||
    eventDayCrewQ.isLoading;

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">היומן של {profile.full_name}</p>
      </div>
      {loading ? (
        <p className="mt-2 text-xs text-muted-foreground">טוען יומן…</p>
      ) : events.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {scope === "assigned" ? "לא שובצו למשתמש אירועים." : "אין אירועים להצגה."}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {events.map((event) => (
            <li key={event.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-foreground">{event.title}</span>
              <span className="shrink-0 text-muted-foreground">{dateShort(event.event_date)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
