import type { EventRow, Role } from "./types";

/**
 * One source of truth for which events a role may see in the calendar.
 * - warehouse → every company event (no status filter, no assignment filter)
 * - crew      → only events the user is assigned to (shifts OR event_day_crew)
 * - sales     → only the user's own events (sales_rep_id)
 * - admin / accounting / unknown → every event (safe fallback)
 */
export type CalendarScope = "all" | "assigned" | "own";

export function calendarScopeForRole(role: Role | null | undefined): CalendarScope {
  if (role === "warehouse") return "all";
  if (role === "crew") return "assigned";
  if (role === "sales") return "own";
  return "all";
}

export function eventMatchesCalendarScope(
  event: Pick<EventRow, "id" | "sales_rep_id">,
  scope: CalendarScope,
  userId: string | null | undefined,
  assignedEventIds: Set<string>,
): boolean {
  if (scope === "all") return true;
  if (scope === "own") return Boolean(userId) && event.sales_rep_id === userId;
  return assignedEventIds.has(event.id);
}

/**
 * Resolve the events a crew user is assigned to through BOTH assignment paths:
 * shifts.crew_member_id and event_day_crew.crew_member_id, joined through
 * crew_members.user_id. event_day_crew rows are mapped to their event via
 * event_days.
 */
export function assignedEventIdsFor(
  userId: string | null | undefined,
  crew: Array<{ id: string; user_id: string | null }>,
  shifts: Array<{ event_id: string; crew_member_id: string }>,
  eventDays: Array<{ id: string; event_id: string }>,
  eventDayCrew: Array<{ event_day_id: string; crew_member_id: string }>,
): Set<string> {
  const ids = new Set<string>();
  if (!userId) return ids;
  const myCrewIds = new Set(crew.filter((member) => member.user_id === userId).map((member) => member.id));
  if (!myCrewIds.size) return ids;
  for (const shift of shifts) {
    if (myCrewIds.has(shift.crew_member_id)) ids.add(shift.event_id);
  }
  const dayToEvent = new Map(eventDays.map((day) => [day.id, day.event_id]));
  for (const assignment of eventDayCrew) {
    if (!myCrewIds.has(assignment.crew_member_id)) continue;
    const eventId = dayToEvent.get(assignment.event_day_id);
    if (eventId) ids.add(eventId);
  }
  return ids;
}
