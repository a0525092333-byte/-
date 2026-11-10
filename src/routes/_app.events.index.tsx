import { EVENT_DELETE_OWNER_ONLY_MESSAGE } from "@/lib/permissions";
import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CalendarDays, LayoutGrid, List, MapPin, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useEventsWithBudget, useProfiles } from "@/hooks/use-data";
import { dataApiToken } from "@/integrations/neon/client";
import { dateShort, money, num, timeShort } from "@/lib/format";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/overlay";
import { EventForm, EVENT_STATUSES } from "@/components/event-form";
import { formatStatusLabel } from "@/lib/status-labels";
import { QuoteImportButton } from "@/components/quotes/quote-import-window";
import { cn } from "@/lib/utils";
import { isFullScope } from "@/lib/scope";
import { notifyDataChanged } from "@/lib/data-events";
import type { EventRow, EventWithBudget } from "@/lib/types";

export const Route = createFileRoute("/_app/events/")({ component: EventsPage });

type EventLike = { client_id: string | null; venue: string | null; start_time: string | null; sales_rep_id: string | null };

function isIncomplete(ev: EventLike) {
  return !ev.client_id || !ev.venue || !ev.sales_rep_id;
}

/** Final quote total (incl. VAT) for an event; latest quote wins if several. */
function eventBudget(event: EventWithBudget): number {
  const quotes = event.quotes ?? [];
  if (!quotes.length) return 0;
  const latest = [...quotes].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  )[0];
  return Number(latest?.grand_total ?? 0) || 0;
}

