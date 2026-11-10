import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { addMonths, format, subMonths } from "date-fns";
import { ChevronLeft, ChevronRight, Clock, MapPin, Plus, Printer, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useCrewMembers, useEventDayCrew, useEventDays, useEvents, useMeetings, useProfiles, useShifts } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { dateKey, dateLong, dateShort, monthLabel, sameDisplayName, timeShort, todayISO } from "@/lib/format";
import { calendarContent } from "@/content/calendar";
import { isFullScope } from "@/lib/scope";
import { assignedEventIdsFor, calendarScopeForRole, eventMatchesCalendarScope } from "@/lib/calendar-scope";
import { getHebrewDate, getHebrewMonthLabel, getHolidays, type HolidayCategory } from "@/lib/hebrew-calendar";
import { ErrorState, PageHeader, PageSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/overlay";
import { Field, Select, Switch, Textarea } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { EVENT_STATUS_CARD, formatStatusLabel } from "@/lib/status-labels";
import { calendarItemColor, MonthGrid, type MonthGridItem } from "@/components/calendar/month-grid";
import { EventForm } from "@/components/event-form";
import { EventAccountingButton } from "@/components/events/event-accounting-button";
import { accountingCopy } from "@/content/event-accounting";
import { accountingSummaryText, useAccountingAccess, useAccountingSummaries } from "@/hooks/use-event-accounting";
import { EventQuoteButton } from "@/components/events/event-quotes";
import { QuoteImportButton } from "@/components/quotes/quote-import-window";
import type { EventRow } from "@/lib/types";

export const Route = createFileRoute("/_app/calendar")({
  validateSearch: (search: Record<string, unknown>) => ({
    new: typeof search.new === "string" ? search.new : undefined,
  }),
  component: CalendarPage,
});

const HOLIDAY_TEXT: Record<HolidayCategory, string> = {
  chag: "text-primary",
  tzom: "text-slate-600",
  moed: "text-amber-700",
  modern: "text-sky-700",
  rosh_chodesh: "text-muted-foreground",
};
const HOLIDAY_LABEL: Record<HolidayCategory, string> = {
  chag: "חג",
  tzom: "יום צום",
  moed: "מועד",
  modern: "יום לאומי",
  rosh_chodesh: "ראש חודש",
};

type CalItem = MonthGridItem;

function enumerateRange(start: string, end: string | null | undefined, cap = 60): string[] {
  if (!start) return [];
  const s = new Date(`${start}T00:00:00`);
  if (Number.isNaN(s.getTime())) return [];
  const e = end ? new Date(`${end}T00:00:00`) : s;
  const last = !Number.isNaN(e.getTime()) && e >= s ? e : s;
  const out: string[] = [];
  const cur = new Date(s);
  let guard = 0;
  while (cur <= last && guard < cap) {
    out.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`,
    );
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return out;
}

function CalendarPage() {
  const { user, profile, can, isAdmin } = useSession();
  const { new: newParam } = Route.useSearch();
  const fullScope = isFullScope(profile, isAdmin);
  const canEditCalendar = can("calendar", "edit");
  const scope = isAdmin ? "all" : calendarScopeForRole(profile?.role);
  const needsAssignments = scope === "assigned";
  const navigate = useNavigate();
  const eventsQ = useEvents(can("calendar") || can("clients") || scope === "all" || scope === "assigned" || scope === "own");
  const meetingsQ = useMeetings(can("calendar"));
  const profilesQ = useProfiles(can("finance") || can("clients"));
  const clientsQ = useClients(can("clients") || can("calendar") || can("finance") || can("crew") || can("equipment"));
  const eventDaysQ = useEventDays(undefined, can("calendar") || can("clients") || scope === "all" || scope === "assigned" || scope === "own");
  const crewQ = useCrewMembers(needsAssignments);
  const shiftsQ = useShifts(needsAssignments);
  const eventDayCrewQ = useEventDayCrew(needsAssignments);
  const accountingAccess = useAccountingAccess();
  const accountingQ = useAccountingSummaries((eventsQ.data ?? []).map((event) => event.id), accountingAccess.canView, accountingAccess.userId);
  const accountingByEvent = new Map<string, string>();
  if (accountingAccess.canView && accountingQ.isSuccess) {
    for (const row of accountingQ.data ?? []) {
      if (!accountingByEvent.has(row.event_id)) accountingByEvent.set(row.event_id, accountingSummaryText((accountingQ.data ?? []).filter((item) => item.event_id === row.event_id)));
    }
  }
  const [cursor, setCursor] = useState(new Date());
  const [repFilter, setRepFilter] = useState("all");
  const [daySheet, setDaySheet] = useState<Date | null>(null);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [meetingDate, setMeetingDate] = useState(todayISO());
  const [eventOpen, setEventOpen] = useState(false);
  const [eventDate, setEventDate] = useState(todayISO());
  const [showHebrewDate, setShowHebrewDate] = useState(() => {
    try {
      return localStorage.getItem("calendar.showHebrewDate") !== "0";
    } catch {
      return true;
    }
  });
  const [showHolidays, setShowHolidays] = useState(() => {
    try {
      return localStorage.getItem("calendar.showHolidays") !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (newParam === "meeting") {
      setMeetingDate(todayISO());
      setMeetingOpen(true);
    }
  }, [newParam]);

  useEffect(() => {
    try {
      localStorage.setItem("calendar.showHebrewDate", showHebrewDate ? "1" : "0");
    } catch {
      /* storage may be unavailable */
    }
  }, [showHebrewDate]);

  useEffect(() => {
    try {
      localStorage.setItem("calendar.showHolidays", showHolidays ? "1" : "0");
    } catch {
      /* storage may be unavailable */
    }
  }, [showHolidays]);

  const clientById = useMemo(
    () => new Map((clientsQ.data ?? []).map((c) => [c.id, c.name])),
    [clientsQ.data],
  );

  const assignedEventIds = useMemo(
    () =>
      assignedEventIdsFor(
        user?.id,
        crewQ.data ?? [],
        shiftsQ.data ?? [],
        eventDaysQ.data ?? [],
        eventDayCrewQ.data ?? [],
      ),
    [user?.id, crewQ.data, shiftsQ.data, eventDaysQ.data, eventDayCrewQ.data],
  );

  const daySpanByEvent = useMemo(() => {
    const map = new Map<string, { min: string; max: string }>();
    for (const d of eventDaysQ.data ?? []) {
      const cur = map.get(d.event_id);
      if (!cur) map.set(d.event_id, { min: d.day_date, max: d.day_date });
      else {
        if (d.day_date < cur.min) cur.min = d.day_date;
        if (d.day_date > cur.max) cur.max = d.day_date;
      }
    }
    return map;
  }, [eventDaysQ.data]);

  const loading = eventsQ.isLoading || meetingsQ.isLoading;
  const error = eventsQ.error || meetingsQ.error;

  const items = useMemo<CalItem[]>(() => {
    const events = (eventsQ.data ?? []).filter((e) => {
      if (repFilter !== "all") return e.sales_rep_id === repFilter;
      return eventMatchesCalendarScope(e, scope, user?.id, assignedEventIds);
    });
    const meetings = (meetingsQ.data ?? []).filter((m) => {
      if (repFilter !== "all") return m.user_id === repFilter;
      return true;
    });
    const eventItems: CalItem[] = events.flatMap((e) => {
      const span = daySpanByEvent.get(e.id);
      const start = e.start_date ?? span?.min ?? e.event_date;
      const end = e.end_date && e.end_date >= start ? e.end_date : span ? span.max : start;
      const clientName = e.client_id ? clientById.get(e.client_id) ?? null : null;
      return enumerateRange(start, end).map((date) => ({
        id: e.id,
        kind: "event" as const,
        title: e.title,
        date,
        time: e.start_time,
        status: e.status,
        eventId: e.id,
        location: e.venue,
        clientName,
        accountingSummary: accountingAccess.canView
          ? accountingQ.isError ? accountingCopy.unavailable : !accountingQ.isSuccess ? accountingCopy.loading : accountingByEvent.get(e.id) ?? accountingCopy.empty
          : undefined,
      }));
    });
    const list: CalItem[] = [
      ...eventItems,
      ...meetings.map((m) => ({
        id: m.id,
        kind: "meeting" as const,
        title: m.title,
        date: dateKey(m.starts_at),
        time: timeShort(m.starts_at),
        status: m.kind,
        eventId: m.event_id ?? undefined,
        location: m.location,
      })),
    ];
    return list.sort((a, b) => `${a.date}${a.time ?? ""}`.localeCompare(`${b.date}${b.time ?? ""}`));
  }, [eventsQ.data, meetingsQ.data, repFilter, clientById, daySpanByEvent, scope, user?.id, assignedEventIds, accountingAccess.canView, accountingQ.data, accountingQ.isSuccess, accountingQ.isError]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalItem[]>();
    for (const item of items) {
      const arr = map.get(item.date) ?? [];
      arr.push(item);
      map.set(item.date, arr);
    }
    return map;
  }, [items]);

  const reps = (profilesQ.data ?? []).filter((p) => p.role === "sales" || p.role === "admin");

  if (loading) return <PageSkeleton />;
  if (error) {
    return (
      <ErrorState
        message={(error as Error).message}
        onRetry={() => {
          eventsQ.refetch();
          meetingsQ.refetch();
        }}
      />
    );
  }

  function shift(direction: -1 | 1) {
    setCursor((c) => (direction === 1 ? addMonths(c, 1) : subMonths(c, 1)));
  }

  function openMeeting(date?: string) {
    setMeetingDate(date ?? todayISO());
    setMeetingOpen(true);
  }

  function openEvent(date?: string) {
    setEventDate(date ?? todayISO());
    setEventOpen(true);
  }

  return (
    <div>
      <PageHeader
        title={calendarContent.title}
        description={!isAdmin && profile?.role === "sales" ? calendarContent.descriptionSales : calendarContent.descriptionAll}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <QuoteImportButton />
            {can("calendar", "edit") ? (
              <Button size="sm" onClick={() => openMeeting()}>
                <Plus className="size-4" />
                {calendarContent.newMeeting}
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="outline" size="icon" onClick={() => shift(-1)} aria-label={calendarContent.prevMonth}>
            <ChevronRight className="size-4" />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setCursor(new Date())}>
            {calendarContent.today}
          </Button>
          <Button type="button" variant="outline" size="icon" onClick={() => shift(1)} aria-label={calendarContent.nextMonth}>
            <ChevronLeft className="size-4" />
          </Button>
          <div className="ms-2">
            <h2 className="text-lg font-semibold text-foreground">{monthLabel(cursor)}</h2>
            {showHebrewDate ? (
              <p className="text-xs text-muted-foreground">{getHebrewMonthLabel(cursor)}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Switch checked={showHebrewDate} onCheckedChange={setShowHebrewDate} label="הצגת תאריך עברי" />
            תאריך עברי
          </label>
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Switch checked={showHolidays} onCheckedChange={setShowHolidays} label="הצגת חגי ישראל" />
            חגי ישראל
          </label>
        </div>

        {can("finance") || can("clients") ? (
          <div className="flex items-center gap-1.5">
            <Users className="size-4 text-muted-foreground" aria-hidden="true" />
            <Select
              aria-label={calendarContent.repFilterLabel}
              value={repFilter}
              onChange={(e) => setRepFilter(e.target.value)}
              className="h-11 w-44 text-xs"
            >
              <option value="all">{calendarContent.allReps}</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.full_name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      <div className="mb-3 space-y-1.5">
        <div className="flex flex-wrap gap-2">
          {(canEditCalendar
            ? calendarContent.colorLegend
            : calendarContent.colorLegend.filter((entry) => entry.status === "ממתין לסגירה" || entry.status === "נסגר")
          ).map((entry) => (
            <span key={entry.label} className={cn("rounded-full border px-2.5 py-1 text-xs font-medium", calendarItemColor({ kind: "event", status: entry.status }))}>
              {entry.label}
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" role="status">
          {calendarContent.colorNote}
        </p>
      </div>

      <MonthGrid
        month={cursor}
        items={items}
        onDayClick={setDaySheet}
        onEventClick={(id) => navigate({ to: "/events/$id", params: { id } })}
        onAccountingClick={(id) => navigate({ to: "/events/$id/accounting", params: { id } })}
        labels={{
          weekdays: calendarContent.weekdays,
          more: calendarContent.more,
          allDay: calendarContent.allDay,
          event: calendarContent.event,
          meeting: calendarContent.meeting,
        }}
        dayLabel={dateLong}
        ariaLabel={calendarContent.dayAria}
        showHebrewDate={showHebrewDate}
        showHolidays={showHolidays}
        restrictedStatusColors={!canEditCalendar}
      />

      <Sheet
        open={!!daySheet}
        onOpenChange={(v) => !v && setDaySheet(null)}
        title={daySheet ? dateLong(daySheet) : ""}
        description={
          daySheet
            ? calendarContent.dayItemsLabel((byDate.get(format(daySheet, "yyyy-MM-dd")) ?? []).length)
            : ""
        }
        footer={
          daySheet ? (
            <div className="flex flex-col gap-2">
              {can("calendar", "edit") ? (
                <Button type="button" className="w-full" onClick={() => openMeeting(format(daySheet, "yyyy-MM-dd"))}>
                  <Plus className="size-4" />
                  {calendarContent.addMeetingOnDay}
                </Button>
              ) : null}
              {fullScope && can("clients", "edit") ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => openEvent(format(daySheet, "yyyy-MM-dd"))}
                >
                  <Plus className="size-4" />
                  {calendarContent.addEventOnDay}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {daySheet ? (
          <div className="mb-3 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-semibold text-foreground">{getHebrewDate(daySheet).formatted}</p>
            {getHolidays(daySheet).length ? (
              <ul className="mt-1 space-y-0.5">
                {getHolidays(daySheet).map((holiday, index) => (
                  <li key={`${holiday.name}-${index}`} className={`text-xs ${HOLIDAY_TEXT[holiday.category]}`}>
                    {holiday.name} <span className="text-muted-foreground">· {HOLIDAY_LABEL[holiday.category]}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {daySheet ? (
          <DayAgenda
            items={byDate.get(format(daySheet, "yyyy-MM-dd")) ?? []}
            restrictedStatusColors={!canEditCalendar}
            canCreateQuote={can("quotes", "edit")}
            canViewReport={(eventId) => {
              if (isAdmin) return true;
              if (profile?.role === "warehouse") return true;
              if (profile?.role === "sales") return true;
              if (profile?.role === "crew") return assignedEventIds.has(eventId);
              return false;
            }}
            onEvent={(id) => {
              setDaySheet(null);
              navigate({ to: "/events/$id", params: { id } });
            }}
            onDeleteMeeting={async (id) => {
              const { error } = await db.from("meetings").delete().eq("id", id);
              if (error) {
                toast.error(calendarContent.meetingDeleteError);
                return;
              }
              toast.success(calendarContent.meetingDeleted);
              meetingsQ.refetch();
            }}
          />
        ) : null}
      </Sheet>

      <MeetingDialog
        open={meetingOpen}
        onOpenChange={setMeetingOpen}
        defaultDate={meetingDate}
        events={eventsQ.data ?? []}
        userId={user?.id}
        onSaved={() => {
          meetingsQ.refetch();
          setMeetingOpen(false);
        }}
      />

      <EventForm
        open={eventOpen}
        onOpenChange={setEventOpen}
        event={null}
        defaultDate={eventDate}
        clients={clientsQ.data ?? []}
        profiles={profilesQ.data ?? []}
        currentProfile={profile}
        isAdmin={isAdmin}
        canEditStatus={canEditCalendar}
        onSaved={() => {
          eventsQ.refetch();
          setEventOpen(false);
        }}
      />
    </div>
  );
}

function DayAgenda({
  items,
  restrictedStatusColors = false,
  canCreateQuote,
  canViewReport,
  onEvent,
  onDeleteMeeting,
}: {
  items: CalItem[];
  restrictedStatusColors?: boolean;
  canCreateQuote: boolean;
  canViewReport: (eventId: string) => boolean;
  onEvent: (id: string) => void;
  onDeleteMeeting: (id: string) => void;
}) {
  if (!items.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{calendarContent.noItemsInDay}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className={`rounded-xl border p-3 ${item.kind === "event" ? EVENT_STATUS_CARD[restrictedStatusColors ? (item.status === "נסגר" ? "נסגר" : "ממתין לסגירה") : item.status] ?? "border-border bg-card" : "border-border bg-card"}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              {item.kind === "event" ? (
                <>
                  <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
                  {item.clientName && !sameDisplayName(item.title, item.clientName) ? (
                    <p className="mt-0.5 truncate text-xs text-current opacity-80">{item.clientName}</p>
                  ) : null}
                  {item.location ? (
                    <p className="mt-0.5 truncate text-xs text-current opacity-80">{item.location}</p>
                  ) : null}
                  {item.accountingSummary && item.eventId ? (
                    <Link to="/events/$id/accounting" params={{ id: item.eventId }} className="mt-1 block min-h-11 max-w-full break-words py-2 text-xs font-medium underline underline-offset-2">
                      {item.accountingSummary}
                    </Link>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-foreground">{item.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      {item.time ? timeShort(item.time) : calendarContent.allDay}
                    </span>
                    {item.location ? (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3" />
                        {item.location}
                      </span>
                    ) : null}
                  </p>
                </>
              )}
            </div>
            {restrictedStatusColors ? (
              <span className="text-xs font-medium text-foreground">{formatStatusLabel(item.status)}</span>
            ) : (
              <StatusPill status={item.status} />
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {item.kind === "event" && item.eventId ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => onEvent(item.eventId!)}>
                  {calendarContent.openEvent}
                </Button>
                <EventQuoteButton eventId={item.eventId} canCreate={canCreateQuote} />
                {canViewReport(item.eventId) ? (
                  <Button asChild type="button" size="sm" variant="outline">
                    <Link to="/events/$id/crew-sheet" params={{ id: item.eventId }}>
                      <Printer className="size-4" />
                      דוח אירוע
                    </Link>
                  </Button>
                ) : null}
                <EventAccountingButton eventId={item.eventId} />
              </div>
            ) : null}
            {item.kind === "meeting" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onDeleteMeeting(item.id)}
              >
                <Trash2 className="size-4" />
                {calendarContent.deleteMeeting}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function MeetingDialog({
  open,
  onOpenChange,
  defaultDate,
  events,
  userId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultDate: string;
  events: EventRow[];
  userId?: string;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("11:00");
  const [kind, setKind] = useState<string>(calendarContent.meetingKinds[0]);
  const [location, setLocation] = useState("");
  const [eventId, setEventId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [lastDefault, setLastDefault] = useState(defaultDate);
  if (open && defaultDate !== lastDefault) {
    setLastDefault(defaultDate);
    setDate(defaultDate);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError(calendarContent.titleRequired);
      return;
    }
    if (!date || !start) {
      setError(calendarContent.dateRequired);
      return;
    }
    if (!userId) {
      setError(calendarContent.userRequired);
      return;
    }
    setBusy(true);
    const { error: dbError } = await db.from("meetings").insert({
      title: title.trim(),
      user_id: userId,
      starts_at: new Date(`${date}T${start}:00`).toISOString(),
      ends_at: end ? new Date(`${date}T${end}:00`).toISOString() : null,
      location: location.trim() || null,
      kind,
      event_id: eventId || null,
      notes: notes.trim() || null,
      done: false,
    });
    setBusy(false);
    if (dbError) {
      setError(calendarContent.meetingSaveError);
      return;
    }
    toast.success(calendarContent.meetingSaved);
    setTitle("");
    setLocation("");
    setNotes("");
    setEventId("");
    onSaved();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={calendarContent.meetingDialogTitle}
      description={calendarContent.meetingDialogDescription}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {calendarContent.cancel}
          </Button>
          <Button type="submit" form="meeting-form" disabled={busy}>
            {busy ? calendarContent.saving : calendarContent.save}
          </Button>
        </div>
      }
    >
      <form id="meeting-form" onSubmit={save} className="space-y-4">
        <Field label={calendarContent.titleLabel} htmlFor="meeting-title">
          <Input
            id="meeting-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={calendarContent.titlePlaceholder}
            className="h-11"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={calendarContent.dateLabel} htmlFor="meeting-date">
            <Input id="meeting-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11" />
          </Field>
          <Field label={calendarContent.typeLabel} htmlFor="meeting-kind">
            <Select id="meeting-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {calendarContent.meetingKinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={calendarContent.startLabel} htmlFor="meeting-start">
            <Input id="meeting-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} className="h-11" />
          </Field>
          <Field label={calendarContent.endLabel} htmlFor="meeting-end">
            <Input id="meeting-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label={calendarContent.locationLabel} htmlFor="meeting-location">
          <Input
            id="meeting-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={calendarContent.locationPlaceholder}
            className="h-11"
          />
        </Field>
        <Field label={calendarContent.linkedEventLabel} htmlFor="meeting-event">
          <Select id="meeting-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">{calendarContent.noLinkedEvent}</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.title} · {dateShort(ev.event_date)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={calendarContent.notesLabel} htmlFor="meeting-notes">
          <Textarea
            id="meeting-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={calendarContent.notesPlaceholder}
          />
        </Field>
        {error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
