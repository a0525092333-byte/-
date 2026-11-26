import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Car,
  ChevronLeft,
  ChevronRight,
  Crown,
  FileText,
  Maximize2,
  MessageCircle,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useCrewMembers, useEvents, useProfiles } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox, Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { ErrorState, NoAccess, PageSkeleton } from "@/components/shared";
import { dateKey, dateShort, timeShort, todayISO, weekdayShort } from "@/lib/format";
import { isFullScope } from "@/lib/scope";
import { assignableCrew } from "@/lib/crew";
import {
  CrewSelfServiceView,
  DailyWhatsappDialog,
  TASK_ROLE_OPTIONS,
  TASK_TYPE_META,
  UnavailabilityDialog,
  buildWorkerDayWhatsappMessage,
  normalizeWaPhone,
  taskDisplayTitle,
} from "./office-window";
import type {
  CompanyVehicle,
  CrewUnavailability,
  DispatchTask,
  DispatchTaskCrew,
  DispatchTaskType,
  EventRow,
} from "@/lib/types";

function startOfWeekSunday(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - c.getDay());
  return c;
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function timesOverlap(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null): boolean {
  if (!aStart || !bStart) return true;
  const s1 = aStart.slice(0, 5);
  const e1 = (aEnd || "23:59").slice(0, 5);
  const s2 = bStart.slice(0, 5);
  const e2 = (bEnd || "23:59").slice(0, 5);
  return s1 < e2 && s2 < e1;
}

type CrewDraftRow = {
  crew_member_id: string;
  task_roles: string[];
  uses_personal_car: boolean;
  assigned_vehicle_id: string;
  rides_with_member_id: string;
  personal_note: string;
};

type TaskForm = {
  id?: string;
  event_id: string;
  rollover_to_event_id: string;
  task_date: string;
  task_type: DispatchTaskType;
  title_override: string;
  sub_location: string;
  warehouse_time: string;
  start_time: string;
  end_time: string;
  vehicle_id: string;
  extra_vehicle_ids: string[];
  equipment_notes: string;
  ops_notes: string;
  crew: CrewDraftRow[];
};

function emptyTaskForm(date: string, event?: EventRow | null, type: DispatchTaskType = "setup"): TaskForm {
  return {
    event_id: event?.id ?? "",
    rollover_to_event_id: "",
    task_date: date,
    task_type: type,
    title_override: "",
    sub_location: "",
    warehouse_time: event?.warehouse_time?.slice(0, 5) ?? "",
    start_time: event?.start_time?.slice(0, 5) ?? "",
    end_time: event?.end_time?.slice(0, 5) ?? "",
    vehicle_id: "",
    extra_vehicle_ids: [],
    equipment_notes: "",
    ops_notes: "",
    crew: [],
  };
}

