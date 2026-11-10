import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/integrations/neon/client";
import { useSession } from "@/hooks/use-session";
import { useCrewMembers, useEventDayCrew, useEventDays } from "@/hooks/use-data";
import { createClient } from "@/lib/clients";
import { isMultiDayEvent } from "@/lib/events";
import { assignableCrew } from "@/lib/crew";
import { crewRolesLabel } from "@/lib/crew-roles";
import { ClientForm } from "@/components/clients/client-form";
import { ClientPicker } from "@/components/clients/client-picker";
import { ClientContactsList } from "@/components/clients/client-contacts-list";
import { dateLong, dateShort, toDateInput, toTimeInput, weekdayShort } from "@/lib/format";
import { getHebrewDate, getHolidays } from "@/lib/hebrew-calendar";
import type { Client, EventRow, Profile } from "@/lib/types";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EVENT_STATUSES, formatStatusLabel } from "@/lib/status-labels";
import { setEditingActive } from "@/lib/data-events";

function startHebrewDate(date: Date | null) {
  return date ? getHebrewDate(date) : null;
}

export const EVENT_TYPES = ["חתונה", "בר/בת מצווה", "כנס", "השקה", "חברה", "אחר"];
export { EVENT_STATUSES } from "@/lib/status-labels";

type FormState = {
  title: string;
  client_id: string;
  event_type: string;
  start_date: string;
  end_date: string;
  event_date: string;
  start_time: string;
  end_time: string;
  warehouse_time: string;
  ready_time: string;
  venue: string;
  address: string;
  guest_count: string;
  status: string;
  sales_rep_id: string;
  total_amount: string;
  notes: string;
};

type DayCrewState = { crew_member_id: string; role_text: string; notes: string };

type DayState = {
  id?: string;
  day_date: string;
  warehouse_time: string;
  ready_time: string;
  start_time: string;
  end_time: string;
  notes: string;
  crew: DayCrewState[];
};

const EMPTY: FormState = {
  title: "",
  client_id: "",
  event_type: "חתונה",
  start_date: "",
  end_date: "",
  event_date: "",
  start_time: "",
  end_time: "",
  warehouse_time: "",
  ready_time: "",
  venue: "",
  address: "",
  guest_count: "",
  status: "ממתין לסגירה",
  sales_rep_id: "",
  total_amount: "",
  notes: "",
};

function emptyDay(day_date: string): DayState {
  return { day_date, warehouse_time: "", ready_time: "", start_time: "", end_time: "", notes: "", crew: [] };
}

