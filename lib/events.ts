import type { EventRow } from "./types";

type EventDateSpan = {
  start_date?: string | null;
  end_date?: string | null;
  event_date?: string | null;
};

/**
 * One shared rule for whether an event is multi-day. Used by the event form
 * (new + edit) and the event detail page so the per-day schedule block is
 * shown only when the event actually spans more than one day.
 */
export function isMultiDayEvent(
  event: Pick<EventRow, "start_date" | "end_date" | "event_date"> | EventDateSpan | null | undefined,
  days: Array<{ day_date: string }> = [],
): boolean {
  if (!event) return false;
  const start = event.start_date || event.event_date || "";
  const end = event.end_date || event.event_date || "";
  if (start && end && end > start) return true;
  const uniqueDays = new Set(days.map((day) => day.day_date).filter(Boolean));
  return uniqueDays.size > 1;
}
