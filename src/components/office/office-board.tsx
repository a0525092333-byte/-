import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, MapPin, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useCrewMembers, useEvents, useProfiles, useShifts } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { dateKey, dateLong, dateShort, initials, num, sameDisplayName, timeRange, timeShort, todayISO } from "@/lib/format";
import { EmptyState, ErrorState, NoAccess, PageSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/controls";
import { cn } from "@/lib/utils";
import { isFullScope } from "@/lib/scope";
import { assignableCrew } from "@/lib/crew";
import { crewRoles, crewRolesLabel } from "@/lib/crew-roles";
import { isEditingActive, subscribeDataChanged, subscribeEditing } from "@/lib/data-events";
import type { CrewMember, EventRow, Shift } from "@/lib/types";

const DAY_LABELS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function startOfWeekSunday(value: Date): Date {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

function addDays(value: Date, days: number): Date {
  const copy = new Date(value);
  copy.setDate(copy.getDate() + days);
  return copy;
}

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

function weekRangeLabel(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    const month = new Intl.DateTimeFormat("he-IL", { month: "long" }).format(start);
    return `${start.getDate()}–${end.getDate()} ב${month} ${start.getFullYear()}`;
  }
  return `${dateLong(start)} – ${dateLong(end)}`;
}

export function OfficeBoard() {
  const { can, isAdmin, profile, user } = useSession();
  const fullScope = isFullScope(profile, isAdmin);
  const canView = can("office", "view") || !fullScope;
  const canAssign = fullScope && (can("crew", "edit") || can("office", "edit"));

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekSunday(new Date()));
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const weekStartKey = dateKey(weekStart);
  const weekEndKey = dateKey(addDays(weekStart, 6));
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const eventsQ = useEvents(canView);
  const crewQ = useCrewMembers(canView);
  const shiftsQ = useShifts(canView);
  const clientsQ = useClients(canView);
  const profilesQ = useProfiles(canView);

  const refetchRef = useRef({
    events: eventsQ.refetch,
    crew: crewQ.refetch,
    shifts: shiftsQ.refetch,
    clients: clientsQ.refetch,
    profiles: profilesQ.refetch,
  });
  refetchRef.current = {
    events: eventsQ.refetch,
    crew: crewQ.refetch,
    shifts: shiftsQ.refetch,
    clients: clientsQ.refetch,
    profiles: profilesQ.refetch,
  };

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingRef = useRef(false);
  const pendingRef = useRef(false);
  const editingActiveRef = useRef(false);
  const scheduleRefreshRef = useRef<() => void>(() => {});

  const refetchAll = useCallback(() => {
    if (editingActiveRef.current) {
      pendingRef.current = true;
      return;
    }
    if (refreshingRef.current) {
      pendingRef.current = true;
      return;
    }
    refreshingRef.current = true;
    const { events, crew, shifts, clients, profiles } = refetchRef.current;
    Promise.allSettled([events(), crew(), shifts(), clients(), profiles()]).finally(() => {
      refreshingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        scheduleRefreshRef.current();
      }
    });
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refetchAll();
    }, 300);
  }, [refetchAll]);

  scheduleRefreshRef.current = scheduleRefresh;

  useEffect(() => {
    if (!canView) return;
    editingActiveRef.current = isEditingActive();
    const unsubscribe = subscribeDataChanged(() => scheduleRefresh());
    const unsubscribeEditing = subscribeEditing((active) => {
      editingActiveRef.current = active;
      if (!active && pendingRef.current) {
        pendingRef.current = false;
        scheduleRefresh();
      }
    });
    return () => {
      unsubscribe();
      unsubscribeEditing();
    };
  }, [canView, scheduleRefresh]);

  useEffect(() => {
    if (!canView) return;
    const POLL_MS = 25000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") scheduleRefresh();
      }, POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        scheduleRefresh();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => scheduleRefresh();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [canView, scheduleRefresh]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const events = (eventsQ.data ?? []).filter((event) => {
    const start = event.start_date ?? event.event_date;
    const end = event.end_date ?? start;
    return start <= weekEndKey && end >= weekStartKey;
  });
  const crew = assignableCrew(crewQ.data ?? [], profilesQ.data ?? []);
  const shifts = shiftsQ.data ?? [];
  const clients = useMemo(() => {
    const map = new Map<string, string>();
    for (const client of clientsQ.data ?? []) map.set(client.id, client.name);
    return map;
  }, [clientsQ.data]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, EventRow[]>();
    for (const event of events) {
      const start = event.start_date ?? event.event_date;
      const end = event.end_date ?? start;
      for (const key of enumerateRange(start, end)) {
        if (key < weekStartKey || key > weekEndKey) continue;
        const list = map.get(key) ?? [];
        list.push(event);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
    }
    return map;
  }, [events, weekStartKey, weekEndKey]);

  const shiftsByEvent = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const shift of shifts) {
      const list = map.get(shift.event_id) ?? [];
      list.push(shift);
      map.set(shift.event_id, list);
    }
    return map;
  }, [shifts]);

  const weekShiftCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const shift of shifts) {
      const key = dateKey(shift.starts_at);
      if (key >= weekStartKey && key <= weekEndKey) {
        map.set(shift.crew_member_id, (map.get(shift.crew_member_id) ?? 0) + 1);
      }
    }
    return map;
  }, [shifts, weekStartKey, weekEndKey]);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const selectedShifts = selectedEvent ? (shiftsByEvent.get(selectedEvent.id) ?? []) : [];
  const assignedCrewIds = new Set(selectedShifts.map((shift) => shift.crew_member_id));

  const roles = useMemo(
    () => Array.from(new Set(crew.flatMap((member) => crewRoles(member)))).sort(),
    [crew],
  );

  const filteredCrew = useMemo(() => {
    const query = search.trim().toLowerCase();
    return crew.filter((member) => {
      if (!member.is_active) return false;
      if (roleFilter !== "all" && !crewRoles(member).includes(roleFilter)) return false;
      if (!query) return true;
      return `${member.full_name} ${crewRolesLabel(member)} ${member.phone ?? ""}`.toLowerCase().includes(query);
    });
  }, [crew, search, roleFilter]);

  if (!canView) return <NoAccess moduleLabel="מצב משרד" />;
  if (eventsQ.isLoading || crewQ.isLoading || shiftsQ.isLoading) return <PageSkeleton />;
  if (eventsQ.error || crewQ.error || shiftsQ.error) {
    return (
      <ErrorState
        message="לא הצלחנו לטעון את מצב המשרד. נסה שוב."
        onRetry={() => {
          eventsQ.refetch();
          crewQ.refetch();
          shiftsQ.refetch();
        }}
      />
    );
  }

  if (!fullScope) {
    const myCrewIds = crew.filter((c) => c.user_id === user?.id).map((c) => c.id);
    const myShifts = shifts
      .filter((s) => myCrewIds.includes(s.crew_member_id))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return (
      <div className="h-full overflow-y-auto p-3">
        <p className="mb-3 text-sm font-semibold text-foreground">המשמרות שלי</p>
        {myShifts.length ? (
          <div className="space-y-3">
            {myShifts.map((s) => {
              const ev = events.find((e) => e.id === s.event_id);
              return (
                <div key={s.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{ev?.title ?? "אירוע"}</p>
                    <StatusPill status={s.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateLong(s.starts_at)} · {timeRange(s.starts_at, s.ends_at)} · {s.role_title}
                  </p>
                  {ev?.venue ? <p className="mt-1 text-xs text-muted-foreground">{ev.venue}</p> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={CalendarDays} title="אין משמרות משויכות אליך" description="כשתשובץ למשמרת היא תופיע כאן." />
        )}
      </div>
    );
  }

  function moveWeek(delta: number) {
    setWeekStart((current) => addDays(current, delta * 7));
  }

  function goThisWeek() {
    setWeekStart(startOfWeekSunday(new Date()));
  }

  function clientName(clientId: string | null): string | null {
    if (!clientId) return null;
    return clients.get(clientId) ?? null;
  }

  function conflictFor(member: CrewMember): EventRow | null {
    if (!selectedEvent) return null;
    const day = dateKey(selectedEvent.event_date);
    const conflict = shifts.find(
      (shift) =>
        shift.crew_member_id === member.id &&
        shift.event_id !== selectedEvent.id &&
        dateKey(shift.starts_at) === day,
    );
    if (!conflict) return null;
    return events.find((event) => event.id === conflict.event_id) ?? null;
  }

  async function assign(member: CrewMember) {
    if (!selectedEvent || !canAssign) return;
    setBusyId(member.id);
    const startTime = (selectedEvent.start_time ?? "09:00").slice(0, 5);
    const endTime = selectedEvent.end_time ? selectedEvent.end_time.slice(0, 5) : null;
    const startsAt = new Date(`${selectedEvent.event_date}T${startTime}:00`).toISOString();
    const endsAt = endTime ? new Date(`${selectedEvent.event_date}T${endTime}:00`).toISOString() : null;
    const { error } = await db.from("shifts").insert({
      event_id: selectedEvent.id,
      crew_member_id: member.id,
      role_title: crewRoles(member)[0] ?? "טכנאי",
      starts_at: startsAt,
      ends_at: endsAt,
      status: "משובץ",
    });
    setBusyId(null);
    if (error) {
      toast.error("לא הצלחנו לשבץ את איש הצוות");
      return;
    }
    toast.success(`${member.full_name} שובץ/ה לאירוע`);
  }

  async function unassign(member: CrewMember) {
    if (!selectedEvent || !canAssign) return;
    const shiftToDelete = selectedShifts.find((item) => item.crew_member_id === member.id);
    if (!shiftToDelete) return;
    setBusyId(member.id);
    const { error } = await db.from("shifts").delete().eq("id", shiftToDelete.id);
    setBusyId(null);
    if (error) {
      toast.error("לא הצלחנו להסיר את השיבוץ");
      return;
    }
    toast.success("השיבוץ הוסר");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_22rem] lg:overflow-hidden">
        <section className="min-w-0 max-h-[45vh] overflow-y-auto rounded-xl border border-border bg-card lg:max-h-none lg:min-h-0">
          <div className="bg-card">
            <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-1.5">
                <Button type="button" variant="outline" size="icon" onClick={() => moveWeek(-1)} aria-label="שבוע קודם">
                  <ChevronRight className="size-4" />
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={goThisWeek}>
                  השבוע
                </Button>
                <Button type="button" variant="outline" size="icon" onClick={() => moveWeek(1)} aria-label="שבוע הבא">
                  <ChevronLeft className="size-4" />
                </Button>
              </div>
              <p className="text-sm font-semibold text-foreground">{weekRangeLabel(weekStart, addDays(weekStart, 6))}</p>
            </div>

            {events.length === 0 ? (
              <p className="border-b border-border px-3 py-2 text-center text-xs text-muted-foreground">
                אין אירועים בשבוע זה
              </p>
            ) : null}

            <div className="overflow-x-auto p-2">
              <div className="grid grid-cols-1 gap-2 sm:min-w-[720px] sm:grid-cols-7">
                {weekDays.map((day) => {
                  const key = dateKey(day);
                  const dayEvents = eventsByDay.get(key) ?? [];
                  const isToday = key === todayISO();
                  const isSaturday = day.getDay() === 6;
                  return (
                    <div
                      key={key}
                      className={cn(
                        "flex min-h-[9rem] flex-col rounded-xl border border-border bg-background",
                        isSaturday && "bg-muted/30",
                        isToday && "bg-accent/30 ring-1 ring-inset ring-primary/30",
                      )}
                    >
                      <div className="border-b border-border px-2 py-1.5 text-center">
                        <p className="text-xs font-semibold text-foreground">{DAY_LABELS[day.getDay()]}</p>
                        <p className="text-[11px] text-muted-foreground">{dateShort(day).slice(0, 5)}</p>
                      </div>
                      <div className="max-h-64 flex-1 space-y-1.5 overflow-y-auto p-1.5">
                        {dayEvents.length ? (
                          dayEvents.map((event) => {
                            const assigned = (shiftsByEvent.get(event.id) ?? []).length;
                            const selected = event.id === selectedEventId;
                            return (
                              <div
                                key={event.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedEventId(event.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setSelectedEventId(event.id);
                                  }
                                }}
                                className={cn(
                                  "cursor-pointer rounded-lg border p-1.5 text-start text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                  selected ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted",
                                )}
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="font-semibold text-foreground">{timeShort(event.start_time)}</span>
                                  <Link
                                    to="/events/$id"
                                    params={{ id: event.id }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-muted-foreground hover:text-primary"
                                    aria-label="פתיחת האירוע"
                                  >
                                    <ExternalLink className="size-3" />
                                  </Link>
                                </div>
                                <p className="mt-0.5 line-clamp-2 font-medium text-foreground">{event.title}</p>
                                {clientName(event.client_id) && !sameDisplayName(event.title, clientName(event.client_id)) ? (
                                  <p className="truncate text-muted-foreground">{clientName(event.client_id)}</p>
                                ) : null}
                                {event.venue ? (
                                  <p className="flex items-center gap-0.5 truncate text-muted-foreground">
                                    <MapPin className="size-2.5 shrink-0" />
                                    {event.venue}
                                  </p>
                                ) : null}
                                <div className="mt-1">
                                  {assigned === 0 ? (
                                    <span className="inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                      לא מאויש
                                    </span>
                                  ) : (
                                    <span className="inline-flex rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                                      {num(assigned)} עובדים
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <p className="px-1 py-2 text-center text-[10px] text-muted-foreground">אין אירועים</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <aside className="min-w-0 max-h-[45vh] overflow-y-auto rounded-xl border border-border bg-card lg:max-h-none lg:min-h-0">
          <div className="bg-card">
            <div className="border-b border-border p-3">
              {selectedEvent ? (
                <>
                  <p className="text-sm font-semibold text-foreground">{selectedEvent.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {dateLong(selectedEvent.event_date)} · {timeShort(selectedEvent.start_time)}
                    {selectedEvent.venue ? ` · ${selectedEvent.venue}` : ""}
                  </p>
                  <p className="mt-1 text-xs font-medium text-primary">משובצים: {num(selectedShifts.length)}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">בחר אירוע מהיומן כדי לשבץ צוות</p>
              )}
            </div>

            <div className="space-y-2 p-3">
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="חיפוש איש צוות"
                    className="h-10 ps-8"
                    aria-label="חיפוש איש צוות"
                  />
                </div>
                <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="h-10 w-28" aria-label="סינון לפי תפקיד">
                  <option value="all">כל התפקידים</option>
                  {roles.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </Select>
              </div>

              {selectedEvent && !canAssign ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  אין לך הרשאה לשבץ צוות
                </p>
              ) : null}

              {filteredCrew.length ? (
                filteredCrew.map((member) => {
                  const assignedShift = selectedShifts.find((shift) => shift.crew_member_id === member.id);
                  const conflict = conflictFor(member);
                  const weekCount = weekShiftCount.get(member.id) ?? 0;
                  return (
                    <div key={member.id} className="rounded-lg border border-border bg-background p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-2">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
                            {initials(member.full_name)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{member.full_name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {crewRolesLabel(member)}
                              {member.phone ? ` · ${member.phone}` : ""}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{num(weekCount)} שיבוצים השבוע</p>
                            {conflict ? (
                              <p className="mt-1 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                משובץ לאירוע אחר באותו יום: {conflict.title}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {assignedShift ? (
                            <>
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                                משובץ · {assignedShift.role_title}
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!canAssign || busyId === member.id}
                                onClick={() => unassign(member)}
                              >
                                הסר
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              disabled={!selectedEvent || !canAssign || busyId === member.id}
                              onClick={() => assign(member)}
                            >
                              שבץ
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <EmptyState icon={Users} title="אין אנשי צוות" description="הוסיפו אנשי צוות במסך צוות בשטח כדי לשבץ אותם לאירועים." />
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
