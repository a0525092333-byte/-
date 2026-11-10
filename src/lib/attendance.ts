import type {
  AdditionType,
  DayType,
  EntryStatus,
  Profile,
  ShiftType,
  TimeEntry,
  TimeEntryAddition,
} from "./types";

export const DAY_TYPE_LABELS: Record<DayType, string> = {
  work: "עבודה",
  vacation: "חופשה",
  sick: "מחלה",
  reserve: "מילואים",
  holiday: "חג",
  absence: "היעדרות",
};

export const SHIFT_TYPE_LABELS: Record<ShiftType, string> = {
  day: "יום",
  evening: "ערב",
  night: "לילה",
};

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  draft: "טיוטה",
  submitted: "הוגש",
  approved: "מאושר",
};

export const ADDITION_TYPES: {
  key: AdditionType;
  label: string;
  defaultRate: number;
  unit: "hours" | "amount";
}[] = [
  { key: "overtime_125", label: "שעות נוספות 125%", defaultRate: 1.25, unit: "hours" },
  { key: "overtime_150", label: "שעות נוספות 150%", defaultRate: 1.5, unit: "hours" },
  { key: "night", label: "תוספת לילה", defaultRate: 1, unit: "hours" },
  { key: "shabbat", label: "תוספת שבת", defaultRate: 1.5, unit: "hours" },
  { key: "holiday", label: "תוספת חג", defaultRate: 1.5, unit: "hours" },
  { key: "oncall", label: "כוננות", defaultRate: 1, unit: "hours" },
  { key: "meal", label: "ארוחה", defaultRate: 1, unit: "amount" },
  { key: "travel", label: "נסיעות", defaultRate: 1, unit: "amount" },
  { key: "other", label: "אחר", defaultRate: 1, unit: "hours" },
];

export const ADDITION_LABELS: Record<AdditionType, string> = Object.fromEntries(
  ADDITION_TYPES.map((a) => [a.key, a.label]),
) as Record<AdditionType, string>;

