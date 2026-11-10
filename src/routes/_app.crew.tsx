import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight, FileText, HardHat, Pencil, Phone, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useCrewDocuments, useCrewMembers, useEvents, useProfiles, useShifts } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { dateKey, dateLong, dateShort, money, num, timeRange, timeShort, todayISO } from "@/lib/format";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton, SectionCard, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { CrewDocumentsDialog } from "@/components/crew/crew-documents-dialog";
import { cn } from "@/lib/utils";
import { isFullScope } from "@/lib/scope";
import { assignableCrew, findCrewByName } from "@/lib/crew";
import { CREW_ROLES, crewRoleOptions, crewRoles, crewRolesLabel } from "@/lib/crew-roles";
import type { CrewMember, Shift } from "@/lib/types";

export const Route = createFileRoute("/_app/crew")({ component: CrewPage });

const CREW_DOC_TYPES = ["id_card", "driver_license", "height_license"] as const;

function CrewPage() {
  const { user, profile, can, isAdmin } = useSession();
  const fullScope = isFullScope(profile, isAdmin);
  const eventsQ = useEvents(can("crew") || can("calendar") || !fullScope);
  const crewQ = useCrewMembers(can("crew") || !fullScope);
  const shiftsQ = useShifts(can("crew"));
  const documentsQ = useCrewDocuments(undefined, can("crew"));
  const profilesQ = useProfiles(can("crew") || can("calendar"));
  const [tab, setTab] = useState<"schedule" | "members">("schedule");
  const [date, setDate] = useState(todayISO());
  const [shiftOpen, setShiftOpen] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<CrewMember | null>(null);
  const [deletingShift, setDeletingShift] = useState<Shift | null>(null);
  const [deletingMember, setDeletingMember] = useState<CrewMember | null>(null);
  const [documentsMember, setDocumentsMember] = useState<CrewMember | null>(null);
  const [busy, setBusy] = useState(false);

  const events = eventsQ.data ?? [];
  const allCrew = crewQ.data ?? [];
  const shifts = shiftsQ.data ?? [];
  const profiles = profilesQ.data ?? [];
  const documents = documentsQ.data ?? [];
  const crew = assignableCrew(
    allCrew.filter((member) => {
      if (!member.user_id) return true;
      const linked = profiles.find((profile) => profile.id === member.user_id);
      return !linked || linked.approval_status === "approved";
    }),
    profiles,
  );

  const dayShifts = useMemo(
    () => shifts.filter((s) => dateKey(s.starts_at) === date).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [shifts, date],
  );

  if (!can("crew") && fullScope) return <NoAccess moduleLabel="מודול צוות בשטח" />;
  if (crewQ.isLoading || shiftsQ.isLoading || eventsQ.isLoading) return <PageSkeleton />;
  if (crewQ.error || shiftsQ.error || eventsQ.error) {
    return (
      <ErrorState
        message={((crewQ.error || shiftsQ.error || eventsQ.error) as Error).message}
        onRetry={() => {
          crewQ.refetch();
          shiftsQ.refetch();
          eventsQ.refetch();
        }}
      />
    );
  }

  const canEdit = fullScope && can("crew", "edit");
  const isCrewRole = profile?.role === "crew" && !isAdmin;
  const myCrewIds = crew.filter((c) => c.user_id === user?.id).map((c) => c.id);

  if (!fullScope) {
    const mine = crew.filter((c) => c.user_id === user?.id);
    const myShifts = shifts
      .filter((s) => myCrewIds.includes(s.crew_member_id))
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
    return (
      <div>
        <PageHeader title="הכרטיס שלי" description="פרטי הצוות והמשמרות שלך" />
        {mine.length ? (
          <div className="space-y-4">
            {mine.map((c) => (
              <SectionCard key={c.id} title={c.full_name} description={crewRolesLabel(c)}>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">טלפון</dt>
                    <dd className="font-medium text-foreground" dir="ltr">{c.phone || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">תפקיד</dt>
                    <dd className="font-medium text-foreground">{crewRolesLabel(c) || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">תעריף שעתי</dt>
                    <dd className="font-medium text-foreground">{c.hourly_rate != null ? money(c.hourly_rate) : "—"}</dd>
                  </div>
                </dl>
              </SectionCard>
            ))}
          </div>
        ) : (
          <SectionCard title="הכרטיס שלי">
            <EmptyState icon={UserRound} title="לא נמצא כרטיס צוות" description="פנה למנהל כדי לקשר את המשתמש לכרטיס הצוות שלך." />
          </SectionCard>
        )}
        <div className="mt-4">
          <SectionCard title="המשמרות שלי" description="המשמרות והשיבוצים שלך">
            {myShifts.length ? (
              <div className="space-y-2">
                {myShifts.map((s) => {
                  const ev = events.find((e) => e.id === s.event_id);
                  return (
                    <div key={s.id} className="rounded-xl border border-border bg-card p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{ev?.title ?? "אירוע"}</p>
                        <StatusPill status={s.status} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dateLong(s.starts_at)} · {timeRange(s.starts_at, s.ends_at)} · {s.role_title}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState icon={HardHat} title="אין משמרות משויכות אליך" description="כשתשובץ למשמרת היא תופיע כאן." />
            )}
          </SectionCard>
        </div>
      </div>
    );
  }

  function moveDay(delta: number) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  async function removeShift() {
    if (!deletingShift) return;
    setBusy(true);
    const { error } = await db.from("shifts").delete().eq("id", deletingShift.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את המשמרת");
      return;
    }
    toast.success("המשמרת נמחקה");
    setDeletingShift(null);
    shiftsQ.refetch();
  }

  async function removeMember() {
    if (!deletingMember) return;
    setBusy(true);
    const { error } = await db.from("crew_members").delete().eq("id", deletingMember.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את איש הצוות. ייתכן שיש משמרות משויכות.");
      return;
    }
    toast.success("איש הצוות נמחק");
    setDeletingMember(null);
    crewQ.refetch();
  }

  async function setShiftStatus(s: Shift, status: string) {
    const { error } = await db.from("shifts").update({ status }).eq("id", s.id);
    if (error) {
      toast.error("לא הצלחנו לעדכן את הסטטוס");
      return;
    }
    toast.success("סטטוס המשמרת עודכן");
    shiftsQ.refetch();
  }

  return (
    <div>
      <PageHeader
        title={isCrewRole ? "המשמרות שלי" : "צוות בשטח"}
        description={isCrewRole ? "המשמרות והשיבוצים שלך" : "אנשי צוות, משמרות ושיבוצים לאירועים"}
        actions={
          canEdit ? (
            <Button type="button" size="sm" onClick={() => (tab === "schedule" ? setShiftOpen(true) : (setEditingMember(null), setMemberOpen(true)))}>
              <Plus className="size-4" />
              {tab === "schedule" ? "שיבוץ משמרת" : "איש צוות חדש"}
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-border bg-card p-1" role="tablist" aria-label="תצוגת צוות">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "schedule"}
          onClick={() => setTab("schedule")}
          className={cn("min-h-11 flex-1 rounded-lg px-3 text-sm font-medium", tab === "schedule" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
        >
          לוח שיבוצים
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "members"}
          onClick={() => setTab("members")}
          className={cn("min-h-11 flex-1 rounded-lg px-3 text-sm font-medium", tab === "members" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
        >
          אנשי צוות ({num(crew.length)})
        </button>
      </div>

      {tab === "schedule" ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <Button type="button" variant="outline" size="icon" onClick={() => moveDay(-1)} aria-label="יום קודם">
                <ChevronRight className="size-4" />
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setDate(todayISO())}>
                היום
              </Button>
              <Button type="button" variant="outline" size="icon" onClick={() => moveDay(1)} aria-label="יום הבא">
                <ChevronLeft className="size-4" />
              </Button>
              <div className="ms-2">
                <p className="text-sm font-semibold text-foreground">{dateLong(date)}</p>
                <p className="text-xs text-muted-foreground">{num(dayShifts.length)} משמרות</p>
              </div>
            </div>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11 sm:max-w-44" aria-label="בחירת תאריך" />
          </div>

          {!dayShifts.length ? (
            <div className="rounded-xl border border-border bg-card">
              <EmptyState
                icon={HardHat}
                title="אין משמרות ביום הזה"
                description={isCrewRole ? "לא שובצת למשמרות בתאריך הזה." : "אפשר לשבץ איש צוות לאירוע דרך כפתור השיבוץ."}
                action={
                  canEdit ? (
                    <Button type="button" size="sm" onClick={() => setShiftOpen(true)}>
                      <Plus className="size-4" />
                      שיבוץ משמרת
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="space-y-3">
              {dayShifts.map((s) => {
                const ev = events.find((e) => e.id === s.event_id);
                const member = crew.find((c) => c.id === s.crew_member_id);
                const mine = myCrewIds.includes(s.crew_member_id);
                return (
                  <div key={s.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-foreground">{member?.full_name ?? "איש צוות"}</p>
                          <StatusPill status={s.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {s.role_title} · {timeRange(s.starts_at, s.ends_at)}
                          {member?.phone ? ` · ${member.phone}` : ""}
                        </p>
                        {ev ? (
                          <Link to="/events/$id" params={{ id: ev.id }} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                            <CalendarDays className="size-4" />
                            {ev.title}
                          </Link>
                        ) : null}
                        {s.notes ? <p className="mt-1 text-xs text-muted-foreground">{s.notes}</p> : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {mine && s.status !== "הגיע" ? (
                          <Button type="button" size="sm" variant="outline" onClick={() => setShiftStatus(s, "הגיע")}>
                            הגעתי
                          </Button>
                        ) : null}
                        {canEdit ? (
                          <>
                            <Select
                              aria-label="עדכון סטטוס משמרת"
                              value={s.status}
                              onChange={(e) => setShiftStatus(s, e.target.value)}
                              className="h-11 w-32 text-xs"
                            >
                              {["משובץ", "אושר", "הגיע", "לא הגיע"].map((st) => (
                                <option key={st} value={st}>{st}</option>
                              ))}
                            </Select>
                            <button
                              type="button"
                              aria-label="מחיקת משמרת"
                              onClick={() => setDeletingShift(s)}
                              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {!crew.length ? (
            <div className="rounded-xl border border-border bg-card">
              <EmptyState
                icon={UserRound}
                title="אין אנשי צוות"
                description="הוספת אנשי צוות תאפשר לשבץ אותם לאירועים ולעקוב אחרי משמרות."
                action={
                  canEdit ? (
                    <Button type="button" size="sm" onClick={() => (setEditingMember(null), setMemberOpen(true))}>
                      <Plus className="size-4" />
                      איש צוות חדש
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {crew.map((c) => {
                const linked = profiles.find((p) => p.id === c.user_id);
                const upcoming = shifts.filter((s) => s.crew_member_id === c.id && dateKey(s.starts_at) >= todayISO()).length;
                return (
                  <div key={c.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{c.full_name}</p>
                        <p className="text-xs text-muted-foreground">{crewRolesLabel(c)}</p>
                        {c.user_id ? (
                          <span className="mt-1 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800">משתמש מחובר</span>
                        ) : null}
                        {(() => {
                          const memberDocs = documents.filter((doc) => doc.crew_member_id === c.id);
                          const missing = CREW_DOC_TYPES.filter((type) => {
                            const doc = memberDocs.find((item) => item.doc_type === type);
                            return !doc || Boolean(doc.expiry_date && doc.expiry_date < todayISO());
                          }).length;
                          return (
                            <span
                              className={cn(
                                "mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                                missing ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800",
                              )}
                            >
                              {missing ? `חסרים ${missing} מסמכים` : "כל המסמכים הועלו"}
                            </span>
                          );
                        })()}
                      </div>
                      <StatusPill status={c.is_active ? "אושר" : "לא הגיע"} />
                    </div>
                    <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                      {c.phone ? (
                        <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 hover:text-foreground">
                          <Phone className="size-3.5" />
                          <span dir="ltr">{c.phone}</span>
                        </a>
                      ) : null}
                      <p>משמרות קרובות: {num(upcoming)}</p>
                      <p>{linked ? `משתמש מקושר: ${linked.full_name}` : "לא מקושר למשתמש"}</p>
                    </div>
                    {canEdit ? (
                      <div className="mt-3 flex items-center justify-end gap-1 border-t border-border/60 pt-3">
                        <button
                          type="button"
                          aria-label="מסמכים"
                          onClick={() => setDocumentsMember(c)}
                          className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <FileText className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="עריכת איש צוות"
                          onClick={() => {
                            setEditingMember(c);
                            setMemberOpen(true);
                          }}
                          className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="מחיקת איש צוות"
                          onClick={() => setDeletingMember(c)}
                          className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <ShiftForm
        open={shiftOpen}
        onOpenChange={setShiftOpen}
        events={events}
        crew={crew}
        defaultDate={date}
        onSaved={() => shiftsQ.refetch()}
      />

      <MemberForm
        open={memberOpen}
        onOpenChange={setMemberOpen}
        member={editingMember}
        profiles={profiles}
        existingCrew={allCrew}
        onSaved={() => crewQ.refetch()}
      />

      <CrewDocumentsDialog
        open={!!documentsMember}
        onOpenChange={(value) => !value && setDocumentsMember(null)}
        crewMember={documentsMember}
        canEdit={canEdit}
        onChanged={() => documentsQ.refetch()}
      />

      <ConfirmDialog
        open={!!deletingShift}
        onOpenChange={(v) => !v && setDeletingShift(null)}
        title="מחיקת משמרת"
        description="האם למחוק את המשמרת?"
        onConfirm={removeShift}
        busy={busy}
      />
      <ConfirmDialog
        open={!!deletingMember}
        onOpenChange={(v) => !v && setDeletingMember(null)}
        title="מחיקת איש צוות"
        description={`האם למחוק את ${deletingMember?.full_name ?? ""}? משמרות משויכות יימחקו גם הן.`}
        onConfirm={removeMember}
        busy={busy}
      />
    </div>
  );
}

function ShiftForm({
  open,
  onOpenChange,
  events,
  crew,
  defaultDate,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  events: import("@/lib/types").EventRow[];
  crew: CrewMember[];
  defaultDate: string;
  onSaved: () => void;
}) {
  const [eventId, setEventId] = useState("");
  const [crewId, setCrewId] = useState("");
  const [role, setRole] = useState("טכנאי");
  const [start, setStart] = useState(`${defaultDate}T14:00`);
  const [end, setEnd] = useState(`${defaultDate}T23:00`);
  const [status, setStatus] = useState("משובץ");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!eventId) {
      setError("נא לבחור אירוע.");
      return;
    }
    if (!crewId) {
      setError("נא לבחור איש צוות.");
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
    setEventId("");
    setCrewId("");
    setNotes("");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="שיבוץ משמרת"
      description="בחירת אירוע, איש צוות ושעות"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" form="crew-shift-form" disabled={busy}>{busy ? "שומר…" : "שיבוץ"}</Button>
        </div>
      }
    >
      <form id="crew-shift-form" onSubmit={save} className="space-y-4">
        <Field label="אירוע" htmlFor="cs-event">
          <Select id="cs-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">בחירת אירוע</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.title} · {dateShort(ev.event_date)}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="איש צוות" htmlFor="cs-crew">
            <Select id="cs-crew" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">בחירת איש צוות</option>
              {crew.filter((c) => c.is_active).map((c) => (
                <option key={c.id} value={c.id}>{c.full_name} · {crewRolesLabel(c)}</option>
              ))}
            </Select>
          </Field>
          <Field label="תפקיד" htmlFor="cs-role">
            <Select id="cs-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {CREW_ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="התחלה" htmlFor="cs-start">
            <Input id="cs-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="h-11" />
          </Field>
          <Field label="סיום" htmlFor="cs-end">
            <Input id="cs-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="סטטוס" htmlFor="cs-status">
          <Select id="cs-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {["משובץ", "אושר", "הגיע", "לא הגיע"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="הערות" htmlFor="cs-notes">
          <Textarea id="cs-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="נקודת מפגש, ציוד אישי" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function MemberForm({
  open,
  onOpenChange,
  member,
  profiles,
  existingCrew,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  member: CrewMember | null;
  profiles: import("@/lib/types").Profile[];
  existingCrew: CrewMember[];
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [rate, setRate] = useState("");
  const [active, setActive] = useState(true);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(member?.full_name ?? "");
      setPhone(member?.phone ?? "");
      setRoles(member ? crewRoles(member) : ["טכנאי"]);
      setRate(member?.hourly_rate != null ? String(member.hourly_rate) : "");
      setActive(member?.is_active ?? true);
      setUserId(member?.user_id ?? "");
      setError(null);
    }
  }

  function toggleRole(role: string) {
    setRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("נא להזין שם מלא.");
      return;
    }
    setBusy(true);
    const payload = {
      full_name: name.trim(),
      phone: phone.trim() || null,
      role_title: roles[0] ?? "",
      crew_roles: roles,
      hourly_rate: rate ? Number(rate) : null,
      is_active: active,
      user_id: userId || null,
    };
    const duplicate = member ? null : findCrewByName(existingCrew, payload.full_name);
    const reused = !member && Boolean(duplicate);
    const targetId = member?.id ?? duplicate?.id ?? null;
    const { error: dbError } = targetId
      ? await db.from("crew_members").update(payload).eq("id", targetId)
      : await db.from("crew_members").insert(payload);
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשמור את איש הצוות. נסה שוב.");
      return;
    }
    toast.success(member || reused ? "איש הצוות עודכן" : "איש הצוות נוצר");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={member ? "עריכת איש צוות" : "איש צוות חדש"}
      description="פרטי קשר, תפקיד וקישור לחשבון משתמש"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" form="member-form" disabled={busy}>{busy ? "שומר…" : "שמירה"}</Button>
        </div>
      }
    >
      <form id="member-form" onSubmit={save} className="space-y-4">
        <Field label="שם מלא" htmlFor="member-name">
          <Input id="member-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: אבי מזרחי" className="h-11" />
        </Field>
        <Field label="טלפון" htmlFor="member-phone">
          <Input id="member-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" dir="ltr" className="h-11 text-start" />
        </Field>
        <Field label="תפקידים" htmlFor="member-roles" hint="אפשר לבחור יותר מתפקיד אחד">
          <div id="member-roles" role="group" aria-label="תפקידים" className="flex flex-wrap gap-2">
            {crewRoleOptions(member).map((r) => {
              const selected = roles.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleRole(r)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {r}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="תעריף שעתי (₪)" htmlFor="member-rate">
            <Input id="member-rate" type="number" min={0} step="any" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" className="h-11" />
          </Field>
          <Field label="סטטוס" htmlFor="member-active">
            <Select id="member-active" value={active ? "1" : "0"} onChange={(e) => setActive(e.target.value === "1")}>
              <option value="1">פעיל</option>
              <option value="0">לא פעיל</option>
            </Select>
          </Field>
        </div>
        <Field label="קישור לחשבון משתמש" htmlFor="member-user" hint="קישור מאפשר לאיש הצוות לראות רק את המשמרות שלו">
          <Select id="member-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">ללא קישור</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name} · {p.email}</option>
            ))}
          </Select>
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}
