import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, Clock, FileText, Plus } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useEvents, useProfiles, useTimeEntries, useTimeEntryAdditions } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { ClockCard } from "@/components/attendance/clock-card";
import { EntryDialog } from "@/components/attendance/entry-dialog";
import { AttendanceTable } from "@/components/attendance/attendance-table";
import { ManualFlags } from "@/components/attendance/manual-flags";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, SectionCard, StatCard, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { dateShort, money, todayISO, weekdayShort } from "@/lib/format";
import {
  DAY_TYPE_LABELS,
  ENTRY_STATUS_LABELS,
  entryMinutes,
  formatMinutes,
  minutesBetween,
  monthKeyOf,
  n,
  nowTime,
} from "@/lib/attendance";
import type { TimeEntry } from "@/lib/types";

export const Route = createFileRoute("/_app/attendance")({ component: AttendancePage });

function AttendancePage() {
  const { user, profile, can, isAdmin } = useSession();
  const canManage = can("attendance", "edit");
  const canEditOthers = can("attendance", "edit");
  const entriesQ = useTimeEntries(!!user?.id, undefined, isAdmin ? undefined : user?.id);
  const additionsQ = useTimeEntryAdditions(!!user?.id, isAdmin ? undefined : user?.id);
  const profilesQ = useProfiles(can("attendance", "view"));
  const eventsQ = useEvents(canManage || can("clients") || can("calendar"));
  const [tab, setTab] = useState<"clock" | "team">("clock");
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [month, setMonth] = useState(() => monthKeyOf(new Date()));

  const entries = entriesQ.data ?? [];
  const additions = additionsQ.data ?? [];
  const profiles = profilesQ.data ?? [];
  const events = eventsQ.data ?? [];

  const myEntries = useMemo(
    () => entries.filter((entry) => entry.user_id === user?.id),
    [entries, user?.id],
  );
  const openEntry = useMemo(
    () => myEntries.find((entry) => entry.start_time && !entry.end_time) ?? null,
    [myEntries],
  );
  const recent = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const key = monthKeyOf(cutoff) + "-" + String(cutoff.getDate()).padStart(2, "0");
    return myEntries
      .filter((entry) => entry.work_date >= key)
      .sort((a, b) => b.work_date.localeCompare(a.work_date));
  }, [myEntries]);
  const monthEntries = useMemo(
    () => myEntries.filter((entry) => (entry.work_date ?? "").startsWith(month)),
    [myEntries, month],
  );
  const monthMinutes = monthEntries.reduce((sum, entry) => sum + entryMinutes(entry), 0);
  const monthAdditions = additions
    .filter((a) => monthEntries.some((entry) => entry.id === a.entry_id))
    .reduce((sum, a) => sum + n(a.amount), 0);
  const monthTravelKm = monthEntries.reduce((sum, entry) => sum + n(entry.travel_km), 0);

  if (entriesQ.isLoading || additionsQ.isLoading || (canManage && profilesQ.isLoading)) return <PageSkeleton />;
  if (entriesQ.error || additionsQ.error || (canManage && profilesQ.error)) {
    return (
      <ErrorState
        message={((entriesQ.error || additionsQ.error || (canManage ? profilesQ.error : null)) as Error).message}
        onRetry={() => {
          entriesQ.refetch();
          additionsQ.refetch();
          if (canManage) profilesQ.refetch();
        }}
      />
    );
  }

  async function clockIn() {
    if (!user?.id) return;
    if (openEntry) {
      toast.error("כבר יש משמרת פעילה");
      return;
    }
    setBusy(true);
    const now = new Date();
    const { error } = await db.from("time_entries").insert({
      id: crypto.randomUUID(),
      user_id: user.id,
      work_date: todayISO(),
      start_time: nowTime(),
      break_minutes: 0,
      day_type: "work",
      shift_type: now.getHours() >= 18 ? "evening" : "day",
      travel_km: 0,
      travel_amount: 0,
      status: "submitted",
      entry_source: "clock",
      created_by: user.id,
    });
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו להתחיל משמרת. נסה שוב.");
      return;
    }
    toast.success("המשמרת התחילה");
    entriesQ.refetch();
  }

  async function clockOut(breakMinutes: number) {
    if (!openEntry) return;
    const total = minutesBetween(openEntry.start_time, nowTime());
    if (total == null || (total > 0 && breakMinutes >= total)) {
      toast.error("דקות ההפסקה גדולות משעות המשמרת");
      return;
    }
    setBusy(true);
    const { error } = await db
      .from("time_entries")
      .update({ end_time: nowTime(), break_minutes: breakMinutes })
      .eq("id", openEntry.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו לסיים את המשמרת. נסה שוב.");
      return;
    }
    toast.success("המשמרת הסתיימה");
    entriesQ.refetch();
  }

  async function setApproval(entry: TimeEntry, approved: boolean) {
    if (!can("attendance", "edit")) {
      toast.error("אין לך הרשאה לאשר דיווחי שעות");
      return;
    }
    setBusy(true);
    const { error } = await db
      .from("time_entries")
      .update({
        status: approved ? "approved" : "submitted",
        approved_by: approved ? user?.id : null,
        approved_at: approved ? new Date().toISOString() : null,
      })
      .eq("id", entry.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו לעדכן את האישור");
      return;
    }
    toast.success(approved ? "היום אושר" : "האישור בוטל");
    entriesQ.refetch();
  }

  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(entry: TimeEntry) {
    setEditing(entry);
    setDialogOpen(true);
  }

  function additionsFor(entryId: string) {
    return additions.filter((a) => a.entry_id === entryId);
  }

  return (
    <div>
      <PageHeader
        title={isAdmin ? "שעון נוכחות" : "הדיווחים שלי"}
        description={
          isAdmin
            ? "דיווח שעות, תוספות, נסיעות והערה יומית — והכל בדוח החודשי"
            : "דיווחי שעות, תוספות ונסיעות שלך בלבד"
        }
        actions={
          can("attendance", "edit") ? (
            <Button type="button" onClick={openNew}>
              <Plus className="size-4" /> הוספת דיווח ידני
            </Button>
          ) : null
        }
      />

      <div className="mb-5 flex flex-wrap gap-2">
        <Button type="button" variant={tab === "clock" ? "default" : "outline"} onClick={() => setTab("clock")}>
          <Clock className="size-4" /> השעון שלי
        </Button>
        {canManage ? (
          <Button type="button" variant={tab === "team" ? "default" : "outline"} onClick={() => setTab("team")}>
            <CalendarDays className="size-4" /> כל העובדים
          </Button>
        ) : null}
        <Button asChild variant="outline">
          <Link to="/attendance-report">
            <FileText className="size-4" /> דוח חודשי
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/my-documents">
            <FileText className="size-4" /> המסמכים שלי
          </Link>
        </Button>
      </div>

      {tab === "clock" || !canManage ? (
        <div className="space-y-5">
          {profile?.role === "crew" || can("attendance", "edit") ? (
            <ClockCard openEntry={openEntry} busy={busy} onClockIn={clockIn} onClockOut={clockOut} />
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="שעות בחודש" value={formatMinutes(monthMinutes)} icon={Clock} />
            <StatCard label="תוספות כספיות" value={money(monthAdditions)} icon={FileText} tone="amber" />
            <StatCard label="קילומטרים" value={`${monthTravelKm.toLocaleString("he-IL")} ק"מ`} icon={CalendarDays} tone="blue" />
          </div>

          <SectionCard
            title="הימים האחרונים"
            description={profile ? `הדיווחים של ${profile.full_name} ב-30 הימים האחרונים` : "30 הימים האחרונים"}
          >
            {recent.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="עוד אין דיווחים"
                description="התחל משמרת או הוסף דיווח ידני כדי לראות את הימים כאן."
                action={<Button type="button" onClick={openNew}><Plus className="size-4" /> הוספת דיווח</Button>}
              />
            ) : (
              <div className="space-y-2">
                {recent.map((entry) => {
                  const adds = additionsFor(entry.id);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => openEdit(entry)}
                      className="flex w-full flex-col gap-2 rounded-xl border border-border/70 p-3 text-start transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{dateShort(entry.work_date)}</p>
                          <span className="text-xs text-muted-foreground">{weekdayShort(entry.work_date)}</span>
                          <StatusPill status={ENTRY_STATUS_LABELS[entry.status]} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {DAY_TYPE_LABELS[entry.day_type]} · {formatMinutes(entryMinutes(entry))} · {adds.length} תוספות
                          {n(entry.travel_km) ? ` · ${n(entry.travel_km)} ק"מ` : ""}
                        </p>
                        {entry.note ? <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{entry.note}</p> : null}
                        <ManualFlags entry={entry} profiles={isAdmin ? profiles : profile ? [profile] : []} />
                      </div>
                      <span className="text-xs font-medium text-primary">פתיחה</span>
                    </button>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </div>
      ) : (
        <AttendanceTable
          entries={entries}
          additions={additions}
          profiles={profiles}
          month={month}
          onMonthChange={setMonth}
          onApprove={setApproval}
          onEdit={openEdit}
          busy={busy}
          canEdit={canEditOthers}
        />
      )}

      <EntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={editing}
        additions={editing ? additionsFor(editing.id) : []}
        employees={isAdmin ? profiles : profile ? [profile] : []}
        canManageOthers={can("attendance", "edit")}
        currentUserId={user?.id ?? ""}
        events={events}
        onSaved={() => {
          entriesQ.refetch();
          additionsQ.refetch();
        }}
      />
    </div>
  );
}