function EventsPage() {
  const { user, profile, can, isAdmin, isSuperAdmin } = useSession();
  const fullScope = isFullScope(profile, isAdmin);
  const navigate = useNavigate();
  const eventsQ = useEventsWithBudget(can("clients") || can("calendar"));
  const clientsQ = useClients(can("clients") || can("calendar") || can("finance") || can("crew"));
  const profilesQ = useProfiles(can("finance") || can("clients"));

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [rep, setRep] = useState("all");
  const [month, setMonth] = useState("");
  const [sort, setSort] = useState<"asc" | "desc">("asc");
  const [view, setView] = useState<"table" | "cards">("table");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EventRow | null>(null);
  const [deleting, setDeleting] = useState<EventRow | null>(null);
  const [busy, setBusy] = useState(false);

  const clients = clientsQ.data ?? [];
  const profiles = profilesQ.data ?? [];
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (eventsQ.data ?? []).filter((e) => {
      if (status !== "all" && e.status !== status) return false;
      if (rep !== "all" && e.sales_rep_id !== rep) return false;
      if (month && !e.event_date.startsWith(month)) return false;
      if (q) {
        const client = e.client_id ? clientById.get(e.client_id)?.name ?? "" : "";
        const hay = `${e.title} ${e.venue ?? ""} ${e.address ?? ""} ${client} ${e.sales_rep_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return list.sort((a, b) => (sort === "asc" ? a.event_date.localeCompare(b.event_date) : b.event_date.localeCompare(a.event_date)));
  }, [eventsQ.data, status, rep, month, search, sort, clientById]);

  if (eventsQ.isLoading || clientsQ.isLoading) return <PageSkeleton />;
  if (eventsQ.error || clientsQ.error) {
    return (
      <ErrorState
        message={((eventsQ.error || clientsQ.error) as Error).message}
        onRetry={() => {
          eventsQ.refetch();
          clientsQ.refetch();
        }}
      />
    );
  }

  const canEdit = fullScope && can("clients", "edit");
  // Only the account owner may delete events — regardless of role or permissions matrix.
  const canDelete = isSuperAdmin === true;

  async function remove() {
    if (!deleting) return;
    if (!canDelete) {
      toast.error(EVENT_DELETE_OWNER_ONLY_MESSAGE);
      setDeleting(null);
      return;
    }
    setBusy(true);
    try {
      const token = await dataApiToken();
      const res = await fetch(`/api/events/${deleting.id}/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast.error(data?.message || "לא הצלחנו למחוק את האירוע");
        return;
      }
      toast.success("האירוע נמחק");
      notifyDataChanged("events");
      setDeleting(null);
      eventsQ.refetch();
    } catch {
      toast.error("לא הצלחנו להתחבר לשרת — נסה שוב.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="אירועים"
        description={`${num(filtered.length)} אירועים בתצוגה`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <QuoteImportButton />
            {canEdit ? (
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4" />
                אירוע חדש
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם אירוע, לקוח, מקום או איש מכירות"
            className="h-11 pe-9"
            aria-label="חיפוש אירועים"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select aria-label="סינון לפי סטטוס" value={status} onChange={(e) => setStatus(e.target.value)} className="h-11 text-xs">
            <option value="all">כל הסטטוסים</option>
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </Select>
          {can("finance") || can("clients") ? (
            <Select aria-label="סינון לפי איש מכירות" value={rep} onChange={(e) => setRep(e.target.value)} className="h-11 text-xs">
              <option value="all">כל אנשי המכירות</option>
              {profiles
                .filter((p) => p.role === "sales" || p.role === "admin")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
            </Select>
          ) : (
            <div className="hidden sm:block" />
          )}
          <Input aria-label="סינון לפי חודש" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-11 text-xs" />
          <Select aria-label="מיון" value={sort} onChange={(e) => setSort(e.target.value as "asc" | "desc")} className="h-11 text-xs">
            <option value="asc">תאריך — מהקרוב לרחוק</option>
            <option value="desc">תאריך — מהרחוק לקרוב</option>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {month ? `מסונן לחודש ${month}` : "כל החודשים"}
            {status !== "all" ? ` · ${formatStatusLabel(status)}` : ""}
          </p>
          <div className="hidden rounded-lg border border-border p-0.5 md:flex" role="tablist" aria-label="תצוגת אירועים">
            <button
              type="button"
              role="tab"
              aria-selected={view === "table"}
              onClick={() => setView("table")}
              className={cn("flex min-h-11 items-center gap-1 rounded-md px-2.5 text-xs", view === "table" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
            >
              <List className="size-3.5" /> טבלה
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "cards"}
              onClick={() => setView("cards")}
              className={cn("flex min-h-11 items-center gap-1 rounded-md px-2.5 text-xs", view === "cards" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
            >
              <LayoutGrid className="size-3.5" /> כרטיסים
            </button>
          </div>
        </div>
      </div>

      {!filtered.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={CalendarDays}
            title="לא נמצאו אירועים"
            description={search || status !== "all" || month ? "נסה לשנות את הסינון או לחפש מונח אחר." : "עדיין לא נוצרו אירועים. אפשר להתחיל באירוע הראשון."}
            action={
              canEdit ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  <Plus className="size-4" />
                  אירוע חדש
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className={cn("overflow-hidden rounded-xl border border-border bg-card", view === "table" ? "hidden md:block" : "hidden")}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 text-start font-medium">אירוע</th>
                    <th className="px-4 py-2.5 text-start font-medium">לקוח</th>
                    <th className="px-4 py-2.5 text-start font-medium">תאריך</th>
                    <th className="px-4 py-2.5 text-start font-medium">סטטוס</th>
                    <th className="px-4 py-2.5 text-start font-medium">איש מכירות</th>
                    {fullScope ? <th className="px-4 py-2.5 text-start font-medium">תקציב</th> : null}
                    <th className="px-4 py-2.5 text-start font-medium">פעולות</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {filtered.map((e) => (
                    <tr
                      key={e.id}
                      className="cursor-pointer transition-colors hover:bg-muted/40"
                      onClick={() => navigate({ to: "/events/$id", params: { id: e.id } })}
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{e.title}</p>
                        <p className="text-xs text-muted-foreground">{e.event_type}{e.venue ? ` · ${e.venue}` : ""}</p>
                        {isIncomplete(e) ? (
                          <span className="mt-1 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">חסרים פרטים</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{e.client_id ? clients.find((c) => c.id === e.client_id)?.name ?? "—" : "—"}</td>
                      <td className="num whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {dateShort(e.event_date)}
                        {e.start_time ? <span className="block text-xs">{timeShort(e.start_time)}</span> : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusPill status={e.status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{e.sales_rep_name || "—"}</td>
                      {fullScope ? <td className="num whitespace-nowrap px-4 py-3 font-medium text-foreground">{eventBudget(e) > 0 ? money(eventBudget(e)) : "—"}</td> : null}
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="עריכת אירוע"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              if (!canEdit) return;
                              setEditing(e);
                              setFormOpen(true);
                            }}
                            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                            disabled={!canEdit}
                          >
                            <Pencil className="size-4" />
                          </button>
                          {canDelete ? (
                            <button
                              type="button"
                              aria-label="מחיקת אירוע"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setDeleting(e);
                              }}
                              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cards — mobile always, desktop when cards view */}
          <div className={cn("grid gap-3 sm:grid-cols-2", view === "table" ? "md:hidden" : "")}>
            {filtered.map((e) => (
              <div key={e.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to="/events/$id" params={{ id: e.id }} className="block truncate text-sm font-semibold text-foreground hover:text-primary">
                      {e.title}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {e.client_id ? clients.find((c) => c.id === e.client_id)?.name ?? "—" : "—"} · {e.event_type}
                    </p>
                    {isIncomplete(e) ? (
                      <span className="mt-1 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">חסרים פרטים</span>
                    ) : null}
                  </div>
                  <StatusPill status={e.status} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="size-3.5" />
                    {dateShort(e.event_date)}
                    {e.start_time ? ` · ${timeShort(e.start_time)}` : ""}
                  </span>
                  <span className="inline-flex items-center gap-1 truncate">
                    <MapPin className="size-3.5" />
                    {e.venue || "—"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3.5" />
                    {e.guest_count ? `${num(e.guest_count)} משתתפים` : "—"}
                  </span>
                  {fullScope ? <span className="num font-medium text-foreground">{eventBudget(e) > 0 ? money(eventBudget(e)) : "—"}</span> : null}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3">
                  <span className="truncate text-xs text-muted-foreground">{e.sales_rep_name || "ללא איש מכירות"}</span>
                  <div className="flex items-center gap-1">
                    <Button asChild size="sm" variant="ghost">
                      <Link to="/events/$id" params={{ id: e.id }}>
                        פתיחה
                      </Link>
                    </Button>
                    {canEdit ? (
                      <button
                        type="button"
                        aria-label="עריכת אירוע"
                        onClick={() => {
                          setEditing(e);
                          setFormOpen(true);
                        }}
                        className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                    ) : null}
                    {canDelete ? (
                      <button
                        type="button"
                        aria-label="מחיקת אירוע"
                        onClick={() => setDeleting(e)}
                        className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <EventForm
        open={formOpen}
        onOpenChange={setFormOpen}
        event={editing}
        clients={clients}
        profiles={profiles}
        currentProfile={profile}
        isAdmin={isAdmin}
        onSaved={() => eventsQ.refetch()}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="מחיקת אירוע"
        description={`האם למחוק את "${deleting?.title ?? ""}"? הפעולה תמחק לצמיתות את האירוע, ימי האירוע, המשמרות והציוד שלו. הצעות מחיר, דיווחי שעות ותנועות כספיות יישמרו ויוסרו מהאירוע.`}
        onConfirm={remove}
        busy={busy}
      />
    </div>
  );
}
