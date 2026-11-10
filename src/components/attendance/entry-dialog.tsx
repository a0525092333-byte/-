import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import { todayISO, toTimeInput } from "@/lib/format";
import {
  ADDITION_TYPES,
  DAY_TYPE_LABELS,
  SHIFT_TYPE_LABELS,
  formatMinutes,
  minutesBetween,
  n,
} from "@/lib/attendance";
import type {
  AdditionType,
  DayType,
  EventRow,
  Profile,
  ShiftType,
  TimeEntry,
  TimeEntryAddition,
} from "@/lib/types";

type AdditionRow = {
  key: string;
  add_type: AdditionType;
  hours: string;
  rate: string;
  amount: string;
  note: string;
};

export function EntryDialog({
  open,
  onOpenChange,
  entry,
  additions,
  employees,
  canManageOthers,
  currentUserId,
  events,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: TimeEntry | null;
  additions: TimeEntryAddition[];
  employees: Profile[];
  canManageOthers: boolean;
  currentUserId: string;
  events: EventRow[];
  onSaved: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(currentUserId);
  const [workDate, setWorkDate] = useState(todayISO());
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [dayType, setDayType] = useState<DayType>("work");
  const [shiftType, setShiftType] = useState<ShiftType>("day");
  const [travelKm, setTravelKm] = useState("0");
  const [travelAmount, setTravelAmount] = useState("0");
  const [eventId, setEventId] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<AdditionRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (entry) {
      setEmployeeId(entry.user_id);
      setWorkDate(entry.work_date);
      setStartTime(toTimeInput(entry.start_time));
      setEndTime(toTimeInput(entry.end_time));
      setBreakMinutes(String(n(entry.break_minutes)));
      setDayType(entry.day_type);
      setShiftType(entry.shift_type);
      setTravelKm(String(n(entry.travel_km)));
      setTravelAmount(String(n(entry.travel_amount)));
      setEventId(entry.event_id ?? "");
      setNote(entry.note ?? "");
      setRows(
        (additions ?? []).map((a) => ({
          key: a.id,
          add_type: a.add_type,
          hours: String(n(a.hours)),
          rate: String(n(a.rate)),
          amount: String(n(a.amount)),
          note: a.note ?? "",
        })),
      );
    } else {
      setEmployeeId(currentUserId);
      setWorkDate(todayISO());
      setStartTime("");
      setEndTime("");
      setBreakMinutes("0");
      setDayType("work");
      setShiftType("day");
      setTravelKm("0");
      setTravelAmount("0");
      setEventId("");
      setNote("");
      setRows([]);
    }
  }, [open, entry?.id]);

  function updateRow(key: string, patch: Partial<AdditionRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { key: crypto.randomUUID(), add_type: "overtime_125", hours: "0", rate: "1.25", amount: "0", note: "" },
    ]);
  }

  function changeType(key: string, type: AdditionType) {
    const def = ADDITION_TYPES.find((a) => a.key === type);
    updateRow(key, { add_type: type, rate: String(def?.defaultRate ?? 1) });
  }

  const entryMins = minutesBetween(startTime || null, endTime || null);
  const workedMins = entryMins == null ? 0 : Math.max(0, entryMins - (Number(breakMinutes) || 0));
  const additionsMins = rows.reduce((sum, row) => sum + (Number(row.hours) || 0) * 60, 0);
  const additionsAmount = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const totalAmount = additionsAmount + (Number(travelAmount) || 0);

  function validate(): string | null {
    if (!workDate) return "נא לבחור תאריך.";
    if (dayType === "work") {
      if (!startTime || !endTime) return "ביום עבודה חובה למלא שעת התחלה וסיום.";
      const mins = minutesBetween(startTime, endTime);
      if (mins == null || mins <= 0) return "שעות המשמרת אינן תקינות.";
      const br = Number(breakMinutes) || 0;
      if (br < 0) return "דקות ההפסקה אינן יכולות להיות שליליות.";
      if (br >= mins) return "דקות ההפסקה גדולות משעות המשמרת.";
    }
    if ((Number(travelKm) || 0) < 0 || (Number(travelAmount) || 0) < 0) {
      return "ערכי הנסיעות אינם יכולים להיות שליליים.";
    }
    for (const row of rows) {
      if ((Number(row.hours) || 0) < 0 || (Number(row.rate) || 0) < 0 || (Number(row.amount) || 0) < 0) {
        return "ערכי התוספות אינם יכולים להיות שליליים.";
      }
    }
    return null;
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    if (entry?.status === "approved" && !canManageOthers) {
      setError("יום מאושר אינו ניתן לעריכה. פנה למנהל.");
      return;
    }
    setSaving(true);
    setError(null);
    const id = entry?.id ?? crypto.randomUUID();
    const payload = {
      user_id: employeeId,
      work_date: workDate,
      start_time: startTime || null,
      end_time: endTime || null,
      break_minutes: Number(breakMinutes) || 0,
      day_type: dayType,
      shift_type: shiftType,
      travel_km: Number(travelKm) || 0,
      travel_amount: Number(travelAmount) || 0,
      event_id: eventId || null,
      note: note.trim() || null,
      status: entry?.status ?? "submitted",
    };
    const result = entry
      ? await db.from("time_entries").update(payload).eq("id", id)
      : await db.from("time_entries").insert({
          id,
          ...payload,
          entry_source: "manual",
          created_by: currentUserId || null,
        });
    if (result.error) {
      setSaving(false);
      setError(
        entry?.status === "approved"
          ? "יום מאושר אינו ניתן לעריכה."
          : "לא הצלחנו לשמור את הדיווח. בדוק את הפרטים ונסה שוב.",
      );
      return;
    }
    if (entry) {
      const removed = await db.from("time_entry_additions").delete().eq("entry_id", id);
      if (removed.error) {
        setSaving(false);
        toast.error("הדיווח עודכן, אבל התוספות לא עודכנו. נסה שוב.");
        onSaved();
        onOpenChange(false);
        return;
      }
    }
    const rowsToInsert = rows
      .filter((row) => (Number(row.hours) || 0) > 0 || (Number(row.amount) || 0) > 0 || row.note.trim())
      .map((row) => ({
        entry_id: id,
        add_type: row.add_type,
        hours: Number(row.hours) || 0,
        rate: Number(row.rate) || 1,
        amount: Number(row.amount) || 0,
        note: row.note.trim() || null,
      }));
    if (rowsToInsert.length) {
      const inserted = await db.from("time_entry_additions").insert(rowsToInsert);
      if (inserted.error) {
        setSaving(false);
        toast.error("הדיווח נשמר, אבל התוספות לא נשמרו. פתח אותו והוסף אותן שוב.");
        onSaved();
        onOpenChange(false);
        return;
      }
    }
    setSaving(false);
    toast.success(entry ? "הדיווח עודכן" : "הדיווח נוסף");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? "עריכת רשומת נוכחות" : "הוספת דיווח ידני"}
      description="שעות, תוספות, נסיעות והערה יומית"
      size="lg"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {canManageOthers ? (
            <Field label="עובד" htmlFor="entry-employee">
              <Select id="entry-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.full_name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="תאריך" htmlFor="entry-date">
            <Input id="entry-date" type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} className="h-11" />
          </Field>
          <Field label="סוג יום" htmlFor="entry-day-type">
            <Select id="entry-day-type" value={dayType} onChange={(e) => setDayType(e.target.value as DayType)}>
              {(Object.keys(DAY_TYPE_LABELS) as DayType[]).map((key) => (
                <option key={key} value={key}>{DAY_TYPE_LABELS[key]}</option>
              ))}
            </Select>
          </Field>
          <Field label="משמרת" htmlFor="entry-shift">
            <Select id="entry-shift" value={shiftType} onChange={(e) => setShiftType(e.target.value as ShiftType)}>
              {(Object.keys(SHIFT_TYPE_LABELS) as ShiftType[]).map((key) => (
                <option key={key} value={key}>{SHIFT_TYPE_LABELS[key]}</option>
              ))}
            </Select>
          </Field>
          <Field label="שעת התחלה" htmlFor="entry-start">
            <Input id="entry-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="h-11" />
          </Field>
          <Field label="שעת סיום" htmlFor="entry-end">
            <Input id="entry-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="h-11" />
          </Field>
          <Field label="הפסקה בדקות" htmlFor="entry-break">
            <Input id="entry-break" type="number" min="0" step="1" value={breakMinutes} onChange={(e) => setBreakMinutes(e.target.value)} className="h-11" />
          </Field>
          <Field label="קילומטרים לנסיעות" htmlFor="entry-km">
            <Input id="entry-km" type="number" min="0" step="0.01" value={travelKm} onChange={(e) => setTravelKm(e.target.value)} className="h-11" />
          </Field>
          <Field label="סכום נסיעות (₪)" htmlFor="entry-travel">
            <Input id="entry-travel" type="number" min="0" step="0.01" value={travelAmount} onChange={(e) => setTravelAmount(e.target.value)} className="h-11" />
          </Field>
          {events.length ? (
            <Field label="אירוע משויך (אופציונלי)" htmlFor="entry-event">
              <Select id="entry-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
                <option value="">ללא אירוע</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>{event.title}</option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>

        <Field label="הערה על היום" htmlFor="entry-note" hint="ההערה תופיע ברשימת הימים ובדוח החודשי">
          <Textarea id="entry-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="לדוגמה: יום צילומים, איחור של חצי שעה בגלל פקקים" />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">תוספות</p>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus className="size-4" /> הוספת תוספת
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              אין תוספות ליום הזה. אפשר להוסיף שעות נוספות, תוספת לילה, נסיעה ועוד.
            </p>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => (
                <div key={row.key} className="rounded-xl border border-border/70 p-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="סוג תוספת" htmlFor={`add-type-${row.key}`}>
                      <Select id={`add-type-${row.key}`} value={row.add_type} onChange={(e) => changeType(row.key, e.target.value as AdditionType)}>
                        {ADDITION_TYPES.map((type) => (
                          <option key={type.key} value={type.key}>{type.label}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="שעות" htmlFor={`add-hours-${row.key}`}>
                      <Input id={`add-hours-${row.key}`} type="number" min="0" step="0.25" value={row.hours} onChange={(e) => updateRow(row.key, { hours: e.target.value })} className="h-11" />
                    </Field>
                    <Field label="מקדם" htmlFor={`add-rate-${row.key}`}>
                      <Input id={`add-rate-${row.key}`} type="number" min="0" step="0.05" value={row.rate} onChange={(e) => updateRow(row.key, { rate: e.target.value })} className="h-11" />
                    </Field>
                    <Field label="סכום (₪)" htmlFor={`add-amount-${row.key}`}>
                      <Input id={`add-amount-${row.key}`} type="number" min="0" step="0.01" value={row.amount} onChange={(e) => updateRow(row.key, { amount: e.target.value })} className="h-11" />
                    </Field>
                  </div>
                  <div className="mt-3 flex items-end gap-2">
                    <Field label="הערה לתוספת" htmlFor={`add-note-${row.key}`} className="flex-1">
                      <Input id={`add-note-${row.key}`} value={row.note} onChange={(e) => updateRow(row.key, { note: e.target.value })} className="h-11" />
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                      aria-label="הסרת תוספת"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-3 rounded-xl bg-muted/50 p-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">שעות עבודה</p>
            <p className="num font-semibold text-foreground">{formatMinutes(workedMins)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">שעות תוספות</p>
            <p className="num font-semibold text-foreground">{formatMinutes(additionsMins)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">סה"כ לתשלום</p>
            <p className="num font-semibold text-foreground">
              {totalAmount.toLocaleString("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 })}
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            ביטול
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "שומר…" : entry ? "שמירת שינויים" : "הוספת דיווח"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
