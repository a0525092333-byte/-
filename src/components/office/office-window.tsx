import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Ban, CalendarDays, Car, Check, Copy, FileText, MessageCircle, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox, Field } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import { EmptyState } from "@/components/shared";
import { dateShort, timeShort, todayISO, weekdayShort } from "@/lib/format";
import type {
  CompanyVehicle,
  CrewMember,
  CrewUnavailability,
  DispatchTask,
  DispatchTaskCrew,
  DispatchTaskType,
  EventRow,
} from "@/lib/types";

export const TASK_TYPE_META: Record<
  DispatchTaskType,
  { label: string; watermark: string; border: string; badge: string; dot: string }
> = {
  setup: {
    label: "הקמה",
    watermark: "הקמה",
    border: "border-r-4 border-r-orange-500 bg-orange-50/35",
    badge: "bg-orange-100 text-orange-800",
    dot: "bg-orange-500",
  },
  operation: {
    label: "הפעלה",
    watermark: "הפעלה",
    border: "border-r-4 border-r-blue-600 bg-blue-50/35",
    badge: "bg-blue-100 text-blue-800",
    dot: "bg-blue-600",
  },
  sub_zone: {
    label: "תת-זירה",
    watermark: "זירה",
    border: "border-r-4 border-r-amber-500 bg-amber-50/40",
    badge: "bg-amber-100 text-amber-900",
    dot: "bg-amber-500",
  },
  teardown: {
    label: "פירוק",
    watermark: "פירוק",
    border: "border-r-4 border-r-rose-500 bg-rose-50/30",
    badge: "bg-rose-100 text-rose-800",
    dot: "bg-rose-500",
  },
  rollover: {
    label: "גלגול ציוד",
    watermark: "גלגול",
    border: "border-r-4 border-r-purple-600 bg-purple-50/35",
    badge: "bg-purple-100 text-purple-800",
    dot: "bg-purple-600",
  },
};

export const TASK_ROLE_OPTIONS = [
  "ראש צוות - הקמה",
  "עובד הקמה",
  "מפעיל",
  "ראש צוות - פירוק",
  "עובד פירוק",
  "נהג",
] as const;

export function normalizeWaPhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  return digits.length >= 9 ? `972${digits}` : null;
}

export function taskDisplayTitle(task: DispatchTask, eventsMap: Map<string, EventRow>): string {
  const ev = task.event_id ? eventsMap.get(task.event_id) : undefined;
  const base = task.title_override?.trim() || ev?.venue?.trim() || ev?.title?.trim() || "משימת תפעול";
  return task.sub_location?.trim() ? `${base} · ${task.sub_location.trim()}` : base;
}

export function describeRideForMember(
  assignment: DispatchTaskCrew,
  allTaskCrew: DispatchTaskCrew[],
  task: DispatchTask,
  crewMap: Map<string, CrewMember>,
  vehicleMap: Map<string, CompanyVehicle>,
): string {
  const primaryVehicle = task.vehicle_id ? vehicleMap.get(task.vehicle_id)?.name : null;
  if (assignment.uses_personal_car) {
    const passengers = allTaskCrew
      .filter((c) => c.rides_with_member_id === assignment.crew_member_id && c.crew_member_id !== assignment.crew_member_id)
      .map((c) => crewMap.get(c.crew_member_id)?.full_name)
      .filter(Boolean);
    return passengers.length
      ? `יוצא עם רכבך האישי — אתה מסיע איתך את ${passengers.join(", ")} (השלמת מקום למשאית)`
      : "יוצא עם רכבך האישי (אל תשכח לדווח ק״מ בסיום המשמרת)";
  }
  if (assignment.rides_with_member_id) {
    const driverName = crewMap.get(assignment.rides_with_member_id)?.full_name ?? "איש צוות";
    return `נוסע עם ${driverName} ברכבו האישי (השלמת מקום למשאית)`;
  }
  if (assignment.assigned_vehicle_id) {
    const vName = vehicleMap.get(assignment.assigned_vehicle_id)?.name ?? primaryVehicle ?? "רכב חברה";
    const isDriver = assignment.task_roles.includes("נהג");
    return isDriver ? `${vName} (נהג)` : `נוסע ב-${vName}`;
  }
  if (primaryVehicle) {
    const isDriver = assignment.task_roles.includes("נהג");
    const splitRiders = allTaskCrew
      .filter((c) => c.uses_personal_car || c.rides_with_member_id)
      .map((c) => crewMap.get(c.crew_member_id)?.full_name)
      .filter(Boolean);
    const suffix = isDriver && splitRiders.length ? ` (${splitRiders.join(", ")} נוסעים ברכב משלים)` : "";
    return `${primaryVehicle}${isDriver ? " (נהג)" : ""}${suffix}`;
  }
  return "הגעה עצמאית / יתואם במחסן";
}

