import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { cn } from "@/lib/utils";
import { EVENT_STATUS_SOLID } from "@/lib/status-labels";
import { getHebrewDate, getHolidays, type HolidayCategory } from "@/lib/hebrew-calendar";

const HOLIDAY_TEXT: Record<HolidayCategory, string> = {
  chag: "text-primary",
  tzom: "text-slate-600",
  moed: "text-amber-700",
  modern: "text-sky-700",
  rosh_chodesh: "text-muted-foreground/70",
};
const HOLIDAY_DOT: Record<HolidayCategory, string> = {
  chag: "bg-primary",
  tzom: "bg-slate-500",
  moed: "bg-amber-500",
  modern: "bg-sky-500",
  rosh_chodesh: "bg-muted-foreground/50",
};

export type MonthGridItem = {
  id: string;
  kind: "event" | "meeting";
  title: string;
  date: string;
  time: string | null;
  status: string;
  eventId?: string;
  location?: string | null;
  clientName?: string | null;
  accountingSummary?: string;
};

export function calendarItemColor(
  item: Pick<MonthGridItem, "kind" | "status">,
  restricted = false,
): string {
  if (item.kind === "meeting") return "bg-sky-50 text-sky-800 border-sky-200";
  if (restricted) {
    return item.status === "נסגר"
      ? EVENT_STATUS_SOLID["נסגר"]
      : EVENT_STATUS_SOLID["ממתין לסגירה"];
  }
  return EVENT_STATUS_SOLID[item.status] ?? "bg-muted text-foreground border-border";
}

export type MonthGridLabels = {
  weekdays: readonly string[];
  more: string;
  allDay: string;
  event: string;
  meeting: string;
};

/**
 * Full month grid — 7 columns, Sunday first (RTL: Sunday is the rightmost column).
 * Each day cell renders up to 3 events (2 on mobile) with the time + title, then
 * a "+N עוד" affordance. Clicking the cell opens the day; clicking an event opens it.
 */
export function MonthGrid({
  month,
  items,
  onDayClick,
  onEventClick,
  onAccountingClick,
  labels,
  dayLabel,
  ariaLabel,
  showHebrewDate = true,
  showHolidays = true,
  restrictedStatusColors = false,
  className,
}: {
  month: Date;
  items: MonthGridItem[];
  onDayClick: (date: Date) => void;
  onEventClick: (eventId: string) => void;
  onAccountingClick?: (eventId: string) => void;
  labels: MonthGridLabels;
  dayLabel: (date: Date) => string;
  ariaLabel: (label: string, count: number) => string;
  showHebrewDate?: boolean;
  showHolidays?: boolean;
  restrictedStatusColors?: boolean;
  className?: string;
}) {
  const byDate = new Map<string, MonthGridItem[]>();
  for (const item of items) {
    const arr = byDate.get(item.date) ?? [];
    arr.push(item);
    byDate.set(item.date, arr);
  }

  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 0 });
  const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 0 });
  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

  const today = new Date();

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="grid grid-cols-7 border-b border-border bg-muted/40">
        {labels.weekdays.map((label, index) => (
          <div
            key={`${label}-${index}`}
            className={cn(
              "px-1 py-2 text-center text-[10px] font-semibold text-muted-foreground sm:text-xs",
              index === 6 && "bg-muted/60",
            )}
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const dayItems = byDate.get(key) ?? [];
          const inMonth = isSameMonth(day, month);
          const isToday = isSameDay(day, today);
          const isSaturday = day.getDay() === 6;
          const label = dayLabel(day);
          const hebrew = showHebrewDate ? getHebrewDate(day) : null;
          const holidays = showHolidays ? getHolidays(day) : [];
          const primaryHoliday = holidays.find((holiday) => holiday.category !== "rosh_chodesh") ?? holidays[0];

          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => onDayClick(day)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onDayClick(day);
                }
              }}
              aria-label={ariaLabel(label, dayItems.length)}
              className={cn(
                "group min-h-[78px] cursor-pointer border-b border-e border-border/70 p-1 text-start align-top transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:min-h-[116px] sm:p-1.5",
                !inMonth && "bg-muted/20",
                isSaturday && "bg-muted/30",
                isToday && "bg-accent/30 ring-1 ring-inset ring-primary/30",
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <span
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full text-[10px] font-semibold sm:size-6 sm:text-xs",
                    isToday
                      ? "bg-primary text-primary-foreground"
                      : inMonth
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                  )}
                >
                  {day.getDate()}
                </span>
              </div>

              {hebrew || primaryHoliday ? (
                <div className="mb-1 space-y-0.5">
                  {hebrew ? (
                    <span className="block text-[9px] leading-tight text-muted-foreground sm:text-[10px]">
                      {hebrew.dayGematriya}
                    </span>
                  ) : null}
                  {primaryHoliday ? (
                    <span
                      className={cn(
                        "flex min-w-0 items-center gap-0.5 text-[9px] leading-tight sm:text-[10px]",
                        HOLIDAY_TEXT[primaryHoliday.category],
                      )}
                    >
                      <span className={cn("size-1.5 shrink-0 rounded-full", HOLIDAY_DOT[primaryHoliday.category])} />
                      <span className="truncate">
                        {primaryHoliday.name}
                        {holidays.length > 1 ? ` +${holidays.length - 1}` : ""}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-0.5 sm:space-y-1">
                {dayItems.slice(0, 3).map((item, index) => (
                  <div key={`${item.kind}-${item.id}`} className={cn("w-full min-w-0 rounded border", calendarItemColor(item, restrictedStatusColors))}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (item.kind === "event" && item.eventId) {
                        onEventClick(item.eventId);
                      } else {
                        onDayClick(day);
                      }
                    }}
                    title={`${item.clientName ?? item.title}${item.location ? ` · ${item.location}` : ""}`}
                    className="block w-full min-w-0 rounded px-1 py-0.5 text-start leading-tight transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span className="block truncate text-[9px] font-semibold sm:text-[10px]">
                      {item.clientName ?? item.title}
                    </span>
                    {item.location ? (
                      <span className="block truncate text-[9px] opacity-95 sm:text-[10px]">{item.location}</span>
                    ) : null}
                  </button>
                  {item.kind === "event" && item.eventId && item.accountingSummary && onAccountingClick ? (
                    <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onAccountingClick(item.eventId!); }} title={item.accountingSummary} className="block w-full min-w-0 truncate rounded px-1 py-1 text-start text-[9px] font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:text-[10px]">
                      {item.accountingSummary}
                    </button>
                  ) : null}
                  </div>
                ))}

                {dayItems.length > 3 ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDayClick(day);
                    }}
                    className="block w-full rounded px-1 text-start text-[9px] font-medium text-muted-foreground hover:text-foreground sm:text-[10px]"
                  >
                    +{dayItems.length - 3} {labels.more}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