export function OfficeBoard() {
  const { can, isAdmin, profile, user } = useSession();
  const qc = useQueryClient();
  const fullScope = isFullScope(profile, isAdmin);
  const isBoardViewer =
    isAdmin ||
    profile?.role === "warehouse" ||
    can("office", "edit") ||
    (fullScope && can("office", "view"));
  const canEditBoard = isAdmin || profile?.role === "warehouse" || can("office", "edit");
  const canAccess = isBoardViewer || can("office", "view") || !fullScope;

  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekSunday(new Date()));
  const [twoWeeks, setTwoWeeks] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string>(() => todayISO());
  const [bankOpen, setBankOpen] = useState(true);
  const [onlyUnscheduled, setOnlyUnscheduled] = useState(false);
  const [highlightEventDate, setHighlightEventDate] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<TaskForm>(() => emptyTaskForm(todayISO()));
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DispatchTask | null>(null);
  const [waDialogOpen, setWaDialogOpen] = useState(false);
  const [unavailOpen, setUnavailOpen] = useState(false);

  useEffect(() => {
    const onFsState = (e: Event) => {
      const detail = (e as CustomEvent<{ fullscreen?: boolean }>).detail;
      if (typeof detail?.fullscreen === "boolean") setFullscreen(detail.fullscreen);
    };
    window.addEventListener("nsmm:dispatch-fullscreen-state", onFsState);
    return () => window.removeEventListener("nsmm:dispatch-fullscreen-state", onFsState);
  }, []);

  function toggleFullscreen() {
    const next = !fullscreen;
    setFullscreen(next);
    window.dispatchEvent(new CustomEvent("nsmm:dispatch-fullscreen", { detail: { fullscreen: next } }));
  }

  const dayCount = twoWeeks ? 14 : 7;
  const boardDays = useMemo(() => Array.from({ length: dayCount }, (_, i) => addDays(weekStart, i)), [weekStart, dayCount]);
  const rangeStart = dateKey(boardDays[0]);
  const bankEnd = dateKey(addDays(boardDays[boardDays.length - 1], 4));

  const eventsQ = useEvents(canAccess);
  const crewQ = useCrewMembers(canAccess);
  const clientsQ = useClients(isBoardViewer);
  const profilesQ = useProfiles(isBoardViewer);

  const vehiclesQ = useQuery({
    queryKey: ["company_vehicles"],
    enabled: canAccess,
    queryFn: async () => {
      const { data, error } = await db
        .from<CompanyVehicle[]>("company_vehicles")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const tasksQ = useQuery({
    queryKey: ["dispatch_tasks", isBoardViewer ? rangeStart : "crew"],
    enabled: canAccess,
    queryFn: async () => {
      let q = db
        .from<DispatchTask[]>("dispatch_tasks")
        .select("*")
        .order("task_date", { ascending: true })
        .order("sort_order", { ascending: true });
      if (isBoardViewer) {
        q = q.gte("task_date", dateKey(addDays(weekStart, -7))).lte("task_date", bankEnd);
      } else {
        q = q.gte("task_date", todayISO());
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const taskCrewQ = useQuery({
    queryKey: ["dispatch_task_crew"],
    enabled: canAccess,
    queryFn: async () => {
      const { data, error } = await db.from<DispatchTaskCrew[]>("dispatch_task_crew").select("*");
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const unavailQ = useQuery({
    queryKey: ["crew_unavailability"],
    enabled: canAccess,
    queryFn: async () => {
      const { data, error } = await db
        .from<CrewUnavailability[]>("crew_unavailability")
        .select("*")
        .gte("unavailable_date", dateKey(addDays(weekStart, -2)));
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["dispatch_tasks"] });
    qc.invalidateQueries({ queryKey: ["dispatch_task_crew"] });
    qc.invalidateQueries({ queryKey: ["crew_unavailability"] });
    qc.invalidateQueries({ queryKey: ["company_vehicles"] });
  };

  if (!canAccess) return <NoAccess moduleLabel="לוח תפעול ושיבוץ" />;
  if (eventsQ.isLoading || crewQ.isLoading || vehiclesQ.isLoading || tasksQ.isLoading || taskCrewQ.isLoading) {
    return <PageSkeleton />;
  }
  if (vehiclesQ.error || tasksQ.error) {
    return (
      <ErrorState
        message="לא הצלחנו לטעון את לוח התפעול — ודא שהרצת את סקריפט ה-SQL ב-Neon."
        onRetry={refreshAll}
      />
    );
  }

  const allEvents = eventsQ.data ?? [];
  const eventsMap = new Map(allEvents.map((e) => [e.id, e]));
  const clientsMap = new Map((clientsQ.data ?? []).map((c) => [c.id, c.name]));
  const rawCrew = crewQ.data ?? [];
  const activeCrew = isBoardViewer ? assignableCrew(rawCrew, profilesQ.data ?? []).filter((c) => c.is_active) : rawCrew;
  const crewMap = new Map(rawCrew.map((c) => [c.id, c]));
  const vehicles = vehiclesQ.data ?? [];
  const vehicleMap = new Map(vehicles.map((v) => [v.id, v]));
  const tasks = tasksQ.data ?? [];
  const taskCrew = taskCrewQ.data ?? [];
  const unavail = unavailQ.data ?? [];

  if (!isBoardViewer) {
    const myMember = rawCrew.find((c) => c.user_id === user?.id) ?? null;
    return (
      <CrewSelfServiceView
        myMember={myMember}
        tasks={tasks}
        taskCrew={taskCrew}
        unavailability={unavail}
        eventsMap={eventsMap}
        crewMap={crewMap}
        vehicleMap={vehicleMap}
        userId={user?.id}
        onRefresh={refreshAll}
      />
    );
  }

  const crewByTask = new Map<string, DispatchTaskCrew[]>();
  for (const row of taskCrew) {
    const list = crewByTask.get(row.task_id) ?? [];
    list.push(row);
    crewByTask.set(row.task_id, list);
  }

  const tasksByDay = new Map<string, DispatchTask[]>();
  for (const t of tasks) {
    const list = tasksByDay.get(t.task_date) ?? [];
    list.push(t);
    tasksByDay.set(t.task_date, list);
  }
  for (const list of tasksByDay.values()) {
    list.sort((a, b) => (a.warehouse_time || a.start_time || "99:99").localeCompare(b.warehouse_time || b.start_time || "99:99"));
  }

  const tasksByEvent = new Map<string, DispatchTask[]>();
  for (const t of tasks) {
    if (!t.event_id) continue;
    const list = tasksByEvent.get(t.event_id) ?? [];
    list.push(t);
    tasksByEvent.set(t.event_id, list);
  }

  const selectedDayTasks = tasksByDay.get(selectedDay) ?? [];
  const selectedDayUnavail = unavail.filter((u) => u.unavailable_date === selectedDay);

  const bankEvents = allEvents
    .filter((ev) => {
      const s = ev.start_date ?? ev.event_date;
      const e = ev.end_date ?? s;
      if (e < rangeStart || s > bankEnd) return false;
      if (onlyUnscheduled && (tasksByEvent.get(ev.id)?.length ?? 0) > 0) return false;
      return true;
    })
    .sort((a, b) => `${a.event_date} ${a.start_time ?? ""}`.localeCompare(`${b.event_date} ${b.start_time ?? ""}`));

  const bankByDate = new Map<string, EventRow[]>();
  for (const ev of bankEvents) {
    const key = ev.start_date ?? ev.event_date;
    const list = bankByDate.get(key) ?? [];
    list.push(ev);
    bankByDate.set(key, list);
  }

  function openNewTask(dayDate: string, event?: EventRow | null, type: DispatchTaskType = "setup") {
    if (!canEditBoard) return;
    setSelectedDay(dayDate);
    setForm(emptyTaskForm(dayDate, event, type));
    setEditorOpen(true);
  }

  function openEditTask(task: DispatchTask) {
    setSelectedDay(task.task_date);
    const tc = crewByTask.get(task.id) ?? [];
    setForm({
      id: task.id,
      event_id: task.event_id ?? "",
      rollover_to_event_id: task.rollover_to_event_id ?? "",
      task_date: task.task_date,
      task_type: task.task_type,
      title_override: task.title_override ?? "",
      sub_location: task.sub_location ?? "",
      warehouse_time: task.warehouse_time?.slice(0, 5) ?? "",
      start_time: task.start_time?.slice(0, 5) ?? "",
      end_time: task.end_time?.slice(0, 5) ?? "",
      vehicle_id: task.vehicle_id ?? "",
      extra_vehicle_ids: task.extra_vehicle_ids ?? [],
      equipment_notes: task.equipment_notes ?? "",
      ops_notes: task.ops_notes ?? "",
      crew: tc.map((c) => ({
        crew_member_id: c.crew_member_id,
        task_roles: c.task_roles ?? [],
        uses_personal_car: c.uses_personal_car ?? false,
        assigned_vehicle_id: c.assigned_vehicle_id ?? "",
        rides_with_member_id: c.rides_with_member_id ?? "",
        personal_note: c.personal_note ?? "",
      })),
    });
    setEditorOpen(true);
  }

  function toggleCrewMemberInForm(memberId: string) {
    setForm((cur) => {
      const exists = cur.crew.some((c) => c.crew_member_id === memberId);
      if (exists) {
        return {
          ...cur,
          crew: cur.crew
            .filter((c) => c.crew_member_id !== memberId)
            .map((c) => (c.rides_with_member_id === memberId ? { ...c, rides_with_member_id: "" } : c)),
        };
      }
      const defaultRole =
        cur.task_type === "setup"
          ? "עובד הקמה"
          : cur.task_type === "operation"
            ? "מפעיל"
            : cur.task_type === "teardown"
              ? "עובד פירוק"
              : "";
      return {
        ...cur,
        crew: [
          ...cur.crew,
          {
            crew_member_id: memberId,
            task_roles: defaultRole ? [defaultRole] : [],
            uses_personal_car: false,
            assigned_vehicle_id: "",
            rides_with_member_id: "",
            personal_note: "",
          },
        ],
      };
    });
  }

  function patchCrewRow(memberId: string, patch: Partial<CrewDraftRow>) {
    setForm((cur) => ({
      ...cur,
      crew: cur.crew.map((c) => (c.crew_member_id === memberId ? { ...c, ...patch } : c)),
    }));
  }

  function toggleCrewRole(memberId: string, role: string) {
    setForm((cur) => ({
      ...cur,
      crew: cur.crew.map((c) => {
        if (c.crew_member_id !== memberId) return c;
        const has = c.task_roles.includes(role);
        return { ...c, task_roles: has ? c.task_roles.filter((r) => r !== role) : [...c.task_roles, role] };
      }),
    }));
  }

  async function saveTask() {
    if (!canEditBoard) return;
    if (!form.event_id && !form.title_override.trim()) {
      toast.error("נא לבחור אירוע מהרשימה או להזין כותרת משימה חופשית");
      return;
    }
    setSaving(true);
    const id = form.id ?? crypto.randomUUID();
    const payload = {
      id,
      event_id: form.event_id || null,
      rollover_to_event_id: form.task_type === "rollover" && form.rollover_to_event_id ? form.rollover_to_event_id : null,
      task_date: form.task_date,
      task_type: form.task_type,
      title_override: form.title_override.trim() || null,
      sub_location: form.sub_location.trim() || null,
      warehouse_time: form.warehouse_time || null,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      vehicle_id: form.vehicle_id || null,
      extra_vehicle_ids: form.extra_vehicle_ids.filter((v) => v && v !== form.vehicle_id),
      equipment_notes: form.equipment_notes.trim() || null,
      ops_notes: form.ops_notes.trim() || null,
      updated_at: new Date().toISOString(),
      ...(form.id ? {} : { created_by: user?.id ?? null }),
    };

    const { error: taskErr } = await db.from("dispatch_tasks").upsert(payload);
    if (taskErr) {
      setSaving(false);
      toast.error("לא הצלחנו לשמור את המשימה");
      return;
    }

    await db.from("dispatch_task_crew").delete().eq("task_id", id);
    if (form.crew.length) {
      const crewRows = form.crew.map((c) => ({
        id: crypto.randomUUID(),
        task_id: id,
        crew_member_id: c.crew_member_id,
        task_roles: c.task_roles,
        uses_personal_car: c.uses_personal_car,
        assigned_vehicle_id: !c.uses_personal_car && !c.rides_with_member_id && c.assigned_vehicle_id ? c.assigned_vehicle_id : null,
        rides_with_member_id: !c.uses_personal_car && c.rides_with_member_id ? c.rides_with_member_id : null,
        personal_note: c.personal_note.trim() || null,
      }));
      const { error: crewErr } = await db.from("dispatch_task_crew").insert(crewRows);
      if (crewErr) {
        setSaving(false);
        toast.error("המשימה נשמרה אך שמירת הצוות נכשלה");
        return;
      }
    }

    setSaving(false);
    setEditorOpen(false);
    toast.success(form.id ? "משימת התפעול עודכנה" : "משימת התפעול נוספה ללוח");
    refreshAll();
  }

  async function confirmDeleteTask() {
    if (!deleteTarget) return;
    const { error } = await db.from("dispatch_tasks").delete().eq("id", deleteTarget.id);
    setDeleteTarget(null);
    if (error) {
      toast.error("לא הצלחנו למחוק את המשימה");
      return;
    }
    toast.success("המשימה הוסרה מהלוח");
    refreshAll();
  }

  function sendSingleTaskWa(task: DispatchTask) {
    const tc = crewByTask.get(task.id) ?? [];
    if (!tc.length) {
      toast.error("טרם שובצו עובדים למשימה זו");
      return;
    }
    const lead = tc.find((c) => c.task_roles.some((r) => r.includes("ראש צוות"))) ?? tc[0];
    const member = crewMap.get(lead.crew_member_id);
    if (!member) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "https://www.nsmm.work";
    const msg = buildWorkerDayWhatsappMessage({
      member,
      dayDate: task.task_date,
      tasks: [task],
      crewByTask,
      eventsMap,
      crewMap,
      vehicleMap,
      origin,
    });
    const phone = normalizeWaPhone(member.phone);
    if (phone) {
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
    } else {
      navigator.clipboard.writeText(msg).catch(() => {});
      toast.info(`ל-${member.full_name} אין טלפון מוגדר — ההודעה הועתקה ללוח`);
    }
  }

  function hasTaskConflict(task: DispatchTask): boolean {
    const sameDayOthers = (tasksByDay.get(task.task_date) ?? []).filter((t) => t.id !== task.id);
    const tStart = task.warehouse_time || task.start_time;
    const tEnd = task.end_time;
    const myVehicles = new Set([task.vehicle_id, ...(task.extra_vehicle_ids ?? [])].filter(Boolean));
    const myMembers = new Set((crewByTask.get(task.id) ?? []).map((c) => c.crew_member_id));

    for (const other of sameDayOthers) {
      if (!timesOverlap(tStart, tEnd, other.warehouse_time || other.start_time, other.end_time)) continue;
      const otherVehicles = [other.vehicle_id, ...(other.extra_vehicle_ids ?? [])].filter(Boolean);
      if (otherVehicles.some((v) => myVehicles.has(v))) return true;
      if ((crewByTask.get(other.id) ?? []).some((c) => myMembers.has(c.crew_member_id))) return true;
    }
    return false;
  }

  const personalCarDriversInForm = form.crew.filter((c) => c.uses_personal_car);

  return (
    <div className="space-y-2">
      {/* סרגל שליטה עליון קומפקטי */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <h1 className="me-2 text-base font-extrabold text-foreground">לוח תפעול ושיבוץ</h1>
          <Button type="button" variant="outline" size="icon" className="size-8" onClick={() => setWeekStart((d) => addDays(d, -7))} aria-label="שבוע קודם">
            <ChevronRight className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            onClick={() => {
              setWeekStart(startOfWeekSunday(new Date()));
              setSelectedDay(todayISO());
            }}
          >
            היום
          </Button>
          <Button type="button" variant="outline" size="icon" className="size-8" onClick={() => setWeekStart((d) => addDays(d, 7))} aria-label="שבוע הבא">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="px-1.5 text-xs font-semibold text-muted-foreground">
            {dateShort(boardDays[0])} – {dateShort(boardDays[boardDays.length - 1])}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => setTwoWeeks(false)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${!twoWeeks ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              תצוגת שבוע
            </button>
            <button
              type="button"
              onClick={() => setTwoWeeks(true)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${twoWeeks ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              תצוגת שבועיים
            </button>
          </div>

          <Button type="button" variant="outline" size="sm" className="hidden h-8 text-xs lg:inline-flex" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            {fullscreen ? "הצג תפריט" : "מסך מלא"}
          </Button>

          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setBankOpen((v) => !v)}>
            {bankOpen ? <PanelLeftClose className="size-3.5" /> : <PanelLeftOpen className="size-3.5" />}
            בנק אירועים ({bankEvents.length})
          </Button>

          <Button
            type="button"
            size="sm"
            className="h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
            onClick={() => setWaDialogOpen(true)}
          >
            <MessageCircle className="size-3.5" /> שלח סידור ({weekdayShort(selectedDay)} {dateShort(selectedDay).slice(0, 5)})
          </Button>

          {canEditBoard ? (
            <Button type="button" size="sm" className="h-8 text-xs" onClick={() => openNewTask(selectedDay)}>
              <Plus className="size-3.5" /> משימה חדשה
            </Button>
          ) : null}
        </div>
      </div>

      {/* שני פסי משאבים חיים ליום הנבחר: שורה 1 רכבים, שורה 2 זמינות צוות */}
      <div className="space-y-1.5 rounded-xl border border-border bg-card px-3 py-2 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-bold text-muted-foreground">
            רכבים ({weekdayShort(selectedDay)} {dateShort(selectedDay).slice(0, 5)}):
          </span>
          {vehicles.map((v) => {
            const vTasks = selectedDayTasks.filter(
              (t) => t.vehicle_id === v.id || (t.extra_vehicle_ids ?? []).includes(v.id),
            );
            const busy = vTasks.length > 0;
            const summary = vTasks
              .map((t) => `${taskDisplayTitle(t, eventsMap)}${t.warehouse_time ? ` (${timeShort(t.warehouse_time)})` : ""}`)
              .join(" · ");
            return (
              <span
                key={v.id}
                title={busy ? summary : "פנוי בחצר"}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                  vTasks.length > 1
                    ? "bg-amber-100 text-amber-900 ring-1 ring-amber-300"
                    : busy
                      ? "bg-orange-100 text-orange-900"
                      : "bg-emerald-100 text-emerald-900"
                }`}
              >
                <Truck className="size-3" />
                {v.name} — {busy ? `${vTasks.length > 1 ? `${vTasks.length} סבבים` : "בשטח"}` : "פנוי"}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1 border-t border-border/60 pt-1.5">
          <span className="text-[11px] font-bold text-muted-foreground">זמינות צוות ({activeCrew.length}):</span>
          {activeCrew.map((m) => {
            const mUnavail = selectedDayUnavail.find((u) => u.crew_member_id === m.id);
            const mTasks = selectedDayTasks.filter((t) =>
              (crewByTask.get(t.id) ?? []).some((c) => c.crew_member_id === m.id),
            );
            const tip = mUnavail
              ? `לא זמין: ${mUnavail.reason || "חופש/אילוץ"}${!mUnavail.all_day ? ` (${timeShort(mUnavail.from_time)}–${timeShort(mUnavail.to_time)})` : ""}`
              : mTasks.length
                ? mTasks.map((t) => `${TASK_TYPE_META[t.task_type].label}: ${taskDisplayTitle(t, eventsMap)}`).join(" | ")
                : "פנוי לשיבוץ";
            return (
              <span
                key={m.id}
                title={tip}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  mUnavail
                    ? "bg-red-100 text-red-900 line-through decoration-red-500/70"
                    : mTasks.length
                      ? "bg-orange-100 text-orange-900"
                      : "bg-emerald-100 text-emerald-900"
                }`}
              >
                {m.full_name}
                {mUnavail ? (
                  <span className="no-underline text-[10px] font-bold">({mUnavail.reason || "חסום"})</span>
                ) : mTasks.length > 1 ? (
                  <span className="text-[10px] font-bold">×{mTasks.length}</span>
                ) : null}
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setUnavailOpen(true)}
            className="ms-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Ban className="size-3 text-red-600" /> + אילוץ עובד
          </button>
        </div>
      </div>

      {/* אזור מרכזי: לוח הימים + בנק האירועים מהמשרד */}
      <div className="flex flex-col gap-2.5 xl:flex-row">
        <div className="min-w-0 flex-1 space-y-2.5">
          {[boardDays.slice(0, 7), ...(twoWeeks ? [boardDays.slice(7, 14)] : [])].map((weekSlice, rowIdx) => (
            <div key={rowIdx} className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-7">
              {weekSlice.map((dayObj) => {
                const dKey = dateKey(dayObj);
                const isToday = dKey === todayISO();
                const isSelected = dKey === selectedDay;
                const isHighlighted = dKey === highlightEventDate;
                const dayTasks = tasksByDay.get(dKey) ?? [];

                return (
                  <div
                    key={dKey}
                    onClick={() => setSelectedDay(dKey)}
                    className={`flex min-h-[260px] flex-col rounded-xl border bg-card transition-colors ${
                      isHighlighted
                        ? "border-indigo-500 ring-2 ring-indigo-400/50"
                        : isSelected
                          ? "border-primary ring-1 ring-primary/30"
                          : "border-border"
                    }`}
                  >
                    <div
                      className={`flex items-center justify-between border-b px-2 py-1.5 ${
                        isToday ? "bg-primary/10" : "bg-muted/35"
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <span className="text-xs font-extrabold text-foreground">{weekdayShort(dKey)}</span>
                        <span className="num text-[11px] font-semibold text-muted-foreground">
                          {dateShort(dKey).slice(0, 5)}
                        </span>
                        {dayTasks.length > 0 ? (
                          <span className="rounded-full bg-background px-1.5 text-[10px] font-bold text-muted-foreground">
                            {dayTasks.length}
                          </span>
                        ) : null}
                      </div>
                      {canEditBoard ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openNewTask(dKey);
                          }}
                          className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-primary"
                          title="הוסף משימה ליום זה"
                          aria-label={`הוספת משימה ליום ${dateShort(dKey)}`}
                        >
                          <Plus className="size-3.5" />
                        </button>
                      ) : null}
                    </div>

                    {/* כרטיסיות סופר-דחוסות עם סימן מים — 10+ ביום ללא גלילה פנימית */}
                    <div className="flex-1 space-y-1 p-1">
                      {dayTasks.map((task) => {
                        const meta = TASK_TYPE_META[task.task_type];
                        const tc = crewByTask.get(task.id) ?? [];
                        const vNames = [
                          task.vehicle_id ? vehicleMap.get(task.vehicle_id)?.name : null,
                          ...(task.extra_vehicle_ids ?? []).map((vid) => vehicleMap.get(vid)?.name),
                        ].filter(Boolean);
                        const conflict = hasTaskConflict(task);
                        const timeLabel = task.warehouse_time
                          ? `${timeShort(task.warehouse_time)}${task.end_time ? `–${timeShort(task.end_time)}` : ""}`
                          : task.start_time
                            ? timeShort(task.start_time)
                            : "";

                        return (
                          <div
                            key={task.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditTask(task);
                            }}
                            className={`group relative cursor-pointer overflow-hidden rounded-lg border border-border/80 px-2 py-1.5 transition-shadow hover:shadow-sm ${meta.border}`}
                          >
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute bottom-0 left-1.5 select-none text-xl font-black tracking-tight text-foreground/[0.08]"
                            >
                              {meta.watermark}
                            </span>

                            <div className="relative space-y-0.5">
                              <div className="flex items-start justify-between gap-1">
                                <p className="line-clamp-1 text-xs font-bold leading-tight text-foreground">
                                  {conflict ? <AlertTriangle className="me-0.5 inline size-3 text-red-600" /> : null}
                                  {taskDisplayTitle(task, eventsMap)}
                                </p>
                                <div className="flex shrink-0 items-center gap-0.5">
                                  {timeLabel ? (
                                    <span className="num rounded bg-background/85 px-1 text-[10px] font-bold text-foreground">
                                      {timeLabel}
                                    </span>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      sendSingleTaskWa(task);
                                    }}
                                    className="rounded p-0.5 text-emerald-700 hover:bg-emerald-100"
                                    title="שלח משימה בוואטסאפ לראש הצוות"
                                  >
                                    <MessageCircle className="size-3" />
                                  </button>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-tight text-muted-foreground">
                                {vNames.length > 0 ? (
                                  <span className="font-semibold text-foreground/85">{vNames.join("+")}</span>
                                ) : null}
                                {tc.length > 0 ? (
                                  <span className="truncate">
                                    {tc
                                      .map((c) => {
                                        const name = crewMap.get(c.crew_member_id)?.full_name?.split(" ")[0] ?? "";
                                        const isLead = c.task_roles.some((r) => r.includes("ראש צוות"));
                                        const carFlag = c.uses_personal_car ? "🚗" : "";
                                        return `${isLead ? "★" : ""}${name}${carFlag}`;
                                      })
                                      .join(", ")}
                                  </span>
                                ) : (
                                  <span className="italic text-amber-700">ללא צוות</span>
                                )}
                              </div>

                              {task.equipment_notes ? (
                                <p className="line-clamp-1 text-[10px] font-medium text-purple-900">
                                  {task.equipment_notes}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* בנק אירועים מהמשרד — מסודר כרונולוגית לפי ימים עם תאריכים ברורים */}
        {bankOpen ? (
          <aside className="w-full shrink-0 rounded-xl border border-border bg-card p-2.5 shadow-xs xl:w-72">
            <div className="mb-2 flex items-center justify-between gap-1 border-b border-border pb-2">
              <div>
                <h2 className="text-xs font-extrabold text-foreground">בנק אירועים מהמשרד</h2>
                <p className="text-[10px] text-muted-foreground">לחיצה מדגישה את היום בלוח ופותחת שיבוץ</p>
              </div>
              <button
                type="button"
                onClick={() => setOnlyUnscheduled((v) => !v)}
                className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                  onlyUnscheduled ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {onlyUnscheduled ? "רק לא משובצים" : "הכל"}
              </button>
            </div>

            {!bankEvents.length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">אין אירועים בטווח זה.</p>
            ) : (
              <div className="max-h-[72vh] space-y-2.5 overflow-y-auto pe-0.5">
                {Array.from(bankByDate.entries()).map(([dayDate, evList]) => (
                  <div key={dayDate} className="space-y-1">
                    <div className="sticky top-0 z-10 flex items-center justify-between rounded bg-muted/85 px-2 py-0.5 backdrop-blur">
                      <span className="text-[11px] font-extrabold text-foreground">
                        {weekdayShort(dayDate)} · {dateShort(dayDate)}
                      </span>
                      <span className="text-[10px] font-semibold text-muted-foreground">{evList.length} אירועים</span>
                    </div>

                    {evList.map((ev) => {
                      const evTasks = tasksByEvent.get(ev.id) ?? [];
                      const hasSetup = evTasks.some((t) => t.task_type === "setup");
                      const hasOp = evTasks.some((t) => t.task_type === "operation");
                      const hasTd = evTasks.some((t) => t.task_type === "teardown" || t.task_type === "rollover");
                      const multiDay = ev.end_date && ev.end_date > (ev.start_date ?? ev.event_date);
                      const clName = ev.client_id ? clientsMap.get(ev.client_id) : null;

                      return (
                        <div
                          key={ev.id}
                          onMouseEnter={() => setHighlightEventDate(ev.event_date)}
                          onMouseLeave={() => setHighlightEventDate(null)}
                          onClick={() => {
                            setHighlightEventDate(ev.event_date);
                            setSelectedDay(ev.event_date);
                          }}
                          className="rounded-lg border border-border bg-background p-2 transition-colors hover:border-primary/60"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="num rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-900">
                              {weekdayShort(ev.event_date)} {dateShort(ev.event_date).slice(0, 5)}
                              {ev.start_time ? ` · ${timeShort(ev.start_time)}` : ""}
                              {multiDay ? ` עד ${dateShort(ev.end_date).slice(0, 5)}` : ""}
                            </span>
                            <Link
                              to="/events/$id/crew-sheet"
                              params={{ id: ev.id }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-muted-foreground hover:text-primary"
                              title="דוח אירוע"
                            >
                              <FileText className="size-3.5" />
                            </Link>
                          </div>

                          <p className="mt-1 truncate text-xs font-bold text-foreground">{ev.title}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {[ev.venue, clName && clName !== ev.title ? clName : null].filter(Boolean).join(" · ") || "ללא מיקום"}
                          </p>

                          <div className="mt-1.5 flex items-center justify-between gap-1">
                            <div className="flex items-center gap-1 text-[10px]">
                              <span className={`rounded px-1 py-0.2 font-semibold ${hasSetup ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>הקמה</span>
                              <span className={`rounded px-1 py-0.2 font-semibold ${hasOp ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>הפעלה</span>
                              <span className={`rounded px-1 py-0.2 font-semibold ${hasTd ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>פירוק</span>
                            </div>
                            {canEditBoard ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openNewTask(selectedDay || ev.event_date, ev, !hasSetup ? "setup" : !hasOp ? "operation" : "teardown");
                                }}
                              >
                                <Plus className="size-3" /> שבץ ל-{dateShort(selectedDay).slice(0, 5)}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </aside>
        ) : null}
      </div>

      {/* חלון יצירה / עריכת משימת תפעול */}
      <Dialog
        open={editorOpen}
        onOpenChange={(v) => { if (!saving) setEditorOpen(v); }}
        title={form.id ? "עריכת משימת תפעול ושיבוץ" : "משימת תפעול חדשה בלוח"}
        description="המשימה מופיעה בלוח התפעול בלבד ואינה יוצרת כפילויות ביומן המכירות והנהלת החשבונות"
        size="lg"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              {form.id && canEditBoard ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-red-700 hover:bg-red-50"
                  onClick={() => {
                    const target = tasks.find((t) => t.id === form.id) ?? null;
                    setEditorOpen(false);
                    setDeleteTarget(target);
                  }}
                >
                  <Trash2 className="size-4" /> מחיקת משימה
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>ביטול</Button>
              {canEditBoard ? (
                <Button type="button" onClick={saveTask} disabled={saving}>{saving ? "שומר…" : "שמירת שיבוץ"}</Button>
              ) : null}
            </div>
          </div>
        }
      >
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pe-1">
          <div>
            <p className="mb-1.5 text-xs font-bold text-muted-foreground">סוג פעולה (סימן המים על הכרטיסייה)</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {(Object.keys(TASK_TYPE_META) as DispatchTaskType[]).map((typeKey) => {
                const m = TASK_TYPE_META[typeKey];
                const active = form.task_type === typeKey;
                return (
                  <button
                    key={typeKey}
                    type="button"
                    onClick={() => setForm((c) => ({ ...c, task_type: typeKey }))}
                    className={`rounded-lg border px-2.5 py-2 text-xs font-bold transition-all ${
                      active ? `${m.badge} border-current ring-2 ring-primary/30` : "border-border bg-background text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="שיוך לאירוע מהמשרד" htmlFor="task-event">
              <Select
                id="task-event"
                value={form.event_id}
                onChange={(e) => {
                  const ev = eventsMap.get(e.target.value);
                  setForm((c) => ({
                    ...c,
                    event_id: e.target.value,
                    warehouse_time: c.warehouse_time || ev?.warehouse_time?.slice(0, 5) || "",
                    start_time: c.start_time || ev?.start_time?.slice(0, 5) || "",
                    end_time: c.end_time || ev?.end_time?.slice(0, 5) || "",
                  }));
                }}
              >
                <option value="">— משימה עצמאית ללא אירוע —</option>
                {allEvents
                  .slice()
                  .sort((a, b) => b.event_date.localeCompare(a.event_date))
                  .map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {dateShort(ev.event_date)} · {ev.title} {ev.venue ? `(${ev.venue})` : ""}
                    </option>
                  ))}
              </Select>
            </Field>

            <Field label="תאריך ביצוע המשימה בלוח *" htmlFor="task-date">
              <Input id="task-date" type="date" value={form.task_date} onChange={(e) => setForm((c) => ({ ...c, task_date: e.target.value }))} className="h-10" />
            </Field>
          </div>

          {form.task_type === "rollover" ? (
            <Field label="גלגול ציוד לאירוע יעד (של לקוח/יום אחר)" htmlFor="task-rollover-target">
              <Select
                id="task-rollover-target"
                value={form.rollover_to_event_id}
                onChange={(e) => setForm((c) => ({ ...c, rollover_to_event_id: e.target.value }))}
              >
                <option value="">בחר אירוע יעד שאליו הציוד מתגלגל…</option>
                {allEvents
                  .slice()
                  .sort((a, b) => b.event_date.localeCompare(a.event_date))
                  .map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {dateShort(ev.event_date)} · {ev.title} {ev.venue ? `(${ev.venue})` : ""}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="תת-מיקום / זירה ספציפית" htmlFor="task-subloc" hint="לדוגמה: חוף ביאנקיני / אולם המלך דוד">
              <Input id="task-subloc" value={form.sub_location} onChange={(e) => setForm((c) => ({ ...c, sub_location: e.target.value }))} placeholder="אופציונלי" className="h-10" />
            </Field>
            <Field label="כותרת חלופית (אם אין אירוע או לשם מקוצר)" htmlFor="task-title">
              <Input id="task-title" value={form.title_override} onChange={(e) => setForm((c) => ({ ...c, title_override: e.target.value }))} placeholder="לדוגמה: סבב פירוקים צפון" className="h-10" />
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <Field label="הגעה למחסן" htmlFor="task-wh-time">
              <Input id="task-wh-time" type="time" value={form.warehouse_time} onChange={(e) => setForm((c) => ({ ...c, warehouse_time: e.target.value }))} className="h-10" />
            </Field>
            <Field label="תחילת עבודה/אירוע" htmlFor="task-start-time">
              <Input id="task-start-time" type="time" value={form.start_time} onChange={(e) => setForm((c) => ({ ...c, start_time: e.target.value }))} className="h-10" />
            </Field>
            <Field label="סיום משוער" htmlFor="task-end-time">
              <Input id="task-end-time" type="time" value={form.end_time} onChange={(e) => setForm((c) => ({ ...c, end_time: e.target.value }))} className="h-10" />
            </Field>
          </div>

          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-bold text-foreground">רכב חברה ראשי למשימה (לחיצה שנייה מבטלת)</p>
            <div className="flex flex-wrap gap-1.5">
              {vehicles.map((v) => {
                const isPrimary = form.vehicle_id === v.id;
                const isExtra = form.extra_vehicle_ids.includes(v.id);
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() =>
                      setForm((c) => ({
                        ...c,
                        vehicle_id: c.vehicle_id === v.id ? "" : v.id,
                        extra_vehicle_ids: c.extra_vehicle_ids.filter((x) => x !== v.id),
                      }))
                    }
                    className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
                      isPrimary
                        ? "border-primary bg-primary text-primary-foreground"
                        : isExtra
                          ? "border-indigo-400 bg-indigo-100 text-indigo-900"
                          : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    <Truck className="size-3.5" /> {v.name}
                  </button>
                );
              })}
            </div>
            {form.vehicle_id ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">רכב חברה משלים (אם צריך עוד רכב):</span>
                {vehicles
                  .filter((v) => v.id !== form.vehicle_id)
                  .map((v) => {
                    const checked = form.extra_vehicle_ids.includes(v.id);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() =>
                          setForm((c) => ({
                            ...c,
                            extra_vehicle_ids: checked
                              ? c.extra_vehicle_ids.filter((x) => x !== v.id)
                              : [...c.extra_vehicle_ids, v.id],
                          }))
                        }
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                          checked ? "border-indigo-500 bg-indigo-100 text-indigo-900" : "border-border bg-background text-muted-foreground"
                        }`}
                      >
                        + {v.name}
                      </button>
                    );
                  })}
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-bold text-foreground">בחר אנשי צוות למשימה ({form.crew.length} נבחרו)</p>
            <div className="flex flex-wrap gap-1.5">
              {activeCrew.map((m) => {
                const selected = form.crew.some((c) => c.crew_member_id === m.id);
                const blocked = unavail.find((u) => u.crew_member_id === m.id && u.unavailable_date === form.task_date);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      if (blocked && !selected) {
                        toast.warning(`שים לב: ${m.full_name} דיווח אי-זמינות ביום זה (${blocked.reason || "ללא סיבה"})`);
                      }
                      toggleCrewMemberInForm(m.id);
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-bold transition-colors ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : blocked
                          ? "border-red-300 bg-red-50 text-red-800"
                          : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    {m.full_name} {blocked ? "⛔" : ""}
                  </button>
                );
              })}
            </div>

            {form.crew.length > 0 ? (
              <div className="mt-3 space-y-2.5 border-t border-border pt-3">
                {form.crew.map((row) => {
                  const member = crewMap.get(row.crew_member_id);
                  if (!member) return null;
                  const otherCarDrivers = personalCarDriversInForm.filter((d) => d.crew_member_id !== row.crew_member_id);
                  return (
                    <div key={row.crew_member_id} className="rounded-lg border border-border bg-background p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-bold text-foreground">
                          {row.task_roles.some((r) => r.includes("ראש צוות")) ? <Crown className="me-1 inline size-3.5 text-amber-500" /> : null}
                          {member.full_name}
                        </span>
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50/70 px-2 py-1 text-xs font-semibold text-indigo-900">
                          <Checkbox
                            checked={row.uses_personal_car}
                            onCheckedChange={(val) =>
                              patchCrewRow(row.crew_member_id, {
                                uses_personal_car: val,
                                rides_with_member_id: val ? "" : row.rides_with_member_id,
                              })
                            }
                            label={`רכב אישי ל${member.full_name}`}
                          />
                          <Car className="size-3.5" /> יוצא עם רכב אישי (דיווח ק״מ בשעון)
                        </label>
                      </div>

                      <div className="mt-2 flex flex-wrap gap-1">
                        {TASK_ROLE_OPTIONS.map((roleOpt) => {
                          const on = row.task_roles.includes(roleOpt);
                          return (
                            <button
                              key={roleOpt}
                              type="button"
                              onClick={() => toggleCrewRole(row.crew_member_id, roleOpt)}
                              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
                                on
                                  ? "border-indigo-600 bg-indigo-600 text-white"
                                  : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {roleOpt}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {!row.uses_personal_car && (otherCarDrivers.length > 0 || form.extra_vehicle_ids.length > 0) ? (
                          <select
                            value={
                              row.rides_with_member_id
                                ? `member:${row.rides_with_member_id}`
                                : row.assigned_vehicle_id
                                  ? `veh:${row.assigned_vehicle_id}`
                                  : ""
                            }
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val.startsWith("member:")) {
                                patchCrewRow(row.crew_member_id, { rides_with_member_id: val.slice(7), assigned_vehicle_id: "" });
                              } else if (val.startsWith("veh:")) {
                                patchCrewRow(row.crew_member_id, { assigned_vehicle_id: val.slice(4), rides_with_member_id: "" });
                              } else {
                                patchCrewRow(row.crew_member_id, { assigned_vehicle_id: "", rides_with_member_id: "" });
                              }
                            }}
                            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                          >
                            <option value="">נוסע ברכב הראשי ({form.vehicle_id ? vehicleMap.get(form.vehicle_id)?.name : "ברירת מחדל"})</option>
                            {form.extra_vehicle_ids.map((vid) => (
                              <option key={vid} value={`veh:${vid}`}>
                                נוסע ב-{vehicleMap.get(vid)?.name}
                              </option>
                            ))}
                            {otherCarDrivers.map((d) => (
                              <option key={d.crew_member_id} value={`member:${d.crew_member_id}`}>
                                נוסע עם {crewMap.get(d.crew_member_id)?.full_name} (ברכבו האישי)
                              </option>
                            ))}
                          </select>
                        ) : null}

                        <Input
                          value={row.personal_note}
                          onChange={(e) => patchCrewRow(row.crew_member_id, { personal_note: e.target.value })}
                          placeholder={`דגש אישי ל-${member.full_name} (אופציונלי)`}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="שינויי ציוד / השלמות / תצורת גלגול" htmlFor="task-eq-notes">
              <Textarea
                id="task-eq-notes"
                value={form.equipment_notes}
                onChange={(e) => setForm((c) => ({ ...c, equipment_notes: e.target.value }))}
                placeholder="לדוגמה: הלדים נשארים באולם — לשנות מ-5x4 ל-2 מסכי צד 4x2.5 ולהביא פרוססור שני"
                rows={2}
                className="min-h-16 text-xs"
              />
            </Field>
            <Field label="הערות תפעול כלליות למשימה" htmlFor="task-ops-notes">
              <Textarea
                id="task-ops-notes"
                value={form.ops_notes}
                onChange={(e) => setForm((c) => ({ ...c, ops_notes: e.target.value }))}
                placeholder="לדוגמה: פריקה מהשער הדרומי, לתאם כניסה עם הקב״ט"
                rows={2}
                className="min-h-16 text-xs"
              />
            </Field>
          </div>
        </div>
      </Dialog>

      <DailyWhatsappDialog
        open={waDialogOpen}
        onOpenChange={setWaDialogOpen}
        dayDate={selectedDay}
        dayTasks={selectedDayTasks}
        crewByTask={crewByTask}
        eventsMap={eventsMap}
        crewMap={crewMap}
        vehicleMap={vehicleMap}
        onMarkedSent={refreshAll}
      />

      <UnavailabilityDialog
        open={unavailOpen}
        onOpenChange={setUnavailOpen}
        crewMembers={activeCrew}
        userId={user?.id}
        onSaved={refreshAll}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="למחוק את משימת התפעול?"
        description="המשימה תוסר מלוח התפעול בלבד. האירוע המקורי ביומן המשרד אינו נפגע."
        confirmLabel="מחק משימה"
        onConfirm={confirmDeleteTask}
      />
    </div>
  );
}
// END OF FILE - src/components/office/office-board.tsx
