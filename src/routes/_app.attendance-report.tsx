import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Download, FileText, Printer } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useProfiles, useTimeEntries, useTimeEntryAdditions } from "@/hooks/use-data";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, SectionCard, StatCard } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { ManualFlags } from "@/components/attendance/manual-flags";
import { attendanceContent } from "@/content/attendance";
import { site } from "@/content/site";
import { dateShort, money } from "@/lib/format";
import {
  ADDITION_LABELS,
  DAY_TYPE_LABELS,
  ENTRY_STATUS_LABELS,
  buildMonthlyReport,
  entryMinutes,
  formatMinutes,
  monthKeyOf,
  monthLabelHe,
  monthRange,
  n,
  reportToCsv,
  weekdayHe,
} from "@/lib/attendance";

export const Route = createFileRoute("/_app/attendance-report")({ component: ReportPage });

const MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

// Breakdown figures that only an admin may see. Non-admins get the rest of the
// report (header, selectors, summary row, daily list, timesheet) unchanged.
const ADMIN_ONLY_BREAKDOWN = new Set([
  "שעות רגילות",
  "שעות נוספות",
  "שעות 125%",
  "שעות 150%",
  "שעות לילה",
  "שעות שבת",
  "שעות חג",
  "ימי חג",
  "מילואים / היעדרות",
  "חופשה / מחלה",
]);

function BreakdownGrid({ items, isAdmin }: { items: { label: string; value: string }[]; isAdmin: boolean }) {
  const visible = isAdmin ? items : items.filter((item) => !ADMIN_ONLY_BREAKDOWN.has(item.label));
  if (visible.length === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {visible.map((item) => (
        <MiniStat key={item.label} label={item.label} value={item.value} />
      ))}
    </div>
  );
}