function enumerateDates(start: string, end: string): string[] {
  if (!start || !end) return [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return [];
  const out: string[] = [];
  const cur = new Date(s);
  let guard = 0;
  while (cur <= e && guard < 400) {
    out.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`,
    );
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return out;
}

export function EventForm({
  open,
  onOpenChange,
  event,
  clients,
  profiles,
  currentProfile,
  isAdmin,
  canEditStatus = true,
  onSaved,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  event: EventRow | null;
  clients: Client[];
  profiles: Profile[];
  currentProfile: Profile | null;
  isAdmin: boolean;
  canEditStatus?: boolean;
  onSaved: () => void;
  defaultDate?: string;
}) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canCreateClient = can("clients", "edit");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<DayState[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [continueAfterConfirm, setContinueAfterConfirm] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [editClientOpen, setEditClientOpen] = useState(false);

  useEffect(() => {
    setEditingActive("event-form", open);
    return () => setEditingActive("event-form", false);
  }, [open]);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [quickEmail, setQuickEmail] = useState("");
  const [quickCompany, setQuickCompany] = useState("");
  const [quickAddress, setQuickAddress] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);

  const crewQ = useCrewMembers(open);
  const daysQ = useEventDays(event?.id ?? null, open && Boolean(event));
  const dayCrewQ = useEventDayCrew(open && Boolean(event));
  const crew = assignableCrew(crewQ.data ?? [], profiles);
  const selectedClient = clients.find((client) => client.id === form.client_id) ?? null;
  const activeCrew = crew.filter((c) => c.is_active);
  const hydratedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (event) {
      setForm({
        title: event.title ?? "",
        client_id: event.client_id ?? "",
        event_type: event.event_type ?? "אחר",
        start_date: toDateInput(event.start_date ?? event.event_date),
        end_date: toDateInput(event.end_date ?? event.event_date),
        event_date: toDateInput(event.start_date ?? event.event_date),
        start_time: toTimeInput(event.start_time),
        end_time: toTimeInput(event.end_time),
        warehouse_time: toTimeInput(event.warehouse_time),
        ready_time: toTimeInput(event.ready_time),
        venue: event.venue ?? "",
        address: event.address ?? "",
        guest_count: event.guest_count != null ? String(event.guest_count) : "",
        status: event.status ?? "ממתין לסגירה",
        sales_rep_id: event.sales_rep_id ?? "",
        total_amount: event.total_amount != null ? String(event.total_amount) : "",
        notes: event.notes ?? "",
      });
    } else {
      const start = defaultDate ?? toDateInput(new Date());
      setForm({
        ...EMPTY,
        sales_rep_id: isAdmin ? "" : currentProfile?.id ?? "",
        start_date: start,
        end_date: start,
        event_date: start,
      });
    }
    setErrors({});
    resetQuickAdd();
  }, [open, event, isAdmin, currentProfile?.id, defaultDate]);

  useEffect(() => {
    if (!open) {
      hydratedRef.current = null;
      return;
    }
    const key = event?.id ?? "new";
    if (hydratedRef.current === key) return;
    if (event && (daysQ.isLoading || dayCrewQ.isLoading)) return;

    const start = event ? toDateInput(event.start_date ?? event.event_date) : defaultDate ?? toDateInput(new Date());
    if (event) {
      const dbDays = daysQ.data ?? [];
      const crewRows = dayCrewQ.data ?? [];
      if (dbDays.length) {
        setDays(
          dbDays.map((d) => ({
            id: d.id,
            day_date: d.day_date,
            warehouse_time: toTimeInput(d.warehouse_time),
            ready_time: toTimeInput(d.ready_time),
            start_time: toTimeInput(d.start_time),
            end_time: toTimeInput(d.end_time),
            notes: d.notes ?? "",
            crew: crewRows
              .filter((c) => c.event_day_id === d.id)
              .map((c) => ({ crew_member_id: c.crew_member_id, role_text: c.role_text ?? "", notes: c.notes ?? "" })),
          })),
        );
        const maxDate = dbDays.reduce((m, d) => (d.day_date > m ? d.day_date : m), start);
        const endDate = event.end_date && event.end_date >= start ? event.end_date : maxDate;
        setForm((f) => ({ ...f, start_date: start, end_date: endDate, event_date: start }));
      } else {
        setDays([
          {
            day_date: start,
            warehouse_time: toTimeInput(event.warehouse_time),
            ready_time: toTimeInput(event.ready_time),
            start_time: toTimeInput(event.start_time),
            end_time: toTimeInput(event.end_time),
            notes: "",
            crew: [],
          },
        ]);
      }
    } else {
      setDays([emptyDay(start)]);
    }
    hydratedRef.current = key;
  }, [open, event, daysQ.isLoading, daysQ.data, dayCrewQ.isLoading, dayCrewQ.data, defaultDate]);

  useEffect(() => {
    if (!open) return;
    const { start_date, end_date } = form;
    if (!start_date || !end_date || end_date < start_date) return;
    const dates = enumerateDates(start_date, end_date);
    if (!dates.length) return;
    setDays((prev) => {
      const have = new Set(prev.map((d) => d.day_date));
      const missing = dates.filter((d) => !have.has(d));
      if (!missing.length) return prev;
      return [...prev, ...missing.map(emptyDay)];
    });
  }, [open, form.start_date, form.end_date]);

  const visibleDays = useMemo(() => {
    const { start_date, end_date } = form;
    return days
      .filter((d) => d.day_date >= start_date && d.day_date <= end_date)
      .sort((a, b) => a.day_date.localeCompare(b.day_date));
  }, [days, form.start_date, form.end_date]);

  const isMultiDay = isMultiDayEvent(
    { start_date: form.start_date, end_date: form.end_date, event_date: form.start_date },
    visibleDays,
  );
  const startDateValue = form.start_date ? new Date(`${form.start_date}T12:00:00`) : null;
  const startHebrew = startHebrewDate(startDateValue);
  const startHolidays = startDateValue ? getHolidays(startDateValue) : [];

  const outOfRange = useMemo(
    () => days.filter((d) => d.id && (d.day_date < form.start_date || d.day_date > form.end_date)),
    [days, form.start_date, form.end_date],
  );

  const set = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function setDayField(date: string, key: keyof DayState, value: string) {
    setDays((prev) => prev.map((d) => (d.day_date === date ? { ...d, [key]: value } : d)));
  }

  function addCrew(date: string, crewId: string) {
    if (!crewId) return;
    const member = crew.find((c) => c.id === crewId);
    setDays((prev) =>
      prev.map((d) =>
        d.day_date === date && !d.crew.some((c) => c.crew_member_id === crewId)
          ? { ...d, crew: [...d.crew, { crew_member_id: crewId, role_text: crewRolesLabel(member), notes: "" }] }
          : d,
      ),
    );
  }

  function removeCrew(date: string, crewId: string) {
    setDays((prev) =>
      prev.map((d) => (d.day_date === date ? { ...d, crew: d.crew.filter((c) => c.crew_member_id !== crewId) } : d)),
    );
  }

  function setCrewField(date: string, crewId: string, key: "role_text" | "notes", value: string) {
    setDays((prev) =>
      prev.map((d) =>
        d.day_date === date
          ? { ...d, crew: d.crew.map((c) => (c.crew_member_id === crewId ? { ...c, [key]: value } : c)) }
          : d,
      ),
    );
  }

  function resetQuickAdd() {
    setQuickAddOpen(false);
    setQuickName("");
    setQuickPhone("");
    setQuickEmail("");
    setQuickCompany("");
    setQuickAddress("");
    setQuickError(null);
  }

  async function saveQuickClient() {
    setQuickError(null);
    if (!quickName.trim()) {
      setQuickError("נא להזין שם לקוח.");
      return;
    }
    setQuickBusy(true);
    const { id, error, reused } = await createClient({
      name: quickName,
      phone: quickPhone,
      email: quickEmail,
      company: quickCompany,
      address: quickAddress,
    });
    setQuickBusy(false);
    if (error || !id) {
      setQuickError(
        error?.code === "42501" || /row-level security/i.test(error?.message ?? "")
          ? "אין לך הרשאה להוסיף לקוח."
          : "לא הצלחנו לשמור את הלקוח. נסה שוב.",
      );
      return;
    }
    set("client_id", id);
    setErrors((current) => ({ ...current, client_id: "" }));
    resetQuickAdd();
    toast.success(reused ? "הלקוח כבר קיים — הפרטים עודכנו ונבחר באירוע" : "הלקוח נוצר ונבחר באירוע");
    queryClient.invalidateQueries({ queryKey: ["clients"] });
  }

  function buildEventPayload() {
    const repId = isAdmin ? form.sales_rep_id || null : currentProfile?.id ?? null;
    const repName = repId
      ? profiles.find((p) => p.id === repId)?.full_name ?? (repId === currentProfile?.id ? currentProfile?.full_name : null)
      : null;
    const single = visibleDays.length === 1 ? visibleDays[0] : null;
    const selectedClient = clients.find((c) => c.id === form.client_id);
    const derivedTitle = selectedClient?.name?.trim() || form.event_type || "אירוע";
    // New events take their identity from the selected client. Existing events
    // keep their stored title byte-for-byte unless the form already had one.
    const title = event ? form.title.trim() || derivedTitle : derivedTitle;
    return {
      id: event?.id ?? null,
      title,
      event_type: form.event_type || "אחר",
      event_date: form.start_date,
      start_date: form.start_date,
      end_date: form.end_date || form.start_date,
      start_time: single ? single.start_time || null : form.start_time || null,
      end_time: single ? single.end_time || null : form.end_time || null,
      warehouse_time: single ? single.warehouse_time || null : form.warehouse_time || null,
      ready_time: single ? single.ready_time || null : form.ready_time || null,
      client_id: form.client_id || null,
      venue: form.venue.trim() || null,
      address: form.address.trim() || null,
      guest_count: form.guest_count ? Number(form.guest_count) : null,
      status: form.status || "ממתין לסגירה",
      sales_rep_id: repId,
      sales_rep_name: repName,
      total_amount: form.total_amount ? Number(form.total_amount) : 0,
      notes: form.notes.trim() || null,
    };
  }

  function buildDayPayload() {
    return visibleDays.map((d, i) => ({
      day_date: d.day_date,
      warehouse_time: d.warehouse_time || null,
      ready_time: d.ready_time || null,
      start_time: d.start_time || null,
      end_time: d.end_time || null,
      notes: d.notes || null,
      sort_order: i,
      crew: d.crew
        .filter((c) => c.crew_member_id)
        .map((c) => ({ crew_member_id: c.crew_member_id, role_text: c.role_text || null, notes: c.notes || null })),
    }));
  }

  function isMissingTable(err: any) {
    return (
      err?.code === "42P01" ||
      err?.code === "PGRST205" ||
      /does not exist|could not find the table/i.test(err?.message ?? "")
    );
  }

  async function directSave(
    payload: ReturnType<typeof buildEventPayload>,
    dayPayload: ReturnType<typeof buildDayPayload>,
    removeIds: string[],
  ) {
    let createdId: string | null = null;
    let daysSkipped = false;
    try {
      let id = event?.id ?? null;
      if (id) {
        const { error } = await db.from("events").update(payload).eq("id", id);
        if (error) throw error;
      } else {
        const { id: _omitId, ...insertRow } = payload;
        const { data, error } = await db.from<{ id: string }[]>("events").insert(insertRow).select("id");
        if (error) throw error;
        id = data?.[0]?.id ?? null;
        createdId = id;
        if (!id) throw new Error("לא התקבל מזהה אירוע מהשרת");
      }
      if (removeIds.length) {
        const { error } = await db.from("event_days").delete().in("id", removeIds);
        if (error) throw error;
      }
      for (const day of dayPayload) {
        const { data: existing, error: findErr } = await db
          .from<{ id: string }[]>("event_days")
          .select("id")
          .eq("event_id", id)
          .eq("day_date", day.day_date)
          .limit(1);
        if (findErr) {
          if (isMissingTable(findErr)) {
            daysSkipped = true;
            break;
          }
          throw findErr;
        }
        let dayId = existing?.[0]?.id ?? null;
        const dayRow = {
          event_id: id,
          day_date: day.day_date,
          warehouse_time: day.warehouse_time,
          ready_time: day.ready_time,
          start_time: day.start_time,
          end_time: day.end_time,
          notes: day.notes,
          sort_order: day.sort_order,
        };
        if (dayId) {
          const { error } = await db.from("event_days").update(dayRow).eq("id", dayId);
          if (error) {
            if (isMissingTable(error)) {
              daysSkipped = true;
              break;
            }
            throw error;
          }
        } else {
          const { data, error } = await db.from<{ id: string }[]>("event_days").insert(dayRow).select("id");
          if (error) {
            if (isMissingTable(error)) {
              daysSkipped = true;
              break;
            }
            throw error;
          }
          dayId = data?.[0]?.id ?? null;
          if (!dayId) throw new Error("לא התקבל מזהה יום מהשרת");
        }
        const { error: delErr } = await db.from("event_day_crew").delete().eq("event_day_id", dayId);
        if (delErr) {
          if (isMissingTable(delErr)) {
            daysSkipped = true;
            break;
          }
          throw delErr;
        }
        if (day.crew.length) {
          const { error: crewErr } = await db.from("event_day_crew").insert(
            day.crew.map((c) => ({
              event_day_id: dayId,
              crew_member_id: c.crew_member_id,
              role_text: c.role_text,
              notes: c.notes,
            })),
          );
          if (crewErr) {
            if (isMissingTable(crewErr)) {
              daysSkipped = true;
              break;
            }
            throw crewErr;
          }
        }
      }
      return { ok: true as const, id, daysSkipped };
    } catch (e: any) {
      if (createdId) {
        await db.from("events").delete().eq("id", createdId);
      }
      return { ok: false as const, message: e?.message ?? "שגיאה לא ידועה" };
    }
  }

  function missingDetails() {
    const missing: string[] = [];
    if (!form.client_id) missing.push("לקוח");
    if (!form.venue.trim()) missing.push("מקום");
    if (!form.address.trim()) missing.push("כתובת");
    if (!form.sales_rep_id && isAdmin) missing.push("איש מכירות");
    if (!form.start_time && !visibleDays.some((d) => d.start_time)) missing.push("שעות");
    if (!form.guest_count) missing.push("מספר משתתפים");
    if (!form.total_amount) missing.push("תקציב");
    return missing;
  }

  async function doSave(removeIds: string[], options?: { keepOpen?: boolean }): Promise<string | null> {
    const payload = buildEventPayload();
    const dayPayload = buildDayPayload();
    setBusy(true);
    const { data, error } = await db.rpc<string>("save_event_with_days", {
      p_event: payload,
      p_days: dayPayload,
      p_remove_day_ids: removeIds ?? [],
    });
    let failure: string | null = null;
    let daysSkipped = false;
    let savedId: string | null = event?.id ?? null;
    if (error) {
      const notFound = error.code === "PGRST202" || /could not find the function/i.test(error.message ?? "");
      if (notFound) {
        const fallback = await directSave(payload, dayPayload, removeIds ?? []);
        if (!fallback.ok) failure = fallback.message;
        else {
          daysSkipped = fallback.daysSkipped;
          savedId = fallback.id;
        }
      } else {
        failure = error.message || "שגיאה לא ידועה";
      }
    } else {
      savedId = typeof data === "string" ? data : event?.id ?? null;
    }
    setBusy(false);
    if (failure) {
      setErrors({ form: `שמירת האירוע נכשלה: ${failure}` });
      return null;
    }
    const missing = missingDetails();
    if (daysSkipped) {
      toast.success("האירוע נשמר; לוז הימים יישמר לאחר פרסום האתר");
    } else if (missing.length) {
      toast.success(`האירוע נשמר. חסרים עדיין: ${missing.join(", ")} — אפשר להשלים בהמשך.`);
    } else {
      toast.success(event ? "האירוע עודכן" : "האירוע נוצר");
    }
    queryClient.invalidateQueries({ queryKey: ["events"] });
    queryClient.invalidateQueries({ queryKey: ["event_days"] });
    queryClient.invalidateQueries({ queryKey: ["event_day_crew"] });
    onSaved();
    if (!options?.keepOpen) onOpenChange(false);
    return savedId;
  }

  function validateForm() {
    const next: Record<string, string> = {};
    if (!form.client_id) next.client_id = "נא לבחור לקוח.";
    if (!form.start_date) next.start_date = "נא לבחור תאריך.";
    if (form.start_date && form.end_date && form.end_date < form.start_date)
      next.end_date = "תאריך הסיום חייב להיות אחרי תאריך ההתחלה.";
    return next;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length) return;

    if (outOfRange.length) {
      setContinueAfterConfirm(false);
      setConfirmOpen(true);
      return;
    }
    await doSave([]);
  }

  async function saveAndContinue() {
    const next = validateForm();
    setErrors(next);
    if (Object.keys(next).length) return;

    if (outOfRange.length) {
      setContinueAfterConfirm(true);
      setConfirmOpen(true);
      return;
    }
    const id = await doSave([], { keepOpen: true });
    if (id) navigate({ to: "/quotes/new", search: { event: id, date: undefined } });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={event ? "עריכת אירוע" : "אירוע חדש"}
        description={event ? `${event.title} · ${dateShort(event.event_date)}` : "פתיחת כרטיס אירוע חדש"}
        size="lg"
        footer={
          <div className="space-y-2">
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                ביטול
              </Button>
              <Button type="submit" form="event-form" disabled={busy}>
                {busy ? "שומר…" : event ? "שמירת שינויים" : "יצירת אירוע"}
              </Button>
            </div>
            {!event && can("quotes", "edit") ? (
              <Button type="button" variant="secondary" onClick={saveAndContinue} disabled={busy} className="w-full">
                {busy ? "שומר…" : "המשך להצעת מחיר"}
              </Button>
            ) : null}
          </div>
        }
      >
        <form id="event-form" onSubmit={save} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="לקוח" htmlFor="ev-client" error={errors.client_id}>
              <ClientPicker id="ev-client" clients={clients} value={form.client_id} onChange={(id) => set("client_id", id)} />
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuickAddOpen((value) => !value)}
                  disabled={!canCreateClient}
                  className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                  title={!canCreateClient ? "אין לך הרשאה להוסיף לקוח" : undefined}
                >
                  <Plus className="size-4" /> הוסף לקוח חדש
                </button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditClientOpen(true)}
                  disabled={!canCreateClient || !selectedClient}
                  title={!selectedClient ? "בחר לקוח לעריכה" : undefined}
                >
                  <Pencil className="size-4" /> עריכת לקוח
                </Button>
                {!canCreateClient ? (
                  <p className="mt-1 text-xs text-muted-foreground">אין לך הרשאה להוסיף לקוח</p>
                ) : null}
              </div>
              {selectedClient ? <ClientContactsList client={selectedClient} className="mt-2 space-y-1.5" /> : null}
            </Field>
            <Field label="סוג אירוע" htmlFor="ev-type">
              <Select id="ev-type" value={form.event_type} onChange={(e) => set("event_type", e.target.value)}>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {quickAddOpen ? (
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-2 text-sm font-medium text-foreground">לקוח חדש</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="שם לקוח" htmlFor="quick-client-name">
                  <Input id="quick-client-name" value={quickName} onChange={(e) => setQuickName(e.target.value)} />
                </Field>
                <Field label="טלפון" htmlFor="quick-client-phone">
                  <Input id="quick-client-phone" value={quickPhone} onChange={(e) => setQuickPhone(e.target.value)} dir="ltr" className="text-start" />
                </Field>
                <Field label="אימייל" htmlFor="quick-client-email">
                  <Input id="quick-client-email" type="email" value={quickEmail} onChange={(e) => setQuickEmail(e.target.value)} dir="ltr" className="text-start" />
                </Field>
                <Field label="חברה" htmlFor="quick-client-company">
                  <Input id="quick-client-company" value={quickCompany} onChange={(e) => setQuickCompany(e.target.value)} />
                </Field>
                <Field label="כתובת" htmlFor="quick-client-address" className="sm:col-span-2">
                  <Input id="quick-client-address" value={quickAddress} onChange={(e) => setQuickAddress(e.target.value)} />
                </Field>
              </div>
              {quickError ? <p role="alert" className="mt-2 text-sm text-red-700">{quickError}</p> : null}
              <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={resetQuickAdd}>ביטול</Button>
                <Button type="button" onClick={saveQuickClient} disabled={quickBusy}>
                  {quickBusy ? "שומר…" : "שמור לקוח"}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="תאריך התחלה" htmlFor="ev-start-date" error={errors.start_date}>
              <Input
                id="ev-start-date"
                type="date"
                value={form.start_date}
                onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value, event_date: e.target.value }))}
              />
              {startHebrew ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {startHebrew.formatted}
                  {startHolidays.length ? ` · ${startHolidays.map((holiday) => holiday.name).join(", ")}` : ""}
                </p>
              ) : null}
            </Field>
            <Field label="תאריך סיום" htmlFor="ev-end-date" error={errors.end_date}>
              <Input
                id="ev-end-date"
                type="date"
                value={form.end_date}
                min={form.start_date || undefined}
                onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="שעת התחלה (ברירת מחדל)" htmlFor="ev-start">
              <Input id="ev-start" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} />
            </Field>
            <Field label="שעת סיום (ברירת מחדל)" htmlFor="ev-end">
              <Input id="ev-end" type="time" value={form.end_time} onChange={(e) => set("end_time", e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="שעת הגעה למחסן (ברירת מחדל)" htmlFor="ev-warehouse">
              <Input id="ev-warehouse" type="time" value={form.warehouse_time} onChange={(e) => set("warehouse_time", e.target.value)} />
            </Field>
            <Field label="שעת מוכנות האירוע (ברירת מחדל)" htmlFor="ev-ready">
              <Input id="ev-ready" type="time" value={form.ready_time} onChange={(e) => set("ready_time", e.target.value)} />
            </Field>
          </div>

          {isMultiDay ? (
          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">לוז לכל יום</p>
              <p className="text-xs text-muted-foreground">
                {visibleDays.length} {visibleDays.length === 1 ? "יום" : "ימים"}
              </p>
            </div>
            <div className="space-y-3">
              {visibleDays.map((day, idx) => (
                <div key={day.day_date} className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {weekdayShort(day.day_date)} · {dateLong(day.day_date)}
                    </p>
                    <span className="text-xs text-muted-foreground">יום {idx + 1}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="שעת מחסן" htmlFor={`day-wh-${day.day_date}`}>
                      <Input id={`day-wh-${day.day_date}`} type="time" value={day.warehouse_time} onChange={(e) => setDayField(day.day_date, "warehouse_time", e.target.value)} />
                    </Field>
                    <Field label="שעת מוכנים" htmlFor={`day-ready-${day.day_date}`}>
                      <Input id={`day-ready-${day.day_date}`} type="time" value={day.ready_time} onChange={(e) => setDayField(day.day_date, "ready_time", e.target.value)} />
                    </Field>
                    <Field label="תחילת אירוע" htmlFor={`day-start-${day.day_date}`}>
                      <Input id={`day-start-${day.day_date}`} type="time" value={day.start_time} onChange={(e) => setDayField(day.day_date, "start_time", e.target.value)} />
                    </Field>
                    <Field label="סיום אירוע" htmlFor={`day-end-${day.day_date}`}>
                      <Input id={`day-end-${day.day_date}`} type="time" value={day.end_time} onChange={(e) => setDayField(day.day_date, "end_time", e.target.value)} />
                    </Field>
                  </div>
                  <Field label="הערה ליום" htmlFor={`day-notes-${day.day_date}`}>
                    <Input id={`day-notes-${day.day_date}`} value={day.notes} onChange={(e) => setDayField(day.day_date, "notes", e.target.value)} placeholder="הערה ליום הזה" />
                  </Field>
                  <div className="mt-2">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">צוות ליום</p>
                    {day.crew.length ? (
                      <div className="space-y-2">
                        {day.crew.map((c) => {
                          const member = crew.find((m) => m.id === c.crew_member_id);
                          return (
                            <div key={c.crew_member_id} className="rounded-lg border border-border bg-muted/20 p-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium text-foreground">{member?.full_name ?? "איש צוות"}</span>
                                <button
                                  type="button"
                                  onClick={() => removeCrew(day.day_date, c.crew_member_id)}
                                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label="הסרת איש צוות"
                                >
                                  <X className="size-4" />
                                </button>
                              </div>
                              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                                <Input value={c.role_text} onChange={(e) => setCrewField(day.day_date, c.crew_member_id, "role_text", e.target.value)} placeholder="תפקיד" className="h-9" />
                                <Input value={c.notes} onChange={(e) => setCrewField(day.day_date, c.crew_member_id, "notes", e.target.value)} placeholder="הערה" className="h-9" />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">לא נבחר צוות ליום הזה.</p>
                    )}
                    <div className="mt-2">
                      <Select
                        value=""
                        onChange={(e) => addCrew(day.day_date, e.target.value)}
                        aria-label="הוספת איש צוות ליום"
                      >
                        <option value="">+ הוספת איש צוות</option>
                        {activeCrew
                          .filter((m) => !day.crew.some((c) => c.crew_member_id === m.id))
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.full_name} · {crewRolesLabel(m)}
                            </option>
                          ))}
                      </Select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="מקום" htmlFor="ev-venue">
              <Input id="ev-venue" value={form.venue} onChange={(e) => set("venue", e.target.value)} placeholder="שם האולם או המתחם" />
            </Field>
            <Field label="כתובת" htmlFor="ev-address">
              <Input id="ev-address" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="רחוב, עיר" />
            </Field>
          </div>

          <div className={`grid gap-3 ${canEditStatus ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            {canEditStatus ? (
              <Field label="סטטוס" htmlFor="ev-status" error={errors.status}>
                <Select id="ev-status" value={form.status} onChange={(e) => set("status", e.target.value)}>
                  {EVENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {formatStatusLabel(s)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="מספר משתתפים" htmlFor="ev-guests" error={errors.guest_count}>
              <Input id="ev-guests" type="number" min={0} value={form.guest_count} onChange={(e) => set("guest_count", e.target.value)} placeholder="0" />
            </Field>
            <Field label="תקציב משוער (₪)" htmlFor="ev-total" error={errors.total_amount}>
              <Input id="ev-total" type="number" min={0} step="any" inputMode="decimal" value={form.total_amount} onChange={(e) => set("total_amount", e.target.value)} placeholder="0" />
            </Field>
          </div>

          <Field label="איש מכירות אחראי" htmlFor="ev-rep" error={errors.sales_rep_id}>
            {isAdmin ? (
              <Select id="ev-rep" value={form.sales_rep_id} onChange={(e) => set("sales_rep_id", e.target.value)}>
                <option value="">ללא שיוך</option>
                {profiles
                  .filter((p) => p.role === "sales" || p.role === "admin")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
              </Select>
            ) : (
              <Input id="ev-rep" value={currentProfile?.full_name ?? ""} readOnly className="bg-muted" />
            )}
          </Field>

          <Field label="הערות" htmlFor="ev-notes">
            <Textarea id="ev-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="בקשות מיוחדות, סידורי הגעה, אנשי קשר בשטח" />
          </Field>

          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            אפשר לשמור גם עם פרטים חלקיים — שני השדות היחידים שחובה למלא הם שם לקוח ותאריך. את שאר הפרטים אפשר להשלים בהמשך מעריכת האירוע.
          </p>

          {errors.form ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {errors.form}
            </p>
          ) : null}
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) setContinueAfterConfirm(false);
        }}
        title="מחיקת ימים מהאירוע"
        description={`הימים הבאים מחוץ לטווח החדש ויימחקו מהאירוע: ${outOfRange
          .map((d) => dateShort(d.day_date))
          .join(", ")}. להמשיך?`}
        confirmLabel="מחיקה ושמירה"
        onConfirm={() => {
          setConfirmOpen(false);
          const ids = outOfRange.map((d) => d.id!).filter(Boolean);
          void (async () => {
            const id = await doSave(ids, { keepOpen: continueAfterConfirm });
            if (id && continueAfterConfirm) navigate({ to: "/quotes/new", search: { event: id, date: undefined } });
            setContinueAfterConfirm(false);
          })();
        }}
        busy={busy}
      />
      <ClientForm
        open={editClientOpen}
        onOpenChange={setEditClientOpen}
        client={selectedClient}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["clients"] });
        }}
      />
    </>
  );
}
