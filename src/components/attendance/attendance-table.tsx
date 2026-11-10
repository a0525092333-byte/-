import { useMemo, useState } from "react";
import { Check, Clock, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ManualFlags } from "@/components/attendance/manual-flags";
import { Select } from "@/components/ui/controls";
import { EmptyState, SectionCard } from "@/components/shared";
import {
  ADDITION_LABELS,
  DAY_TYPE_LABELS,
  ENTRY_STATUS_LABELS,
  entryMinutes,
  formatMinutes,
  monthLabelHe,
  n,
  weekdayHe,
} from "@/lib/attendance";
import { dateShort } from "@/lib/format";
import type { DayType, EntryStatus, Profile, TimeEntry, TimeEntryAddition } from "@/lib/types";

function needsReview(entry: TimeEntry, additions: TimeEntryAddition[]): boolean {
  const addHours = additions.reduce((sum, a) => sum + n(a.hours), 0);
  return addHours > 8 || (entry.note ?? "").length > 180;
}

export function AttendanceTable({
  entries,
  additions,
  profiles,
  month,
  onMonthChange,
  onApprove,
  onEdit,
  busy,
  canEdit,
}: {
  entries: TimeEntry[];
  additions: TimeEntryAddition[];
  profiles: Profile[];
  month: string;
  onMonthChange: (month: string) => void;
  onApprove: (entry: TimeEntry, approved: boolean) => void;
  onEdit: (entry: TimeEntry) => void;
  busy: boolean;
  canEdit: boolean;
}) {
  const [employeeId, setEmployeeId] = useState("all");
  const [status, setStatus] = useState<"all" | EntryStatus>("all");
  const [dayType, setDayType] = useState<"all" | DayType>("all");

  const byEntry = useMemo(() => {
    const map: Record<string, TimeEntryAddition[]> = {};
    for (const a of additions) (map[a.entry_id] ??= []).push(a);
    return map;
  }, [additions]);

  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.full_name ?? "עובד";

  const rows = useMemo(
    () =>
      entries
        .filter((e) => (e.work_date ?? "").startsWith(month))
        .filter((e) => employeeId === "all" || e.user_id === employeeId)
        .filter((e) => status === "all" || e.status === status)
        .filter((e) => dayType === "all" || e.day_type === dayType)
        .sort((a, b) => b.work_date.localeCompare(a.work_date)),
    [entries, month, employeeId, status, dayType],
  );

  return (
    <SectionCard
      title="כל העובדים"
      description={`דיווחי נוכחות ל${monthLabelHe(month)}`}
      action={
        <Select value={month} onChange={(e) => onMonthChange(e.target.value)} className="h-10 w-40 text-xs">
          {Array.from({ length: 12 }).map((_, i) => {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            return <option key={key} value={key}>{monthLabelHe(key)}</option>;
          })}
        </Select>
      }
    >
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="סינון לפי עובד">
          <option value="all">כל העובדים</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as "all" | EntryStatus)} aria-label="סינון לפי סטטוס">
          <option value="all">כל הסטטוסים</option>
          <option value="submitted">הוגש</option>
          <option value="approved">מאושר</option>
          <option value="draft">טיוטה</option>
        </Select>
        <Select value={dayType} onChange={(e) => setDayType(e.target.value as "all" | DayType)} aria-label="סינון לפי סוג יום">
          <option value="all">כל סוגי הימים</option>
          {(Object.keys(DAY_TYPE_LABELS) as DayType[]).map((key) => <option key={key} value={key}>{DAY_TYPE_LABELS[key]}</option>)}
        </Select>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Clock} title="אין דיווחים בחודש הזה" description="בחר חודש אחר או נקה את הסינון." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-start font-medium">עובד</th>
                <th className="px-3 py-2 text-start font-medium">תאריך</th>
                <th className="px-3 py-2 text-start font-medium">שעות</th>
                <th className="px-3 py-2 text-start font-medium">סוג</th>
                <th className="px-3 py-2 text-start font-medium">תוספות</th>
                <th className="px-3 py-2 text-start font-medium">נסיעות</th>
                <th className="px-3 py-2 text-start font-medium">הערה</th>
                <th className="px-3 py-2 text-start font-medium">סטטוס</th>
                <th className="px-3 py-2 text-start font-medium">פעולות</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((entry) => {
                const adds = byEntry[entry.id] ?? [];
                const addHours = adds.reduce((sum, a) => sum + n(a.hours), 0);
                const addAmount = adds.reduce((sum, a) => sum + n(a.amount), 0);
                const review = needsReview(entry, adds);
                return (
                  <tr key={entry.id} className="align-top">
                    <td className="px-3 py-2 font-medium text-foreground">{nameOf(entry.user_id)}</td>
                    <td className="px-3 py-2">
                      <p className="text-foreground">{dateShort(entry.work_date)}</p>
                      <p className="text-[10px] text-muted-foreground">{weekdayHe(entry.work_date)}</p>
                    </td>
                    <td className="px-3 py-2">
                      <p className="num text-foreground">{formatMinutes(entryMinutes(entry))}</p>
                      <p className="text-[10px] text-muted-foreground">{entry.start_time?.slice(0, 5) ?? "—"}–{entry.end_time?.slice(0, 5) ?? "—"}</p>
                    </td>
                    <td className="px-3 py-2 text-foreground">{DAY_TYPE_LABELS[entry.day_type]}</td>
                    <td className="px-3 py-2">
                      {adds.length ? (
                        <div className="space-y-0.5">
                          <p className="text-foreground">{addHours} ש' · {addAmount.toLocaleString("he-IL")} ₪</p>
                          <p className="text-[10px] text-muted-foreground">{adds.map((a) => ADDITION_LABELS[a.add_type]).join(", ")}</p>
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {n(entry.travel_km) ? `${n(entry.travel_km)} ק"מ` : "—"}
                      {n(entry.travel_amount) ? <span className="block text-[10px] text-muted-foreground">{n(entry.travel_amount)} ₪</span> : null}
                    </td>
                    <td className="max-w-[180px] px-3 py-2">
                      <p className="line-clamp-2 text-muted-foreground">{entry.note || "—"}</p>
                      {review ? <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">לבדיקה</span> : null}
                      <ManualFlags entry={entry} profiles={profiles} />
                    </td>
                    <td className="px-3 py-2">
                      <span className={entry.status === "approved" ? "text-emerald-700" : "text-muted-foreground"}>
                        {ENTRY_STATUS_LABELS[entry.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <Button type="button" variant="outline" size="sm" onClick={() => onEdit(entry)} disabled={busy || !canEdit}>
                          <Pencil className="size-3.5" /> עריכה
                        </Button>
                        {entry.status === "approved" ? (
                          <Button type="button" variant="ghost" size="sm" onClick={() => onApprove(entry, false)} disabled={busy || !canEdit}>
                            <RotateCcw className="size-3.5" /> ביטול אישור
                          </Button>
                        ) : (
                          <Button type="button" variant="secondary" size="sm" onClick={() => onApprove(entry, true)} disabled={busy || !canEdit}>
                            <Check className="size-3.5" /> אישור
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