function ReportPage() {
  const { user, profile, can, isAdmin } = useSession();
  const canManage = isAdmin;
  const [monthKey, setMonthKey] = useState(() => monthKeyOf(new Date()));
  const [employeeId, setEmployeeId] = useState("all");
  const range = useMemo(() => monthRange(monthKey), [monthKey]);
  const entriesQ = useTimeEntries(!!user?.id, range, isAdmin ? undefined : user?.id);
  const additionsQ = useTimeEntryAdditions(!!user?.id, isAdmin ? undefined : user?.id);
  const profilesQ = useProfiles(isAdmin);

  const employees = isAdmin ? (profilesQ.data ?? []) : profile ? [profile] : [];
  const entries = entriesQ.data ?? [];
  const additions = additionsQ.data ?? [];
  const filteredEntries = isAdmin
    ? employeeId === "all"
      ? entries
      : entries.filter((entry) => entry.user_id === employeeId)
    : entries.filter((entry) => entry.user_id === user?.id);
  const report = useMemo(
    () => buildMonthlyReport(filteredEntries, additions, employees, monthKey),
    [filteredEntries, additions, employees, monthKey],
  );

  const manualCount = useMemo(
    () =>
      report.employees.reduce(
        (sum, emp) =>
          sum + emp.entries.filter((entry) => entry.entry_source === "manual" || entry.manually_edited).length,
        0,
      ),
    [report],
  );

  const [year, month] = monthKey.split("-").map(Number);
  const years = Array.from({ length: 4 }, (_, i) => new Date().getFullYear() - 2 + i);

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

  function setMonthPart(part: "year" | "month", value: number) {
    const nextYear = part === "year" ? value : year;
    const nextMonth = part === "month" ? value : month;
    setMonthKey(`${nextYear}-${String(nextMonth).padStart(2, "0")}`);
  }

  function exportCsv() {
    const csv = reportToCsv(report, { includeAdminBreakdown: isAdmin });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `attendance-${monthKey}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="print-report">
      <div className="print-only mb-4 flex items-center gap-3">
        <img src="/brand/logo-print.png" alt="" className="brand-logo-print shrink-0" />
        <div>
          <h1 className="text-xl font-bold text-foreground">{site.name}</h1>
          <p className="text-sm text-muted-foreground">דוח נוכחות חודשי · {monthLabelHe(monthKey)}</p>
          <p className="text-xs text-muted-foreground">הופק ב-{dateShort(new Date())}</p>
        </div>
      </div>

      <div className="print-hidden">
        <PageHeader
          title={isAdmin ? "דוח חודשי" : "הדוח החודשי שלי"}
          description={isAdmin ? "סיכום שעות, תוספות, נסיעות והערות לכל עובד" : "סיכום שעות, תוספות ונסיעות שלך בלבד"}
          actions={
            <>
              <Button type="button" variant="outline" onClick={exportCsv}>
                <Download className="size-4" /> ייצוא CSV
              </Button>
              <Button type="button" variant="outline" onClick={() => window.print()}>
                <Printer className="size-4" /> הדפסה / PDF
              </Button>
            </>
          }
        />

        <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
          <div className="w-32">
            <label htmlFor="report-month" className="mb-1 block text-xs font-medium text-muted-foreground">חודש</label>
            <Select id="report-month" value={month} onChange={(e) => setMonthPart("month", Number(e.target.value))}>
              {MONTHS.map((label, index) => (
                <option key={label} value={index + 1}>{label}</option>
              ))}
            </Select>
          </div>
          <div className="w-28">
            <label htmlFor="report-year" className="mb-1 block text-xs font-medium text-muted-foreground">שנה</label>
            <Select id="report-year" value={year} onChange={(e) => setMonthPart("year", Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </div>
          <div className="min-w-40 flex-1">
            <label htmlFor="report-employee" className="mb-1 block text-xs font-medium text-muted-foreground">עובד</label>
            <Select
              id="report-employee"
              value={canManage ? employeeId : (profile?.id ?? "all")}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={!canManage}
            >
              {canManage ? <option value="all">כל העובדים</option> : null}
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>{employee.full_name}</option>
              ))}
            </Select>
          </div>
          <Button asChild variant="ghost">
            <Link to="/attendance"><ArrowRight className="size-4" /> חזרה לשעון</Link>
          </Button>
        </div>
      </div>

      {report.employees.length === 0 ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={FileText}
            title="אין דיווחים בחודש הזה"
            description="בחר חודש אחר או הוסף דיווחים חדשים כדי לראות סיכום."
            action={<button type="button" className="text-sm font-medium text-primary" onClick={() => setMonthKey(monthKeyOf(new Date()))}>חזרה לחודש הנוכחי</button>}
          />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="שעות סה״כ" value={formatMinutes(report.totals.totalMinutes)} icon={FileText} />
            <StatCard label="תוספות כספיות" value={money(report.totals.additionsAmount)} icon={FileText} tone="amber" />
            <StatCard label="נסיעות" value={money(report.totals.travelAmount)} icon={FileText} tone="blue" />
            <StatCard
              label="עלות משוערת"
              value={report.totals.estimatedCost == null ? "—" : money(report.totals.estimatedCost)}
              icon={FileText}
              tone="green"
            />
          </div>

          {report.employees.map((emp) => (
            <SectionCard
              key={emp.employee.id}
              title={emp.employee.full_name}
              description={`${emp.daysReported} ימים · ${formatMinutes(emp.totalMinutes)} שעות · ${monthLabelHe(monthKey)}`}
            >
              <BreakdownGrid
                isAdmin={isAdmin}
                items={[
                  { label: "ימים", value: String(emp.daysReported) },
                  { label: "סה״כ שעות", value: formatMinutes(emp.totalMinutes) },
                  { label: "שעות רגילות", value: formatMinutes(emp.regularMinutes) },
                  { label: "שעות 125%", value: formatMinutes(emp.overtime125Minutes) },
                  { label: "שעות 150%", value: formatMinutes(emp.overtime150Minutes) },
                  { label: "שעות לילה", value: String(emp.nightHours) },
                  { label: "שעות שבת", value: String(emp.shabbatHours) },
                  { label: "שעות חג", value: String(emp.holidayHours) },
                  { label: "שעות כוננות", value: String(emp.oncallHours) },
                  { label: "ארוחות", value: money(emp.mealAmount) },
                  { label: "נסיעות", value: `${emp.travelKm} ק״מ · ${money(emp.travelAmount)}` },
                  { label: "תוספות", value: `${emp.additionsHours} ש׳ · ${money(emp.additionsAmount)}` },
                  { label: "עלות משוערת", value: emp.estimatedCost == null ? "—" : money(emp.estimatedCost) },
                  { label: "חופשה / מחלה", value: `${emp.vacationDays} / ${emp.sickDays}` },
                  { label: "מילואים / היעדרות", value: `${emp.reserveDays} / ${emp.absenceDays}` },
                  { label: "ימי חג", value: String(emp.holidayDays) },
                ]}
              />

              <div className="mt-4 overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[760px] text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                      <th className="px-3 py-2 text-start font-medium">תאריך</th>
                      <th className="px-3 py-2 text-start font-medium">כניסה–יציאה</th>
                      <th className="px-3 py-2 text-start font-medium">הפסקה</th>
                      <th className="px-3 py-2 text-start font-medium">שעות</th>
                      <th className="px-3 py-2 text-start font-medium">תוספות</th>
                      <th className="px-3 py-2 text-start font-medium">נסיעות</th>
                      <th className="px-3 py-2 text-start font-medium">הערה</th>
                      <th className="px-3 py-2 text-start font-medium">סטטוס</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {emp.entries.map((entry) => {
                      const adds = emp.additionsByEntry[entry.id] ?? [];
                      return (
                        <tr key={entry.id} className="align-top">
                          <td className="px-3 py-2">
                            <p className="text-foreground">{dateShort(entry.work_date)}</p>
                            <p className="text-[10px] text-muted-foreground">{weekdayHe(entry.work_date)}</p>
                          </td>
                          <td className="num px-3 py-2 text-foreground">
                            {entry.start_time?.slice(0, 5) ?? "—"}–{entry.end_time?.slice(0, 5) ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-foreground">{n(entry.break_minutes)} דק׳</td>
                          <td className="num px-3 py-2 font-medium text-foreground">{formatMinutes(entryMinutes(entry))}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {adds.length
                              ? adds.map((a) => `${ADDITION_LABELS[a.add_type]}${n(a.hours) ? ` ${n(a.hours)} ש׳` : ""}${n(a.amount) ? ` ${n(a.amount)} ₪` : ""}`).join(" · ")
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {n(entry.travel_km) ? `${n(entry.travel_km)} ק״מ` : "—"}
                            {n(entry.travel_amount) ? ` · ${money(n(entry.travel_amount))}` : ""}
                          </td>
                          <td className="max-w-[220px] px-3 py-2 text-muted-foreground">
                            {entry.note || "—"}
                            <ManualFlags entry={entry} profiles={employees} />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{ENTRY_STATUS_LABELS[entry.status]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ))}

          <SectionCard
            title={isAdmin ? "סיכום חברה" : "סיכום אישי"}
            description={isAdmin ? `כל העובדים · ${monthLabelHe(monthKey)}` : `הנתונים שלך · ${monthLabelHe(monthKey)}`}
          >
            {manualCount > 0 ? (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
                {attendanceContent.manualSummary(manualCount)}
              </p>
            ) : null}
            <BreakdownGrid
              isAdmin={isAdmin}
              items={[
                { label: "סה״כ ימים", value: String(report.totals.daysReported) },
                { label: "סה״כ שעות", value: formatMinutes(report.totals.totalMinutes) },
                { label: "שעות רגילות", value: formatMinutes(report.totals.regularMinutes) },
                { label: "שעות 125%", value: formatMinutes(report.totals.overtime125Minutes) },
                { label: "שעות 150%", value: formatMinutes(report.totals.overtime150Minutes) },
                { label: "שעות לילה", value: String(report.totals.nightHours) },
                { label: "שעות שבת", value: String(report.totals.shabbatHours) },
                { label: "שעות חג", value: String(report.totals.holidayHours) },
                { label: "שעות כוננות", value: String(report.totals.oncallHours) },
                { label: "ארוחות", value: money(report.totals.mealAmount) },
                { label: "נסיעות", value: `${report.totals.travelKm} ק״מ · ${money(report.totals.travelAmount)}` },
                { label: "תוספות", value: `${report.totals.additionsHours} ש׳ · ${money(report.totals.additionsAmount)}` },
                { label: "עלות משוערת", value: report.totals.estimatedCost == null ? "—" : money(report.totals.estimatedCost) },
                { label: "חופשה / מחלה", value: `${report.totals.vacationDays} / ${report.totals.sickDays}` },
                { label: "מילואים / היעדרות", value: `${report.totals.reserveDays} / ${report.totals.absenceDays}` },
                { label: "ימי חג", value: String(report.totals.holidayDays) },
              ]}
            />
          </SectionCard>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="num text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}