export function buildWorkerDayWhatsappMessage({
  member,
  dayDate,
  tasks,
  crewByTask,
  eventsMap,
  crewMap,
  vehicleMap,
  origin,
}: {
  member: CrewMember;
  dayDate: string;
  tasks: DispatchTask[];
  crewByTask: Map<string, DispatchTaskCrew[]>;
  eventsMap: Map<string, EventRow>;
  crewMap: Map<string, CrewMember>;
  vehicleMap: Map<string, CompanyVehicle>;
  origin: string;
}): string {
  const sorted = [...tasks].sort((a, b) =>
    (a.warehouse_time || a.start_time || "99:99").localeCompare(b.warehouse_time || b.start_time || "99:99"),
  );
  const lines: string[] = [
    `היי ${member.full_name}, סידור עבודה ל${weekdayShort(dayDate)} (${dateShort(dayDate)}):`,
    "",
  ];
  sorted.forEach((task, idx) => {
    const tc = crewByTask.get(task.id) ?? [];
    const mine = tc.find((c) => c.crew_member_id === member.id);
    if (!mine) return;
    const meta = TASK_TYPE_META[task.task_type];
    const title = taskDisplayTitle(task, eventsMap);
    const teammates = tc
      .filter((c) => c.crew_member_id !== member.id)
      .map((c) => crewMap.get(c.crew_member_id)?.full_name)
      .filter(Boolean);
    const times = [
      task.warehouse_time ? `מחסן: ${timeShort(task.warehouse_time)}` : null,
      task.start_time ? `התחלה: ${timeShort(task.start_time)}` : null,
      task.end_time ? `סיום משוער: ${timeShort(task.end_time)}` : null,
    ].filter(Boolean);
    const rolloverEv = task.rollover_to_event_id ? eventsMap.get(task.rollover_to_event_id) : null;

    lines.push(`${sorted.length > 1 ? `תחנה ${idx + 1} — ` : ""}${meta.label}: ${title}`);
    if (times.length) lines.push(`שעות: ${times.join(" | ")}`);
    if (mine.task_roles.length) lines.push(`תפקידך באירוע: ${mine.task_roles.join(" · ")}`);
    lines.push(`רכב והסעה: ${describeRideForMember(mine, tc, task, crewMap, vehicleMap)}`);
    if (teammates.length) lines.push(`צוות איתך: ${teammates.join(", ")}`);
    if (rolloverEv) lines.push(`גלגול ציוד ליעד: ${rolloverEv.title} (${dateShort(rolloverEv.event_date)})`);
    if (task.equipment_notes?.trim()) lines.push(`ציוד/תצורה: ${task.equipment_notes.trim()}`);
    if (task.ops_notes?.trim()) lines.push(`דגשים: ${task.ops_notes.trim()}`);
    if (mine.personal_note?.trim()) lines.push(`דגש אישי: ${mine.personal_note.trim()}`);
    if (task.event_id) lines.push(`דוח אירוע וסקיצות: ${origin}/events/${task.event_id}/crew-sheet`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

export function UnavailabilityDialog({
  open,
  onOpenChange,
  crewMembers,
  fixedMemberId,
  userId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  crewMembers: CrewMember[];
  fixedMemberId?: string | null;
  userId?: string | null;
  onSaved: () => void;
}) {
  const [memberId, setMemberId] = useState(fixedMemberId || crewMembers[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [allDay, setAllDay] = useState(true);
  const [fromTime, setFromTime] = useState("08:00");
  const [toTime, setToTime] = useState("16:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const targetMember = fixedMemberId || memberId;

  async function save() {
    if (!targetMember || !date) {
      toast.error("נא לבחור עובד ותאריך");
      return;
    }
    setBusy(true);
    const { error } = await db.from("crew_unavailability").insert({
      id: crypto.randomUUID(),
      crew_member_id: targetMember,
      unavailable_date: date,
      all_day: allDay,
      from_time: allDay ? null : fromTime,
      to_time: allDay ? null : toTime,
      reason: reason.trim() || null,
      created_by: userId ?? null,
    });
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו לשמור את העדכון");
      return;
    }
    toast.success("אי-הזמינות עודכנה בלוח השיבוץ");
    setReason("");
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="דיווח אי-זמינות / בקשת חופש"
      description="יופיע מיד באדום בסרגל זמינות הצוות של מנהל השיבוץ"
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>ביטול</Button>
          <Button type="button" onClick={save} disabled={busy}>{busy ? "שומר…" : "שמירת אילוץ"}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {!fixedMemberId ? (
          <Field label="עובד" htmlFor="unavail-member">
            <select
              id="unavail-member"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
            >
              <option value="">בחר איש צוות…</option>
              {crewMembers.map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="תאריך" htmlFor="unavail-date">
          <Input id="unavail-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-10" />
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox checked={allDay} onCheckedChange={setAllDay} label="לא זמין כל היום" />
          <span className="text-sm text-foreground">לא זמין כל היום</span>
        </div>
        {!allDay ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="משעה" htmlFor="unavail-from">
              <Input id="unavail-from" type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)} className="h-10" />
            </Field>
            <Field label="עד שעה" htmlFor="unavail-to">
              <Input id="unavail-to" type="time" value={toTime} onChange={(e) => setToTime(e.target.value)} className="h-10" />
            </Field>
          </div>
        ) : null}
        <Field label="סיבה קצרה (חופש / מילואים / לימודים)" htmlFor="unavail-reason">
          <Input id="unavail-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="לדוגמה: מילואים / אירוע משפחתי" className="h-10" />
        </Field>
      </div>
    </Dialog>
  );
}

export function DailyWhatsappDialog({
  open,
  onOpenChange,
  dayDate,
  dayTasks,
  crewByTask,
  eventsMap,
  crewMap,
  vehicleMap,
  onMarkedSent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dayDate: string;
  dayTasks: DispatchTask[];
  crewByTask: Map<string, DispatchTaskCrew[]>;
  eventsMap: Map<string, EventRow>;
  crewMap: Map<string, CrewMember>;
  vehicleMap: Map<string, CompanyVehicle>;
  onMarkedSent: () => void;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://www.nsmm.work";

  const workerBundles = useMemo(() => {
    const byMember = new Map<string, DispatchTask[]>();
    for (const task of dayTasks) {
      for (const c of crewByTask.get(task.id) ?? []) {
        const list = byMember.get(c.crew_member_id) ?? [];
        list.push(task);
        byMember.set(c.crew_member_id, list);
      }
    }
    return Array.from(byMember.entries())
      .map(([memberId, tasks]) => {
        const member = crewMap.get(memberId);
        if (!member) return null;
        const message = buildWorkerDayWhatsappMessage({
          member,
          dayDate,
          tasks,
          crewByTask,
          eventsMap,
          crewMap,
          vehicleMap,
          origin,
        });
        return { member, tasks, message, waPhone: normalizeWaPhone(member.phone) };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => a.member.full_name.localeCompare(b.member.full_name, "he"));
  }, [dayTasks, crewByTask, crewMap, dayDate, eventsMap, vehicleMap, origin]);

  async function sendToWorker(memberId: string, waPhone: string | null, message: string, taskIds: string[]) {
    if (!waPhone) {
      await navigator.clipboard.writeText(message).catch(() => {});
      toast.error("לעובד זה לא מוגדר טלפון — ההודעה הועתקה ללוח");
      return;
    }
    window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
    await db
      .from("dispatch_task_crew")
      .update({ whatsapp_sent_at: new Date().toISOString() })
      .eq("crew_member_id", memberId)
      .in("task_id", taskIds);
    onMarkedSent();
  }

  async function copyGroupSummary() {
    const lines = [`סידור עבודה מרוכז — ${weekdayShort(dayDate)} ${dateShort(dayDate)}:`, ""];
    for (const task of dayTasks) {
      const meta = TASK_TYPE_META[task.task_type];
      const title = taskDisplayTitle(task, eventsMap);
      const vNames = [
        task.vehicle_id ? vehicleMap.get(task.vehicle_id)?.name : null,
        ...(task.extra_vehicle_ids ?? []).map((vid) => vehicleMap.get(vid)?.name),
      ].filter(Boolean);
      const tc = crewByTask.get(task.id) ?? [];
      const names = tc
        .map((c) => {
          const n = crewMap.get(c.crew_member_id)?.full_name ?? "";
          if (c.uses_personal_car) return `${n} (רכב אישי)`;
          if (c.rides_with_member_id) return `${n} (נוסע עם ${crewMap.get(c.rides_with_member_id)?.full_name ?? ""})`;
          return n;
        })
        .filter(Boolean);
      lines.push(`• [${meta.label}] ${title}`);
      lines.push(`  מחסן: ${timeShort(task.warehouse_time)} | התחלה: ${timeShort(task.start_time)} | רכב: ${vNames.join(" + ") || "—"}`);
      lines.push(`  צוות: ${names.join(", ") || "טרם שובץ"}`);
      lines.push("");
    }
    await navigator.clipboard.writeText(lines.join("\n").trim());
    toast.success("הסידור המרוכז הועתק — אפשר להדביק בקבוצת הוואטסאפ");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`שליחת סידור עבודה — ${weekdayShort(dayDate)} ${dateShort(dayDate)}`}
      description="המערכת מאחדת אוטומטית את כל התחנות של כל עובד באותו יום, כולל פירוט מי מסיע את מי"
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={copyGroupSummary} disabled={!dayTasks.length}>
            <Copy className="size-4" /> העתק סידור מרוכז לקבוצה
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>סגירה</Button>
        </div>
      }
    >
      {!workerBundles.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">עדיין לא שובצו עובדים למשימות ביום זה.</p>
      ) : (
        <div className="max-h-[60vh] space-y-2.5 overflow-y-auto pe-1">
          {workerBundles.map(({ member, tasks, message, waPhone }) => (
            <div key={member.id} className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-foreground">{member.full_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {tasks.length} תחנות ביום זה · {member.phone || "ללא טלפון"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(message);
                      toast.success(`ההודעה של ${member.full_name} הועתקה`);
                    }}
                  >
                    <Copy className="size-3.5" /> העתק
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                    onClick={() => sendToWorker(member.id, waPhone, message, tasks.map((t) => t.id))}
                  >
                    <MessageCircle className="size-4" /> שלח בוואטסאפ
                  </Button>
                </div>
              </div>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-border/60 bg-background p-2.5 font-sans text-xs leading-relaxed text-foreground">
                {message}
              </pre>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function CrewSelfServiceView({
  myMember,
  tasks,
  taskCrew,
  unavailability,
  eventsMap,
  crewMap,
  vehicleMap,
  userId,
  onRefresh,
}: {
  myMember: CrewMember | null;
  tasks: DispatchTask[];
  taskCrew: DispatchTaskCrew[];
  unavailability: CrewUnavailability[];
  eventsMap: Map<string, EventRow>;
  crewMap: Map<string, CrewMember>;
  vehicleMap: Map<string, CompanyVehicle>;
  userId?: string | null;
  onRefresh: () => void;
}) {
  const [unavailOpen, setUnavailOpen] = useState(false);
  const today = todayISO();

  const crewByTask = useMemo(() => {
    const map = new Map<string, DispatchTaskCrew[]>();
    for (const row of taskCrew) {
      const list = map.get(row.task_id) ?? [];
      list.push(row);
      map.set(row.task_id, list);
    }
    return map;
  }, [taskCrew]);

  const myTasks = useMemo(() => {
    if (!myMember) return [];
    return tasks
      .filter((t) => t.task_date >= today && (crewByTask.get(t.id) ?? []).some((c) => c.crew_member_id === myMember.id))
      .sort((a, b) =>
        `${a.task_date} ${a.warehouse_time || a.start_time || ""}`.localeCompare(
          `${b.task_date} ${b.warehouse_time || b.start_time || ""}`,
        ),
      );
  }, [myMember, tasks, crewByTask, today]);

  const myUnavail = useMemo(
    () =>
      myMember
        ? unavailability
            .filter((u) => u.crew_member_id === myMember.id && u.unavailable_date >= today)
            .sort((a, b) => a.unavailable_date.localeCompare(b.unavailable_date))
        : [],
    [myMember, unavailability, today],
  );

  async function removeUnavail(id: string) {
    const { error } = await db.from("crew_unavailability").delete().eq("id", id);
    if (error) {
      toast.error("לא הצלחנו למחוק את האילוץ");
      return;
    }
    toast.success("האילוץ הוסר");
    onRefresh();
  }

  if (!myMember) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="המשתמש שלך טרם קושר לכרטיס איש צוות"
        description="בקש ממנהל המערכת לקשר את המשתמש שלך לכרטיס הצוות כדי לראות משמרות ולדווח זמינות."
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-4">
        <div>
          <h1 className="text-lg font-bold text-foreground">הסידור והזמינות שלי — {myMember.full_name}</h1>
          <p className="text-xs text-muted-foreground">כל ההקמות, ההפעלות, הרכבים והתפקידים שלך לימים הקרובים</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setUnavailOpen(true)}>
          <Ban className="size-4 text-red-600" /> עדכון אי-זמינות / חופש
        </Button>
      </div>

      {myUnavail.length > 0 ? (
        <div className="rounded-xl border border-red-200 bg-red-50/40 p-3.5">
          <p className="mb-2 text-xs font-bold text-red-900">ימים שדיווחת בהם אי-זמינות למנהל השיבוץ:</p>
          <div className="flex flex-wrap gap-2">
            {myUnavail.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs text-red-900">
                <strong>{weekdayShort(u.unavailable_date)} {dateShort(u.unavailable_date)}</strong>
                {!u.all_day ? `(${timeShort(u.from_time)}–${timeShort(u.to_time)})` : "(כל היום)"}
                {u.reason ? `· ${u.reason}` : ""}
                <button type="button" onClick={() => removeUnavail(u.id)} className="text-red-600 hover:text-red-800" aria-label="ביטול חסימה">
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {!myTasks.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState icon={CalendarDays} title="אין משימות קרובות משובצות עבורך" description="ברגע שמנהל הצוות ישבץ אותך להקמה, הפעלה או פירוק, כל הפרטים יופיעו כאן." />
        </div>
      ) : (
        <div className="space-y-3">
          {myTasks.map((task) => {
            const meta = TASK_TYPE_META[task.task_type];
            const tc = crewByTask.get(task.id) ?? [];
            const mine = tc.find((c) => c.crew_member_id === myMember.id)!;
            const rideText = describeRideForMember(mine, tc, task, crewMap, vehicleMap);
            const teammates = tc
              .filter((c) => c.crew_member_id !== myMember.id)
              .map((c) => crewMap.get(c.crew_member_id)?.full_name)
              .filter(Boolean);
            return (
              <div key={task.id} className={`relative overflow-hidden rounded-xl border border-border bg-card p-4 shadow-xs ${meta.border}`}>
                <span className="pointer-events-none absolute left-3 top-2 select-none text-3xl font-black text-foreground/[0.06]">
                  {meta.watermark}
                </span>
                <div className="relative space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${meta.badge}`}>{meta.label}</span>
                      <span className="text-xs font-semibold text-muted-foreground">
                        {weekdayShort(task.task_date)} · {dateShort(task.task_date)}
                      </span>
                    </div>
                    {task.event_id ? (
                      <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                        <Link to="/events/$id/crew-sheet" params={{ id: task.event_id }}>
                          <FileText className="size-3.5" /> דוח אירוע וסקיצות
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-base font-bold text-foreground">{taskDisplayTitle(task, eventsMap)}</p>
                  <p className="text-xs font-medium text-foreground">
                    {task.warehouse_time ? `התייצבות במחסן: ${timeShort(task.warehouse_time)} · ` : ""}
                    {task.start_time ? `התחלה: ${timeShort(task.start_time)}` : ""}
                    {task.end_time ? ` · סיום משוער: ${timeShort(task.end_time)}` : ""}
                  </p>
                  {mine.task_roles.length ? (
                    <div className="flex flex-wrap gap-1">
                      {mine.task_roles.map((r) => (
                        <span key={r} className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-900">
                          <Check className="me-0.5 inline size-3" /> {r}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-1.5 rounded-lg bg-background/80 px-2.5 py-1.5 text-xs font-medium text-foreground">
                    {mine.uses_personal_car ? <Car className="size-4 shrink-0 text-indigo-600" /> : <Truck className="size-4 shrink-0 text-muted-foreground" />}
                    <span>{rideText}</span>
                  </div>
                  {teammates.length ? <p className="text-xs text-muted-foreground">צוות איתך: {teammates.join(", ")}</p> : null}
                  {task.equipment_notes ? <p className="rounded bg-amber-50 px-2.5 py-1 text-xs text-amber-900">ציוד/תצורה: {task.equipment_notes}</p> : null}
                  {task.ops_notes ? <p className="text-xs text-muted-foreground">הערות תפעול: {task.ops_notes}</p> : null}
                  {mine.personal_note ? <p className="text-xs font-semibold text-indigo-800">דגש אישי עבורך: {mine.personal_note}</p> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <UnavailabilityDialog
        open={unavailOpen}
        onOpenChange={setUnavailOpen}
        crewMembers={[myMember]}
        fixedMemberId={myMember.id}
        userId={userId}
        onSaved={onRefresh}
      />
    </div>
  );
}
// END OF FILE - src/components/office/office-window.tsx
