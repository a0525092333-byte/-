import { EVENT_DELETE_OWNER_ONLY_MESSAGE } from "@/lib/permissions";
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowRight,
  Boxes,
  CalendarDays,
  CircleDollarSign,
  Clock,
  FileText,
  HardHat,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Printer,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  useAssignments,
  useClients,
  useCrewMembers,
  useDocuments,
  useEquipment,
  useEvents,
  useEventDayCrew,
  useEventDayCrewNames,
  useEventDays,
  useFinance,
  useProfiles,
  useShifts,
} from "@/hooks/use-data";
import { dataApiToken, db } from "@/integrations/neon/client";
import { dateLong, dateShort, money, num, timeRange, timeShort, todayISO, toDateInput, weekdayShort } from "@/lib/format";
import { isMultiDayEvent } from "@/lib/events";
import { assignableCrew } from "@/lib/crew";
import { CREW_ROLES, crewRolesLabel } from "@/lib/crew-roles";
import { ClientContactsList } from "@/components/clients/client-contacts-list";
import { notifyDataChanged, setEditingActive } from "@/lib/data-events";
import { EmptyState, ErrorState, PageSkeleton, SectionCard, StatCard, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { FloatingWindow } from "@/components/floating-window";
import { EventForm } from "@/components/event-form";
import { EventAccountingButton, EventAccountingSummaryLink } from "@/components/events/event-accounting-button";
import { EventQuoteButton, EventQuotesSection } from "@/components/events/event-quotes";
import { isFullScope } from "@/lib/scope";
import { NoAccessScreen } from "@/components/require-full-scope";
import { ImageUpload } from "@/components/image-upload";
import { cn } from "@/lib/utils";
import type { EquipmentAssignment, FinanceEntry, Shift } from "@/lib/types";

export const Route = createFileRoute("/_app/events/$id")({ component: EventDetail });

const TABS = [
  { key: "overview", label: "סקירה" },
  { key: "crew", label: "צוות" },
  { key: "equipment", label: "ציוד" },
  { key: "finance", label: "כספים" },
  { key: "documents", label: "מסמכים" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function EventDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user, profile, can, isAdmin, isSuperAdmin } = useSession();
  const fullScope = isFullScope(profile, isAdmin);
  const eventsQ = useEvents();
  const clientsQ = useClients(can("clients") || can("calendar") || can("finance") || can("crew") || can("equipment"));
  const crewQ = useCrewMembers(can("crew"));
  const shiftsQ = useShifts(can("crew"));
  const equipmentQ = useEquipment(can("equipment"));
  const assignmentsQ = useAssignments(can("equipment"));
  const financeQ = useFinance(can("finance"));
  const documentsQ = useDocuments(can("clients") || can("calendar") || can("finance") || can("crew") || can("equipment"));
  const profilesQ = useProfiles(can("crew") || can("calendar"));
  const eventDaysQ = useEventDays(id, can("calendar") || can("crew") || can("clients"));
  const dayCrewQ = useEventDayCrew(can("calendar") || can("crew") || can("clients"));
  const dayCrewNamesQ = useEventDayCrewNames(id, can("calendar") || can("crew") || can("clients"));

  const openFinance = useRouterState({ select: (state) => state.location.hash === "finance" });
  const [tab, setTab] = useState<TabKey>(openFinance && can("finance") ? "finance" : "overview");
  const [editOpen, setEditOpen] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [financeOpen, setFinanceOpen] = useState(false);
  const [deleteShift, setDeleteShift] = useState<Shift | null>(null);
  const [deleteAssign, setDeleteAssign] = useState<EquipmentAssignment | null>(null);
  const [docName, setDocName] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [docBusy, setDocBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteEventOpen, setDeleteEventOpen] = useState(false);

  const event = (eventsQ.data ?? []).find((e) => e.id === id) ?? null;
  const client = event?.client_id ? (clientsQ.data ?? []).find((c) => c.id === event.client_id) ?? null : null;
  const crew = assignableCrew(crewQ.data ?? [], profilesQ.data ?? []);
  const eventDays = (eventDaysQ.data ?? []).filter((d) => d.event_id === id).sort((a, b) => a.day_date.localeCompare(b.day_date));
  const dayCrewRows = dayCrewQ.data ?? [];
  const dayCrewNames = dayCrewNamesQ.data ?? {};
  const shifts = (shiftsQ.data ?? []).filter((s) => s.event_id === id);
  const equipment = equipmentQ.data ?? [];
  const assignments = (assignmentsQ.data ?? []).filter((a) => a.event_id === id);
  const finance = (financeQ.data ?? []).filter((f) => f.event_id === id);
  const documents = (documentsQ.data ?? []).filter((d) => d.event_id === id);

  const financeSummary = useMemo(() => {
    const invoiced = finance.filter((f) => f.kind === "חשבונית").reduce((s, f) => s + Number(f.amount ?? 0), 0);
    const received = finance.filter((f) => f.kind === "תשלום" && f.status === "שולם").reduce((s, f) => s + Number(f.amount ?? 0), 0);
    const expenses = finance.filter((f) => f.kind === "הוצאה").reduce((s, f) => s + Number(f.amount ?? 0), 0);
    const expected = Number(event?.total_amount ?? 0);
    const due = (invoiced || expected) - received;
    return { invoiced, received, expenses, expected, due };
  }, [finance, event?.total_amount]);

  const ledger = useMemo(() => {
    const sorted = [...finance].sort((a, b) => (a.issued_at ?? a.created_at).localeCompare(b.issued_at ?? b.created_at));
    let running = 0;
    return sorted.map((f) => {
      const amount = Number(f.amount ?? 0);
      if (f.kind === "תשלום" && f.status === "שולם") running += amount;
      if (f.kind === "הוצאה") running -= amount;
      return { ...f, running };
    });
  }, [finance]);

  if (eventsQ.isLoading) return <PageSkeleton />;
  if (eventsQ.error) return <ErrorState message={(eventsQ.error as Error).message} onRetry={() => eventsQ.refetch()} />;
  if (!event) {
    if (!fullScope) {
      return <NoAccessScreen message="אין לך הרשאה לצפות באירוע הזה." />;
    }
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState
          icon={CalendarDays}
          title="האירוע לא נמצא"
          description="ייתכן שהאירוע נמחק או שאין לך הרשאה לצפות בו."
          action={
            <Button asChild variant="outline">
              <Link to="/events">חזרה לאירועים</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const canEditEvent = fullScope && can("clients", "edit");
  const canEditCrew = fullScope && can("crew", "edit");
  const canEditEquipment = fullScope && can("equipment", "edit");
  const canEditFinance = fullScope && can("finance", "edit");
  const myCrewIds = crew.filter((c) => c.user_id === user?.id).map((c) => c.id);
  const isAssignedCrew =
    myCrewIds.length > 0 &&
    (shifts.some((s) => myCrewIds.includes(s.crew_member_id)) ||
      dayCrewRows.some(
        (dc) => myCrewIds.includes(dc.crew_member_id) && eventDays.some((d) => d.id === dc.event_day_id),
      ));
  const canViewCrewSheet =
    isSuperAdmin ||
    can("calendar", "view") ||
    can("crew", "view") ||
    event.sales_rep_id === user?.id ||
    isAssignedCrew;

  async function saveNotes() {
    if (notes === null) return;
    setSavingNotes(true);
    const { error } = await db.from("events").update({ notes: notes.trim() || null }).eq("id", event!.id);
    setSavingNotes(false);
    if (error) {
      toast.error("לא הצלחנו לשמור את ההערות");
      return;
    }
    toast.success("ההערות נשמרו");
    setNotes(null);
    eventsQ.refetch();
  }

  async function returnEquipment(a: EquipmentAssignment) {
    const { error } = await db.from("equipment_assignments").update({ returned_at: new Date().toISOString() }).eq("id", a.id);
    if (error) {
      toast.error("לא הצלחנו לרשום החזרה");
      return;
    }
    toast.success("הציוד הוחזר למחסן");
    assignmentsQ.refetch();
    equipmentQ.refetch();
  }

  async function removeShift() {
    if (!deleteShift) return;
    setBusy(true);
    const { error } = await db.from("shifts").delete().eq("id", deleteShift.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את המשמרת");
      return;
    }
    toast.success("המשמרת נמחקה");
    setDeleteShift(null);
    shiftsQ.refetch();
  }

  async function addDocument() {
    if (!docUrl) {
      toast.error("נא להעלות קובץ קודם");
      return;
    }
    setDocBusy(true);
    const { error } = await db.from("documents").insert({
      event_id: event!.id,
      name: docName.trim() || "מסמך",
      url: docUrl,
      uploaded_by: user?.id ?? null,
    });
    setDocBusy(false);
    if (error) {
      toast.error("לא הצלחנו לשמור את המסמך");
      return;
    }
    toast.success("המסמך נוסף לאירוע");
    setDocName("");
    setDocUrl("");
    documentsQ.refetch();
  }

  async function removeDocument(docId: string) {
    const { error } = await db.from("documents").delete().eq("id", docId);
    if (error) {
      toast.error("לא הצלחנו למחוק את המסמך");
      return;
    }
    toast.success("המסמך נמחק");
    documentsQ.refetch();
  }

  async function removeAssignment() {
    if (!deleteAssign) return;
    setBusy(true);
    const { error } = await db.from("equipment_assignments").delete().eq("id", deleteAssign.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את שיבוץ הציוד");
      return;
    }
    toast.success("שיבוץ הציוד נמחק");
    setDeleteAssign(null);
    assignmentsQ.refetch();
    equipmentQ.refetch();
  }

  async function removeEvent() {
    if (!event) return;
    if (!isSuperAdmin) {
      toast.error(EVENT_DELETE_OWNER_ONLY_MESSAGE);
      setDeleteEventOpen(false);
      return;
    }
    setBusy(true);
    try {
      const token = await dataApiToken();
      const res = await fetch(`/api/events/${event.id}/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast.error(data?.message || "לא הצלחנו למחוק את האירוע. נסה שוב.");
        return;
      }
      toast.success("האירוע נמחק");
      notifyDataChanged("events");
      setDeleteEventOpen(false);
      await eventsQ.refetch();
      navigate({ to: "/events" });
    } catch {
      toast.error("לא הצלחנו להתחבר לשרת — נסה שוב.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/events" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowRight className="size-4" />
        חזרה לאירועים
      </Link>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{event.title}</h1>
            <StatusPill status={event.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {event.event_type} · {dateLong(event.event_date)}
            {event.start_time ? ` · ${timeRange(event.start_time, event.end_time)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {fullScope ? <EventQuoteButton eventId={event.id} canCreate={can("quotes", "edit")} variant="default" /> : null}
          {canViewCrewSheet ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/events/$id/crew-sheet" params={{ id: event.id }}>
                <Printer className="size-4" />
                דוח אירוע
              </Link>
            </Button>
          ) : null}
          <EventAccountingButton eventId={event.id} />
          {canEditEvent ? (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              עריכת אירוע
            </Button>
          ) : null}
          {isSuperAdmin ? (
            <span className="sm:ms-1 sm:border-s sm:border-border sm:ps-2">
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteEventOpen(true)}
              >
                <Trash2 className="size-4" />
                מחיקת אירוע
              </Button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="לקוח" value={client?.name ?? "—"} icon={Users} tone="default" hint={client?.contact_name ?? undefined} />
        <div className="space-y-1">
          <StatCard label="מקום" value={event.venue || "—"} icon={MapPin} tone="default" hint={event.address ?? undefined} />
          <EventAccountingSummaryLink eventId={event.id} />
        </div>
        <StatCard label="משתתפים" value={event.guest_count ? num(event.guest_count) : "—"} icon={Users} tone="default" />
        {fullScope ? (
          <StatCard label="תקציב" value={money(event.total_amount)} icon={CircleDollarSign} tone="blue" hint={event.sales_rep_name ? `איש מכירות: ${event.sales_rep_name}` : undefined} />
        ) : null}
      </div>

      <div className="mb-5 rounded-xl border border-border bg-card p-4">
        <p className="mb-2 text-sm font-semibold text-foreground">לוח זמנים</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">הגעה למחסן</p>
            <p className="text-sm font-medium text-foreground">{timeShort(event.warehouse_time)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">מוכנות האירוע</p>
            <p className="text-sm font-medium text-foreground">{timeShort(event.ready_time)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">התחלה</p>
            <p className="text-sm font-medium text-foreground">{timeShort(event.start_time)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">סיום</p>
            <p className="text-sm font-medium text-foreground">{timeShort(event.end_time)}</p>
          </div>
        </div>
      </div>

      {isMultiDayEvent(event, eventDays) ? (
        <div className="mb-5 rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">לוז ימים</p>
            <span className="text-xs text-muted-foreground">{eventDays.length} {eventDays.length === 1 ? "יום" : "ימים"}</span>
          </div>
          <div className="space-y-3">
            {eventDays.map((day) => {
              const dayCrew = dayCrewRows.filter((c) => c.event_day_id === day.id);
              return (
                <div key={day.id} className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="mb-2 text-sm font-semibold text-foreground">{weekdayShort(day.day_date)} · {dateLong(day.day_date)}</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div><p className="text-xs text-muted-foreground">מחסן</p><p className="text-sm font-medium text-foreground">{timeShort(day.warehouse_time)}</p></div>
                    <div><p className="text-xs text-muted-foreground">מוכנים</p><p className="text-sm font-medium text-foreground">{timeShort(day.ready_time)}</p></div>
                    <div><p className="text-xs text-muted-foreground">תחילה</p><p className="text-sm font-medium text-foreground">{timeShort(day.start_time)}</p></div>
                    <div><p className="text-xs text-muted-foreground">סיום</p><p className="text-sm font-medium text-foreground">{timeShort(day.end_time)}</p></div>
                  </div>
                  {(dayCrewNames[day.id] ?? []).length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(dayCrewNames[day.id] ?? []).map((c, i) => (
                        <span key={`${day.id}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-1 text-xs text-accent-foreground">
                          {c.name}
                          {c.role ? <span className="text-muted-foreground">· {c.role}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {day.notes ? <p className="mt-2 text-xs text-muted-foreground">{day.notes}</p> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 no-scrollbar" role="tablist" aria-label="לשוניות אירוע">
        {(fullScope ? TABS : TABS.filter((t) => t.key !== "finance")).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "min-h-11 shrink-0 rounded-lg px-4 text-sm font-medium transition-colors",
              tab === t.key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <SectionCard title="פרטי האירוע">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Detail label="סוג אירוע" value={event.event_type} />
                <Detail label="תאריך" value={dateLong(event.event_date)} />
                <Detail label="שעות" value={event.start_time ? timeRange(event.start_time, event.end_time) : "—"} />
                <Detail label="מקום" value={event.venue || "—"} />
                <Detail label="כתובת" value={event.address || "—"} />
                <Detail label="איש מכירות" value={event.sales_rep_name || "—"} />
                <Detail label="מספר משתתפים" value={event.guest_count ? num(event.guest_count) : "—"} />
                {fullScope ? <Detail label="תקציב משוער" value={money(event.total_amount)} /> : null}
              </dl>
            </SectionCard>

            <SectionCard
              title="הערות"
              description="בקשות מיוחדות, סידורי הגעה ואנשי קשר"
              action={
                canEditEvent ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => setNotes(event.notes ?? "")} disabled={notes !== null}>
                    <Pencil className="size-4" />
                    עריכה
                  </Button>
                ) : null
              }
            >
              {notes !== null ? (
                <div className="space-y-3">
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="כתיבת הערות לאירוע" />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setNotes(null)}>
                      ביטול
                    </Button>
                    <Button type="button" size="sm" onClick={saveNotes} disabled={savingNotes}>
                      {savingNotes ? "שומר…" : "שמירה"}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {event.notes || "אין הערות לאירוע הזה."}
                </p>
              )}
            </SectionCard>

            {fullScope ? <EventQuotesSection eventId={event.id} canView={can("quotes")} canCreate={can("quotes", "edit")} /> : null}
          </div>

          <div className="space-y-5">
            <SectionCard title="כרטיס לקוח" description={client ? "פרטי קשר" : "לא משויך לקוח"}>
              {client ? (
                <div className="space-y-3 text-sm">
                  <p className="font-semibold text-foreground">{client.name}</p>
                  {fullScope ? (
                    <>
                      {client.contact_name ? <p className="text-muted-foreground">איש קשר: {client.contact_name}</p> : null}
                      {client.phone ? (
                        <a href={`tel:${client.phone}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                          <Phone className="size-4" />
                          <span dir="ltr">{client.phone}</span>
                        </a>
                      ) : null}
                      {client.email ? (
                        <a href={`mailto:${client.email}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                          <Mail className="size-4" />
                          <span dir="ltr">{client.email}</span>
                        </a>
                      ) : null}
                      <ClientContactsList client={client} className="space-y-2" />
                      <Button asChild variant="outline" size="sm" className="w-full">
                        <Link to="/clients">לכרטיס הלקוח</Link>
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">לא נבחר לקוח לאירוע.</p>
              )}
            </SectionCard>

            <SectionCard title="סיכום מהיר">
              <dl className="space-y-3 text-sm">
                <SummaryRow label="משמרות משובצות" value={num(shifts.length)} />
                <SummaryRow label="פריטי ציוד" value={num(assignments.filter((a) => !a.returned_at).length)} />
                {fullScope && can("finance") ? <SummaryRow label="יתרה פתוחה" value={money(financeSummary.due)} /> : null}
              </dl>
            </SectionCard>
          </div>
        </div>
      ) : null}

      {tab === "crew" ? (
        <SectionCard
          title="צוות בשטח"
          description={`${shifts.length} משמרות משובצות`}
          action={
            canEditCrew ? (
              <Button type="button" size="sm" onClick={() => setShiftOpen(true)}>
                <Plus className="size-4" />
                שיבוץ משמרת
              </Button>
            ) : null
          }
          bodyClassName="p-0"
        >
          {!shifts.length ? (
            <EmptyState
              icon={HardHat}
              title="אין משמרות משובצות"
              description="שיבוץ צוות לאירוע יופיע כאן עם שעות הגעה ותפקיד."
              action={
                canEditCrew ? (
                  <Button type="button" size="sm" onClick={() => setShiftOpen(true)}>
                    <Plus className="size-4" />
                    שיבוץ משמרת
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-border/70">
              {shifts.map((s) => {
                const member = crew.find((c) => c.id === s.crew_member_id) ?? (crewQ.data ?? []).find((c) => c.id === s.crew_member_id);
                const mine = myCrewIds.includes(s.crew_member_id);
                return (
                  <li key={s.id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{member?.full_name ?? "איש צוות"}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.role_title} · {timeRange(s.starts_at, s.ends_at)}
                        {member?.phone ? ` · ${member.phone}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill status={s.status} />
                      {mine && s.status !== "הגיע" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const { error } = await db.from("shifts").update({ status: "הגיע" }).eq("id", s.id);
                            if (error) toast.error("לא הצלחנו לעדכן את הסטטוס");
                            else {
                              toast.success("סומן שהגעת למשמרת");
                              shiftsQ.refetch();
                            }
                          }}
                        >
                          הגעתי
                        </Button>
                      ) : null}
                      {canEditCrew ? (
                        <button
                          type="button"
                          aria-label="מחיקת משמרת"
                          onClick={() => setDeleteShift(s)}
                          className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {tab === "equipment" ? (
        <SectionCard
          title="ציוד לאירוע"
          description={`${assignments.filter((a) => !a.returned_at).length} פריטים בחוץ`}
          action={
            canEditEquipment ? (
              <Button type="button" size="sm" onClick={() => setAssignOpen(true)}>
                <Plus className="size-4" />
                שיבוץ ציוד
              </Button>
            ) : null
          }
          bodyClassName="p-0"
        >
          {!assignments.length ? (
            <EmptyState
              icon={Boxes}
              title="לא שובץ ציוד"
              description="שיבוץ ציוד מהמחסן לאירוע יופיע כאן עם תאריכי יציאה והחזרה."
              action={
                canEditEquipment ? (
                  <Button type="button" size="sm" onClick={() => setAssignOpen(true)}>
                    <Plus className="size-4" />
                    שיבוץ ציוד
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-border/70">
              {assignments.map((a) => {
                const item = equipment.find((e) => e.id === a.equipment_item_id);
                return (
                  <li key={a.id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {item?.name ?? "פריט ציוד"} <span className="num text-muted-foreground">× {num(a.quantity)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        יצא ב־{dateShort(a.out_at)} · {a.returned_at ? `הוחזר ב־${dateShort(a.returned_at)}` : "טרם הוחזר"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill status={a.returned_at ? "במחסן" : "בשטח"} />
                      {!a.returned_at && canEditEquipment ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => returnEquipment(a)}>
                          החזר ציוד
                        </Button>
                      ) : null}
                      {canEditEquipment ? (
                        <button
                          type="button"
                          aria-label="מחיקת שיבוץ ציוד"
                          onClick={() => setDeleteAssign(a)}
                          className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {fullScope && tab === "finance" ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="הכנסות צפויות" value={money(financeSummary.expected)} icon={Wallet} tone="default" />
            <StatCard label="נגבה" value={money(financeSummary.received)} icon={CircleDollarSign} tone="green" />
            <StatCard label="יתרה פתוחה" value={money(financeSummary.due)} icon={CircleDollarSign} tone={financeSummary.due > 0 ? "amber" : "green"} />
            <StatCard label="הוצאות" value={money(financeSummary.expenses)} icon={Wallet} tone="red" />
          </div>

          <SectionCard
            title="תנועות כספיות"
            description="הצעות מחיר, חשבוניות, תשלומים והוצאות"
            action={
              canEditFinance ? (
                <Button type="button" size="sm" onClick={() => setFinanceOpen(true)}>
                  <Plus className="size-4" />
                  תנועה חדשה
                </Button>
              ) : null
            }
            bodyClassName="p-0"
          >
            {!ledger.length ? (
              <EmptyState
                icon={Wallet}
                title="אין תנועות כספיות"
                description="הוספת הצעת מחיר, חשבונית או תשלום תציג כאן את יתרת האירוע."
                action={
                  canEditFinance ? (
                    <Button type="button" size="sm" onClick={() => setFinanceOpen(true)}>
                      <Plus className="size-4" />
                      תנועה חדשה
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 text-start font-medium">סוג</th>
                      <th className="px-4 py-2.5 text-start font-medium">אסמכתא</th>
                      <th className="px-4 py-2.5 text-start font-medium">תאריך</th>
                      <th className="px-4 py-2.5 text-start font-medium">סטטוס</th>
                      <th className="px-4 py-2.5 text-start font-medium">סכום</th>
                      <th className="px-4 py-2.5 text-start font-medium">יתרה מצטברת</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {ledger.map((f) => (
                      <tr key={f.id}>
                        <td className="px-4 py-3 font-medium text-foreground">{f.kind}</td>
                        <td className="px-4 py-3 text-muted-foreground">{f.doc_number || "—"}</td>
                        <td className="num px-4 py-3 text-muted-foreground">{dateShort(f.issued_at ?? f.created_at)}</td>
                        <td className="px-4 py-2.5"><StatusPill status={f.status} /></td>
                        <td className="num px-4 py-3 font-medium text-foreground">{money(f.amount)}</td>
                        <td className="num px-4 py-3 text-muted-foreground">{money(f.running)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {tab === "documents" ? (
        <SectionCard title="מסמכים" description={`${documents.length} קבצים מצורפים`} bodyClassName="p-0">
          {canEditEvent ? (
            <div className="border-b border-border p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="שם המסמך" htmlFor="doc-name">
                  <Input id="doc-name" value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="לדוגמה: חוזה חתום" className="h-11" />
                </Field>
                <div className="flex flex-wrap items-end gap-2">
                  <ImageUpload
                    value={docUrl}
                    onChange={setDocUrl}
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                    label="העלאת מסמך"
                    preview={false}
                  />
                  <Button type="button" onClick={addDocument} disabled={docBusy || !docUrl}>
                    {docBusy ? "שומר…" : "הוספה"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {!documents.length ? (
            <EmptyState
              icon={FileText}
              title="אין מסמכים לאירוע"
              description="אפשר לצרף חוזה, הזמנת עבודה או אישור תשלום."
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground hover:text-primary"
                  >
                    <FileText className="size-4 shrink-0" />
                    <span className="truncate">{d.name}</span>
                  </a>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{dateShort(d.created_at)}</span>
                    {canEditEvent ? (
                      <button
                        type="button"
                        aria-label="מחיקת מסמך"
                        onClick={() => removeDocument(d.id)}
                        className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      <EventForm
        open={editOpen}
        onOpenChange={setEditOpen}
        event={event}
        clients={clientsQ.data ?? []}
        profiles={profilesQ.data ?? []}
        currentProfile={profile}
        isAdmin={isAdmin}
        onSaved={() => eventsQ.refetch()}
      />

      <ShiftDialog
        open={shiftOpen}
        onOpenChange={setShiftOpen}
        eventId={event.id}
        eventDate={event.event_date}
        crew={crew}
        onSaved={() => shiftsQ.refetch()}
      />

      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        eventId={event.id}
        equipment={equipment}
        onSaved={() => {
          assignmentsQ.refetch();
          equipmentQ.refetch();
        }}
      />

      <FinanceDialog
        open={financeOpen}
        onOpenChange={setFinanceOpen}
        eventId={event.id}
        userId={user?.id}
        onSaved={() => financeQ.refetch()}
      />

      <ConfirmDialog
        open={!!deleteShift}
        onOpenChange={(v) => !v && setDeleteShift(null)}
        title="מחיקת משמרת"
        description="האם למחוק את המשמרת מהאירוע?"
        onConfirm={removeShift}
        busy={busy}
      />
      <ConfirmDialog
        open={!!deleteAssign}
        onOpenChange={(v) => !v && setDeleteAssign(null)}
        title="מחיקת שיבוץ ציוד"
        description="האם להסיר את פריט הציוד מהאירוע? הכמות הזמינה תתעדכן."
        onConfirm={removeAssignment}
        busy={busy}
      />
      <ConfirmDialog
        open={deleteEventOpen}
        onOpenChange={setDeleteEventOpen}
        title={`מחיקת האירוע "${event.title}"`}
        description={`האירוע "${event.title}" מתאריך ${dateLong(event.event_date)} יימחק לצמיתות ולא ניתן יהיה לשחזר אותו. יימחקו גם ימי האירוע, שיבוצי הצוות והציוד והמסמכים שלו. הצעות מחיר, דיווחי שעות ותנועות כספיות יישמרו ויוסרו מהאירוע.`}
        confirmLabel="מחק את האירוע"
        onConfirm={removeEvent}
        busy={busy}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function ShiftDialog({
  open,
  onOpenChange,
  eventId,
  eventDate,
  crew,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  eventId: string;
  eventDate: string;
  crew: import("@/lib/types").CrewMember[];
  onSaved: () => void;
}) {
  const [crewId, setCrewId] = useState("");
  const [role, setRole] = useState("טכנאי");
  const [start, setStart] = useState(`${toDateInput(eventDate)}T14:00`);
  const [end, setEnd] = useState(`${toDateInput(eventDate)}T23:00`);
  const [status, setStatus] = useState("משובץ");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEditingActive("shift-dialog", open);
    return () => setEditingActive("shift-dialog", false);
  }, [open]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!crewId) {
      setError("נא לבחור איש צוות.");
      return;
    }
    if (!start) {
      setError("נא לבחור שעת התחלה.");
      return;
    }
    setBusy(true);
    const { error: dbError } = await db.from("shifts").insert({
      event_id: eventId,
      crew_member_id: crewId,
      role_title: role,
      starts_at: new Date(start).toISOString(),
      ends_at: end ? new Date(end).toISOString() : null,
      status,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשמור את המשמרת. נסה שוב.");
      return;
    }
    toast.success("המשמרת שובצה");
    setCrewId("");
    setNotes("");
    onSaved();
    onOpenChange(false);
  }

  return (
    <FloatingWindow open={open} onClose={() => onOpenChange(false)} title="שיבוץ משמרת" storageKey="vincen:shift-window">
      <form id="shift-form" onSubmit={save} className="flex h-full flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="איש צוות" htmlFor="shift-crew">
          <Select id="shift-crew" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
            <option value="">בחירת איש צוות</option>
            {crew.filter((c) => c.is_active).map((c) => (
              <option key={c.id} value={c.id}>{c.full_name} · {crewRolesLabel(c)}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="תפקיד באירוע" htmlFor="shift-role">
            <Select id="shift-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {CREW_ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <Field label="סטטוס" htmlFor="shift-status">
            <Select id="shift-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {["משובץ", "אושר", "הגיע", "לא הגיע"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="התחלה" htmlFor="shift-start">
            <Input id="shift-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="h-11" />
          </Field>
          <Field label="סיום" htmlFor="shift-end">
            <Input id="shift-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="shift-notes">
          <Textarea id="shift-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ציוד אישי, נקודת מפגש" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border p-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" disabled={busy}>{busy ? "שומר…" : "שיבוץ"}</Button>
        </div>
      </form>
    </FloatingWindow>
  );
}

function AssignDialog({
  open,
  onOpenChange,
  eventId,
  equipment,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  eventId: string;
  equipment: import("@/lib/types").EquipmentItem[];
  onSaved: () => void;
}) {
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("1");
  const [outAt, setOutAt] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEditingActive("assign-dialog", open);
    return () => setEditingActive("assign-dialog", false);
  }, [open]);

  const selected = equipment.find((e) => e.id === itemId);
  const available = selected ? Math.max(0, Number(selected.quantity_total ?? 0) - Number(selected.quantity_out ?? 0)) : 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!itemId) {
      setError("נא לבחור פריט ציוד.");
      return;
    }
    const quantity = Number(qty);
    if (!quantity || quantity < 1) {
      setError("הכמות חייבת להיות לפחות 1.");
      return;
    }
    if (quantity > available) {
      setError(`אין מספיק מלאי. זמין כרגע: ${available}.`);
      return;
    }
    setBusy(true);
    const { error: dbError } = await db.from("equipment_assignments").insert({
      equipment_item_id: itemId,
      event_id: eventId,
      quantity,
      out_at: outAt,
      returned_at: null,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשבץ את הציוד. ייתכן שהמלאי השתנה — נסה שוב.");
      return;
    }
    toast.success("הציוד שובץ לאירוע");
    setItemId("");
    setQty("1");
    setNotes("");
    onSaved();
    onOpenChange(false);
  }

  return (
    <FloatingWindow open={open} onClose={() => onOpenChange(false)} title="שיבוץ ציוד" storageKey="vincen:assign-window">
      <form id="assign-form" onSubmit={save} className="flex h-full flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="פריט ציוד" htmlFor="assign-item">
          <Select id="assign-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">בחירת פריט</option>
            {equipment.map((e) => {
              const avail = Math.max(0, Number(e.quantity_total ?? 0) - Number(e.quantity_out ?? 0));
              return (
                <option key={e.id} value={e.id} disabled={avail <= 0}>
                  {e.name} · זמין {avail}
                </option>
              );
            })}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="כמות" htmlFor="assign-qty" hint={selected ? `זמין: ${available}` : undefined}>
            <Input id="assign-qty" type="number" min={1} max={available || undefined} value={qty} onChange={(e) => setQty(e.target.value)} className="h-11" />
          </Field>
          <Field label="תאריך יציאה" htmlFor="assign-out">
            <Input id="assign-out" type="date" value={outAt} onChange={(e) => setOutAt(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="assign-notes">
          <Textarea id="assign-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="מצב הפריט, אביזרים נלווים" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border p-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" disabled={busy}>{busy ? "משבץ…" : "שיבוץ"}</Button>
        </div>
      </form>
    </FloatingWindow>
  );
}

function FinanceDialog({
  open,
  onOpenChange,
  eventId,
  userId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  eventId: string;
  userId?: string;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState("חשבונית");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("ממתין");
  const [docNumber, setDocNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(todayISO());
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = Number(amount);
    if (!value || value <= 0) {
      setError("נא להזין סכום גדול מאפס.");
      return;
    }
    setBusy(true);
    const { error: dbError } = await db.from("finance_entries").insert({
      event_id: eventId,
      kind,
      amount: value,
      status,
      doc_number: docNumber.trim() || null,
      issued_at: issuedAt || null,
      due_at: dueAt || null,
      paid_at: status === "שולם" ? todayISO() : null,
      notes: notes.trim() || null,
      created_by: userId ?? null,
    });
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשמור את התנועה. נסה שוב.");
      return;
    }
    toast.success("התנועה הכספית נשמרה");
    setAmount("");
    setDocNumber("");
    setNotes("");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="תנועה כספית חדשה"
      description="הצעת מחיר, חשבונית, תשלום או הוצאה"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" form="finance-form" disabled={busy}>{busy ? "שומר…" : "שמירה"}</Button>
        </div>
      }
    >
      <form id="finance-form" onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="סוג תנועה" htmlFor="fin-kind">
            <Select id="fin-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {["הצעת מחיר", "חוזה", "חשבונית", "תשלום", "הוצאה"].map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </Select>
          </Field>
          <Field label="סטטוס" htmlFor="fin-status">
            <Select id="fin-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {["ממתין", "שולם", "באיחור"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="סכום (₪)" htmlFor="fin-amount">
            <Input id="fin-amount" type="number" min={1} step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-11" />
          </Field>
          <Field label="מספר אסמכתא" htmlFor="fin-doc">
            <Input id="fin-doc" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="לדוגמה: 2026-1042" className="h-11" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="תאריך הנפקה" htmlFor="fin-issued">
            <Input id="fin-issued" type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className="h-11" />
          </Field>
          <Field label="תאריך פירעון" htmlFor="fin-due">
            <Input id="fin-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="fin-notes">
          <Textarea id="fin-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="פרטי חשבונית, תנאי תשלום" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}