export function n(value: number | string | null | undefined): number {
  const x = Number(value ?? 0);
  return Number.isFinite(x) ? x : 0;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function nowTime(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function minutesBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = start.split(":").map(Number);
  const b = end.split(":").map(Number);
  if (a.length < 2 || b.length < 2 || [...a, ...b].some((v) => Number.isNaN(v))) return null;
  let mins = b[0] * 60 + b[1] - (a[0] * 60 + a[1]);
  if (mins < 0) mins += 24 * 60;
  return mins;
}

export function entryMinutes(entry: Pick<TimeEntry, "start_time" | "end_time" | "break_minutes">): number {
  const mins = minutesBetween(entry.start_time, entry.end_time);
  if (mins == null) return 0;
  return Math.max(0, mins - n(entry.break_minutes));
}

export function formatMinutes(mins: number): string {
  const total = Math.max(0, Math.round(mins));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export function hoursOf(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

export function elapsedSeconds(start: string | null, now: Date): number {
  if (!start) return 0;
  const [h, m, s] = start.split(":").map(Number);
  const startSec = (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  let diff = nowSec - startSec;
  if (diff < 0) diff += 86_400;
  return diff;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function monthRange(monthKey: string): { from: string; to: string } {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad2(last)}` };
}

export function monthLabelHe(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
}

export function weekdayHe(date: string): string {
  return new Intl.DateTimeFormat("he-IL", { weekday: "long" }).format(new Date(`${date}T12:00:00`));
}

export type EmployeeReport = {
  employee: Profile;
  entries: TimeEntry[];
  additionsByEntry: Record<string, TimeEntryAddition[]>;
  daysReported: number;
  totalMinutes: number;
  regularMinutes: number;
  overtime125Minutes: number;
  overtime150Minutes: number;
  nightHours: number;
  shabbatHours: number;
  holidayHours: number;
  oncallHours: number;
  mealAmount: number;
  travelKm: number;
  travelAmount: number;
  entryTravelAmount: number;
  additionsHours: number;
  additionsAmount: number;
  estimatedCost: number | null;
  vacationDays: number;
  sickDays: number;
  reserveDays: number;
  holidayDays: number;
  absenceDays: number;
};

export type MonthlyReport = {
  monthKey: string;
  employees: EmployeeReport[];
  totals: Omit<EmployeeReport, "employee" | "entries" | "additionsByEntry">;
};

export function groupAdditions(additions: TimeEntryAddition[]): Record<string, TimeEntryAddition[]> {
  const map: Record<string, TimeEntryAddition[]> = {};
  for (const a of additions) {
    (map[a.entry_id] ??= []).push(a);
  }
  return map;
}

function summarizeEmployee(
  employee: Profile,
  entries: TimeEntry[],
  byEntry: Record<string, TimeEntryAddition[]>,
): EmployeeReport {
  const sorted = [...entries].sort((a, b) => a.work_date.localeCompare(b.work_date));
  let totalMinutes = 0;
  let ot125 = 0;
  let ot150 = 0;
  let night = 0;
  let shabbat = 0;
  let holiday = 0;
  let oncall = 0;
  let meal = 0;
  let travelKm = 0;
  let travelAmount = 0;
  let entryTravelAmount = 0;
  let additionsHours = 0;
  let additionsAmount = 0;
  let vacation = 0;
  let sick = 0;
  let reserve = 0;
  let holidayDays = 0;
  let absence = 0;

  for (const entry of sorted) {
    totalMinutes += entryMinutes(entry);
    travelKm += n(entry.travel_km);
    travelAmount += n(entry.travel_amount);
    entryTravelAmount += n(entry.travel_amount);
    if (entry.day_type === "vacation") vacation += 1;
    if (entry.day_type === "sick") sick += 1;
    if (entry.day_type === "reserve") reserve += 1;
    if (entry.day_type === "holiday") holidayDays += 1;
    if (entry.day_type === "absence") absence += 1;

    for (const a of byEntry[entry.id] ?? []) {
      const h = n(a.hours);
      const amt = n(a.amount);
      additionsHours += h;
      additionsAmount += amt;
      if (a.add_type === "overtime_125") ot125 += h * 60;
      if (a.add_type === "overtime_150") ot150 += h * 60;
      if (a.add_type === "night") night += h;
      if (a.add_type === "shabbat") shabbat += h;
      if (a.add_type === "holiday") holiday += h;
      if (a.add_type === "oncall") oncall += h;
      if (a.add_type === "meal") meal += amt;
      if (a.add_type === "travel") travelAmount += amt;
    }
  }

  const regular = Math.max(0, totalMinutes - ot125 - ot150);
  let estimatedCost: number | null = null;
  if (employee.hourly_rate != null) {
    const rate = n(employee.hourly_rate);
    let addCost = 0;
    for (const entry of sorted) {
      for (const a of byEntry[entry.id] ?? []) {
        if (n(a.hours) > 0) addCost += n(a.hours) * rate * n(a.rate);
      }
    }
    estimatedCost = Math.round(((regular / 60) * rate + addCost + additionsAmount + entryTravelAmount) * 100) / 100;
  }

  return {
    employee,
    entries: sorted,
    additionsByEntry: byEntry,
    daysReported: sorted.length,
    totalMinutes,
    regularMinutes: regular,
    overtime125Minutes: ot125,
    overtime150Minutes: ot150,
    nightHours: night,
    shabbatHours: shabbat,
    holidayHours: holiday,
    oncallHours: oncall,
    mealAmount: meal,
    travelKm,
    travelAmount,
    entryTravelAmount,
    additionsHours,
    additionsAmount,
    estimatedCost,
    vacationDays: vacation,
    sickDays: sick,
    reserveDays: reserve,
    holidayDays,
    absenceDays: absence,
  };
}

export function buildMonthlyReport(
  entries: TimeEntry[],
  additions: TimeEntryAddition[],
  employees: Profile[],
  monthKey: string,
): { monthKey: string; employees: EmployeeReport[]; totals: MonthlyReport["totals"] } {
  const byEntry = groupAdditions(additions);
  const monthEntries = entries.filter((e) => (e.work_date ?? "").startsWith(monthKey));
  const ids = new Set(monthEntries.map((e) => e.user_id));
  const reports = employees
    .filter((p) => ids.has(p.id))
    .map((employee) =>
      summarizeEmployee(
        employee,
        monthEntries.filter((e) => e.user_id === employee.id),
        byEntry,
      ),
    );

  const totals: MonthlyReport["totals"] = {
    daysReported: 0,
    totalMinutes: 0,
    regularMinutes: 0,
    overtime125Minutes: 0,
    overtime150Minutes: 0,
    nightHours: 0,
    shabbatHours: 0,
    holidayHours: 0,
    oncallHours: 0,
    mealAmount: 0,
    travelKm: 0,
    travelAmount: 0,
    entryTravelAmount: 0,
    additionsHours: 0,
    additionsAmount: 0,
    estimatedCost: null,
    vacationDays: 0,
    sickDays: 0,
    reserveDays: 0,
    holidayDays: 0,
    absenceDays: 0,
  };

  let anyCost = false;
  for (const r of reports) {
    totals.daysReported += r.daysReported;
    totals.totalMinutes += r.totalMinutes;
    totals.regularMinutes += r.regularMinutes;
    totals.overtime125Minutes += r.overtime125Minutes;
    totals.overtime150Minutes += r.overtime150Minutes;
    totals.nightHours += r.nightHours;
    totals.shabbatHours += r.shabbatHours;
    totals.holidayHours += r.holidayHours;
    totals.oncallHours += r.oncallHours;
    totals.mealAmount += r.mealAmount;
    totals.travelKm += r.travelKm;
    totals.travelAmount += r.travelAmount;
    totals.entryTravelAmount += r.entryTravelAmount;
    totals.additionsHours += r.additionsHours;
    totals.additionsAmount += r.additionsAmount;
    totals.vacationDays += r.vacationDays;
    totals.sickDays += r.sickDays;
    totals.reserveDays += r.reserveDays;
    totals.holidayDays += r.holidayDays;
    totals.absenceDays += r.absenceDays;
    if (r.estimatedCost != null) {
      anyCost = true;
      totals.estimatedCost = (totals.estimatedCost ?? 0) + r.estimatedCost;
    }
  }
  if (!anyCost) totals.estimatedCost = null;

  return { monthKey, employees: reports, totals };
}

function csvCell(value: string | number | null | undefined): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportToCsv(
  report: MonthlyReport,
  options: { includeAdminBreakdown?: boolean } = {},
): string {
  const includeAdmin = options.includeAdminBreakdown !== false;
  const lines: string[] = [];
  lines.push(
    [
      "עובד", "תאריך", "יום בשבוע", "כניסה", "יציאה", "הפסקה (דקות)", "שעות",
      ...(includeAdmin ? ["סוג יום"] : []),
      "משמרת", "תוספות", "שעות תוספות", "סכום תוספות", "נסיעות (ק\"מ)", "נסיעות (₪)", "הערה", "סטטוס",
    ]
      .map(csvCell)
      .join(","),
  );

  for (const emp of report.employees) {
    for (const entry of emp.entries) {
      const adds = emp.additionsByEntry[entry.id] ?? [];
      const addText = adds
        .map((a) => {
          const h = n(a.hours);
          const amt = n(a.amount);
          return `${ADDITION_LABELS[a.add_type]}${h ? ` ${h} ש'` : ""}${amt ? ` ${amt} ₪` : ""}`;
        })
        .join(" | ");
      lines.push(
        [
          emp.employee.full_name,
          entry.work_date,
          weekdayHe(entry.work_date),
          entry.start_time ?? "",
          entry.end_time ?? "",
          n(entry.break_minutes),
          formatMinutes(entryMinutes(entry)),
          ...(includeAdmin ? [DAY_TYPE_LABELS[entry.day_type]] : []),
          SHIFT_TYPE_LABELS[entry.shift_type],
          addText,
          n(emp.additionsByEntry[entry.id]?.reduce((s, a) => s + n(a.hours), 0)),
          n(emp.additionsByEntry[entry.id]?.reduce((s, a) => s + n(a.amount), 0)),
          n(entry.travel_km),
          n(entry.travel_amount),
          entry.note ?? "",
          ENTRY_STATUS_LABELS[entry.status],
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }

  lines.push("");
  lines.push(
    [
      "סיכום", "עובד", "ימים", "שעות סה\"כ",
      ...(includeAdmin ? ["רגילות", "125%", "150%", "לילה", "שבת", "חג"] : []),
      "כוננות", "ארוחות", "נסיעות ק\"מ", "נסיעות ₪", "עלות משוערת",
    ]
      .map(csvCell)
      .join(","),
  );
  for (const emp of report.employees) {
    lines.push(
      [
        "סיכום",
        emp.employee.full_name,
        emp.daysReported,
        formatMinutes(emp.totalMinutes),
        ...(includeAdmin
          ? [
              formatMinutes(emp.regularMinutes),
              formatMinutes(emp.overtime125Minutes),
              formatMinutes(emp.overtime150Minutes),
              emp.nightHours,
              emp.shabbatHours,
              emp.holidayHours,
            ]
          : []),
        emp.oncallHours,
        emp.mealAmount,
        emp.travelKm,
        emp.travelAmount,
        emp.estimatedCost ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const t = report.totals;
  lines.push(
    [
      "סיכום חברה",
      "",
      t.daysReported,
      formatMinutes(t.totalMinutes),
      ...(includeAdmin
        ? [
            formatMinutes(t.regularMinutes),
            formatMinutes(t.overtime125Minutes),
            formatMinutes(t.overtime150Minutes),
            t.nightHours,
            t.shabbatHours,
            t.holidayHours,
          ]
        : []),
      t.oncallHours,
      t.mealAmount,
      t.travelKm,
      t.travelAmount,
      t.estimatedCost ?? "",
    ]
      .map(csvCell)
      .join(","),
  );

  return "\uFEFF" + lines.join("\r\n");
}
