import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleDollarSign, Download, Plus, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useEvents, useFinance } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { dateShort, money, num, sameDisplayName, todayISO } from "@/lib/format";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton, SectionCard, StatCard, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import type { EventRow, FinanceEntry } from "@/lib/types";

export const Route = createFileRoute("/_app/finance")({ component: FinancePage });

type Row = {
  event: EventRow;
  clientName: string;
  invoiced: number;
  received: number;
  expenses: number;
  expected: number;
  due: number;
  status: "שולם" | "חלקי" | "לא שולם";
};

function FinancePage() {
  const { user, can } = useSession();
  const eventsQ = useEvents(can("finance") || can("clients"));
  const financeQ = useFinance(can("finance"));
  const clientsQ = useClients(can("finance") || can("clients"));
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("all");
  const [entryOpen, setEntryOpen] = useState(false);

  const events = eventsQ.data ?? [];
  const finance = financeQ.data ?? [];
  const clients = clientsQ.data ?? [];

  const rows = useMemo<Row[]>(() => {
    const clientById = new Map(clients.map((c) => [c.id, c.name]));
    return events
      .map((event) => {
        const entries = finance.filter((f) => f.event_id === event.id);
        const invoiced = entries.filter((f) => f.kind === "חשבונית").reduce((s, f) => s + Number(f.amount ?? 0), 0);
        const received = entries.filter((f) => f.kind === "תשלום" && f.status === "שולם").reduce((s, f) => s + Number(f.amount ?? 0), 0);
        const expenses = entries.filter((f) => f.kind === "הוצאה").reduce((s, f) => s + Number(f.amount ?? 0), 0);
        const expected = Number(event.total_amount ?? 0);
        const due = Math.max(0, (invoiced || expected) - received);
        const status: Row["status"] = due <= 0 ? "שולם" : received > 0 ? "חלקי" : "לא שולם";
        return {
          event,
          clientName: event.client_id ? clientById.get(event.client_id) ?? "—" : "—",
          invoiced,
          received,
          expenses,
          expected,
          due,
          status,
        };
      })
      .sort((a, b) => a.event.event_date.localeCompare(b.event.event_date));
  }, [events, finance, clients]);

  const filtered = rows.filter((r) => {
    if (month && !r.event.event_date.startsWith(month)) return false;
    if (status !== "all" && r.status !== status) return false;
    return true;
  });

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, r) => {
        acc.expected += r.expected;
        acc.invoiced += r.invoiced;
        acc.received += r.received;
        acc.expenses += r.expenses;
        acc.due += r.due;
        return acc;
      },
      { expected: 0, invoiced: 0, received: 0, expenses: 0, due: 0 },
    );
  }, [filtered]);

  if (!can("finance")) return <NoAccess moduleLabel="מודול הכספים" />;
  if (eventsQ.isLoading || financeQ.isLoading) return <PageSkeleton />;
  if (eventsQ.error || financeQ.error) {
    return (
      <ErrorState
        message={((eventsQ.error || financeQ.error) as Error).message}
        onRetry={() => {
          eventsQ.refetch();
          financeQ.refetch();
        }}
      />
    );
  }

  const canEdit = can("finance", "edit");

  function exportCsv() {
    const header = ["אירוע", "לקוח", "תאריך", "הכנסות צפויות", "חשבוניות", "נגבה", "הוצאות", "יתרה", "סטטוס"];
    const lines = filtered.map((r) => [
      r.event.title,
      r.clientName,
      dateShort(r.event.event_date),
      r.expected,
      r.invoiced,
      r.received,
      r.expenses,
      r.due,
      r.status,
    ]);
    const csv = [header, ...lines]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `כספים-${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("הקובץ הורד");
  }

  return (
    <div>
      <PageHeader
        title="כספים"
        description="תיעוד הכנסות, הוצאות ויתרות לפי אירוע — המערכת אינה מפיקה חשבוניות או קבלות"
        actions={
          <>
            <Button type="button" size="sm" variant="outline" onClick={exportCsv}>
              <Download className="size-4" />
              ייצוא CSV
            </Button>
            {canEdit ? (
              <Button type="button" size="sm" onClick={() => setEntryOpen(true)}>
                <Plus className="size-4" />
                תנועה חדשה
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="הכנסות צפויות" value={money(totals.expected)} icon={Wallet} tone="default" hint="לפי תקציב האירועים" />
        <StatCard label="נגבה" value={money(totals.received)} icon={CircleDollarSign} tone="green" hint="תשלומים שהתקבלו" />
        <StatCard label="יתרה פתוחה" value={money(totals.due)} icon={CircleDollarSign} tone={totals.due > 0 ? "amber" : "green"} hint="לפי הרשומות שתועדו" />
        <StatCard label="הוצאות" value={money(totals.expenses)} icon={Wallet} tone="red" hint="הוצאות שנרשמו" />
      </div>

      <div className="mb-4 flex flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center">
        <Input aria-label="סינון לפי חודש" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-11 sm:max-w-48" />
        <Select aria-label="סינון לפי סטטוס" value={status} onChange={(e) => setStatus(e.target.value)} className="h-11 sm:max-w-48">
          <option value="all">כל הסטטוסים</option>
          <option value="שולם">שולם</option>
          <option value="חלקי">חלקי</option>
          <option value="לא שולם">לא שולם</option>
        </Select>
        <p className="text-xs text-muted-foreground sm:ms-auto">{num(filtered.length)} אירועים בתצוגה</p>
      </div>

      {!filtered.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={Wallet}
            title="אין נתונים כספיים בתצוגה"
            description="נסה לשנות את הסינון, או הוסף תנועה כספית לאירוע."
            action={
              canEdit ? (
                <Button type="button" size="sm" onClick={() => setEntryOpen(true)}>
                  <Plus className="size-4" />
                  תנועה חדשה
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 text-start font-medium">אירוע</th>
                    <th className="px-4 py-2.5 text-start font-medium">לקוח</th>
                    <th className="px-4 py-2.5 text-start font-medium">תאריך</th>
                    <th className="px-4 py-2.5 text-start font-medium">צפוי</th>
                    <th className="px-4 py-2.5 text-start font-medium">חשבוניות</th>
                    <th className="px-4 py-2.5 text-start font-medium">נגבה</th>
                    <th className="px-4 py-2.5 text-start font-medium">הוצאות</th>
                    <th className="px-4 py-2.5 text-start font-medium">יתרה</th>
                    <th className="px-4 py-2.5 text-start font-medium">סטטוס</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {filtered.map((r) => (
                    <tr key={r.event.id} className="transition-colors hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <Link to="/events/$id" params={{ id: r.event.id }} className="font-medium text-foreground hover:text-primary">
                          {r.event.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{r.clientName}</td>
                      <td className="num px-4 py-3 text-muted-foreground">{dateShort(r.event.event_date)}</td>
                      <td className="num px-4 py-3 text-foreground">{money(r.expected)}</td>
                      <td className="num px-4 py-3 text-muted-foreground">{money(r.invoiced)}</td>
                      <td className="num px-4 py-3 font-medium text-emerald-700">{money(r.received)}</td>
                      <td className="num px-4 py-3 text-muted-foreground">{money(r.expenses)}</td>
                      <td className={`num px-4 py-3 font-semibold ${r.due > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(r.due)}</td>
                      <td className="px-4 py-2.5"><StatusPill status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/30 text-sm font-semibold">
                    <td className="px-4 py-3" colSpan={3}>סה״כ</td>
                    <td className="num px-4 py-3">{money(totals.expected)}</td>
                    <td className="num px-4 py-3">{money(totals.invoiced)}</td>
                    <td className="num px-4 py-3 text-emerald-700">{money(totals.received)}</td>
                    <td className="num px-4 py-3">{money(totals.expenses)}</td>
                    <td className="num px-4 py-3 text-amber-700">{money(totals.due)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="grid gap-3 md:hidden">
            {filtered.map((r) => (
              <div key={r.event.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link to="/events/$id" params={{ id: r.event.id }} className="min-w-0 text-sm font-semibold text-foreground">
                    {r.event.title}
                  </Link>
                  <StatusPill status={r.status} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{!sameDisplayName(r.event.title, r.clientName) ? `${r.clientName} · ` : ""}{dateShort(r.event.event_date)}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-muted/50 p-2">
                    <p className="text-muted-foreground">צפוי</p>
                    <p className="num font-semibold text-foreground">{money(r.expected)}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2">
                    <p className="text-muted-foreground">נגבה</p>
                    <p className="num font-semibold text-emerald-700">{money(r.received)}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2">
                    <p className="text-muted-foreground">הוצאות</p>
                    <p className="num font-semibold text-foreground">{money(r.expenses)}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2">
                    <p className="text-muted-foreground">יתרה</p>
                    <p className={`num font-semibold ${r.due > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(r.due)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionCard title="תנועות אחרונות" description="התשלומים והחשבוניות האחרונים" className="mt-5" bodyClassName="p-0">
        {!finance.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">אין תנועות כספיות עדיין.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {finance.slice(0, 8).map((f) => {
              const ev = events.find((e) => e.id === f.event_id);
              return (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{f.kind} · {ev?.title ?? "אירוע"}</p>
                    <p className="text-xs text-muted-foreground">{f.doc_number || "ללא אסמכתא"} · {dateShort(f.issued_at ?? f.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="num text-sm font-semibold text-foreground">{money(f.amount)}</span>
                    <StatusPill status={f.status} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <FinanceEntryDialog
        open={entryOpen}
        onOpenChange={setEntryOpen}
        events={events}
        userId={user?.id}
        onSaved={() => financeQ.refetch()}
      />
    </div>
  );
}

function FinanceEntryDialog({
  open,
  onOpenChange,
  events,
  userId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  events: EventRow[];
  userId?: string;
  onSaved: () => void;
}) {
  const [eventId, setEventId] = useState("");
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
    if (!eventId) {
      setError("נא לבחור אירוע.");
      return;
    }
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
          <Button type="submit" form="finance-page-form" disabled={busy}>{busy ? "שומר…" : "שמירה"}</Button>
        </div>
      }
    >
      <form id="finance-page-form" onSubmit={save} className="space-y-4">
        <Field label="אירוע" htmlFor="fp-event">
          <Select id="fp-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">בחירת אירוע</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.title} · {dateShort(ev.event_date)}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="סוג תנועה" htmlFor="fp-kind">
            <Select id="fp-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {["הצעת מחיר", "חוזה", "חשבונית", "תשלום", "הוצאה"].map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </Select>
          </Field>
          <Field label="סטטוס" htmlFor="fp-status">
            <Select id="fp-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {["ממתין", "שולם", "באיחור"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="סכום (₪)" htmlFor="fp-amount">
            <Input id="fp-amount" type="number" min={1} step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-11" />
          </Field>
          <Field label="מספר אסמכתא" htmlFor="fp-doc">
            <Input id="fp-doc" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="2026-1042" className="h-11" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="תאריך הנפקה" htmlFor="fp-issued">
            <Input id="fp-issued" type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className="h-11" />
          </Field>
          <Field label="תאריך פירעון" htmlFor="fp-due">
            <Input id="fp-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="fp-notes">
          <Textarea id="fp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="פרטי חשבונית, תנאי תשלום" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}
