import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Building2, Hash, Mail, MapPin, Pencil, Phone, Plus, Search, Trash2, Upload, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useClients, useEvents, useFinance } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { dateShort, money, num } from "@/lib/format";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton, SectionCard, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clientPickerCopy } from "@/content/client-picker";
import { Field, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/overlay";
import { ClientImportDialog } from "@/components/clients/client-import-dialog";
import { ClientForm } from "@/components/clients/client-form";
import { ClientContactsList } from "@/components/clients/client-contacts-list";
import { normalizeClientName } from "@/lib/clients";
import { MergeDuplicatesDialog } from "@/components/clients/merge-duplicates-dialog";
import type { Client } from "@/lib/types";

export const Route = createFileRoute("/_app/clients")({ component: ClientsPage });

function ClientsPage() {
  const { can, isAdmin } = useSession();
  const clientsQ = useClients(can("clients") || can("calendar") || can("finance") || can("crew"));
  const eventsQ = useEvents(can("clients") || can("calendar") || can("finance"));
  const financeQ = useFinance(can("finance"));
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [selected, setSelected] = useState<Client | null>(null);
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  const [editPickerSearch, setEditPickerSearch] = useState("");
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);

  const clients = clientsQ.data ?? [];
  const events = eventsQ.data ?? [];
  const finance = financeQ.data ?? [];

  const enriched = useMemo(() => {
    return clients.map((c) => {
      const clientEvents = events.filter((e) => e.client_id === c.id);
      const eventIds = new Set(clientEvents.map((e) => e.id));
      const received = finance
        .filter((f) => eventIds.has(f.event_id) && f.kind === "תשלום" && f.status === "שולם")
        .reduce((s, f) => s + Number(f.amount ?? 0), 0);
      const total = clientEvents.reduce((s, e) => s + Number(e.total_amount ?? 0), 0);
      return { client: c, events: clientEvents, received, total, balance: Math.max(0, (clientEvents.reduce((s, e) => s + Number(e.total_amount ?? 0), 0)) - received) };
    });
  }, [clients, events, finance]);

  const filtered = enriched.filter(({ client }) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${client.name} ${client.contact_name ?? ""} ${client.phone ?? ""} ${client.email ?? ""} ${client.tax_id ?? ""}`.toLowerCase().includes(q);
  });

  if (!can("clients")) return <NoAccess moduleLabel="מודול הלקוחות" />;
  if (clientsQ.isLoading || eventsQ.isLoading) return <PageSkeleton />;
  if (clientsQ.error || eventsQ.error) {
    return (
      <ErrorState
        message={((clientsQ.error || eventsQ.error) as Error).message}
        onRetry={() => {
          clientsQ.refetch();
          eventsQ.refetch();
        }}
      />
    );
  }

  const canEdit = can("clients", "edit");
  const selectedData = selected ? enriched.find((e) => e.client.id === selected.id) ?? null : null;

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    const { error } = await db.from("clients").delete().eq("id", deleting.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את הלקוח. ייתכן שיש אירועים משויכים.");
      return;
    }
    toast.success("הלקוח נמחק");
    setDeleting(null);
    clientsQ.refetch();
  }

  return (
    <div>
      <PageHeader
        title="לקוחות"
        description={`${num(clients.length)} לקוחות במערכת`}
        actions={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="size-4" />
                ייבוא לקוחות מקובץ
              </Button>
              {canEdit ? (
                <Button size="sm" variant="outline" onClick={() => setMergeOpen(true)}>
                  <Users className="size-4" />
                  איחוד כפילויות
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (selected) {
                    setEditing(selected);
                    setFormOpen(true);
                  } else {
                    setEditPickerSearch("");
                    setEditPickerOpen(true);
                  }
                }}
              >
                <Pencil className="size-4" />
                עריכת לקוח
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4" />
                לקוח חדש
              </Button>
            </div>
          ) : null
        }
      />

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          inputMode="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש לפי שם, איש קשר, טלפון או אימייל"
          className="h-11 pe-9"
          aria-label="חיפוש לקוחות"
        />
      </div>

      {!filtered.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={Users}
            title={search ? "לא נמצאו לקוחות" : "עדיין אין לקוחות"}
            description={search ? "נסה מונח חיפוש אחר." : "הוספת לקוח ראשון תאפשר לפתוח אירועים ולעקוב אחרי הכנסות."}
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
                  לקוח חדש
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(({ client, events: clientEvents, total, received, balance }) => (
            <div key={client.id} className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <button type="button" onClick={() => setSelected(client)} className="min-w-0 text-start">
                  <p className="truncate text-sm font-semibold text-foreground hover:text-primary">{client.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{client.contact_name || "ללא איש קשר"}</p>
                </button>
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Building2 className="size-4" />
                </div>
              </div>
              <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                {client.phone ? (
                  <a href={`tel:${client.phone}`} className="flex items-center gap-1.5 hover:text-foreground">
                    <Phone className="size-3.5" />
                    <span dir="ltr">{client.phone}</span>
                  </a>
                ) : null}
                {client.email ? (
                  <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 truncate hover:text-foreground">
                    <Mail className="size-3.5" />
                    <span dir="ltr" className="truncate">{client.email}</span>
                  </a>
                ) : null}
                {client.tax_id ? (
                  <p className="flex items-center gap-1.5">
                    <Hash className="size-3.5" />
                    <span>ח.פ / ת.ז: <span dir="ltr">{client.tax_id}</span></span>
                  </p>
                ) : null}
              </div>
              <div className={`mt-3 grid ${can("finance") ? "grid-cols-3" : "grid-cols-2"} gap-2 border-t border-border/60 pt-3 text-center`}>
                <div>
                  <p className="num text-sm font-bold text-foreground">{num(clientEvents.length)}</p>
                  <p className="text-[10px] text-muted-foreground">אירועים</p>
                </div>
                <div>
                  <p className="num text-sm font-bold text-foreground">{money(total)}</p>
                  <p className="text-[10px] text-muted-foreground">סה״כ</p>
                </div>
                {can("finance") ? (
                  <div>
                    <p className={`num text-sm font-bold ${balance > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(balance)}</p>
                    <p className="text-[10px] text-muted-foreground">יתרה</p>
                  </div>
                ) : null}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(client)}>
                  כרטיס לקוח
                </Button>
                {canEdit ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="עריכת לקוח"
                      onClick={() => {
                        setEditing(client);
                        setFormOpen(true);
                      }}
                      className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="מחיקת לקוח"
                      onClick={() => setDeleting(client)}
                      className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <ClientForm
        open={formOpen}
        onOpenChange={setFormOpen}
        client={editing}
        onSaved={() => clientsQ.refetch()}
      />

      <Dialog
        open={editPickerOpen}
        onOpenChange={setEditPickerOpen}
        title="בחר לקוח לעריכה"
        description="חיפוש ובחירת לקוח"
        size="sm"
      >
        <Input
          type="search"
          inputMode="text"
          aria-label={clientPickerCopy.editLabel}
          value={editPickerSearch}
          onChange={(event) => setEditPickerSearch(event.target.value)}
          placeholder="חיפוש לקוח"
          className="mb-2 h-11"
        />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {clients
            .filter((client) => normalizeClientName(client.name).includes(normalizeClientName(editPickerSearch)))
            .slice(0, 50)
            .map((client) => (
              <button
                key={client.id}
                type="button"
                onClick={() => {
                  setEditing(client);
                  setEditPickerOpen(false);
                  setFormOpen(true);
                }}
                className="block w-full rounded-lg border border-border px-3 py-2 text-start text-sm hover:bg-muted"
              >
                {client.name}
              </button>
            ))}
        </div>
      </Dialog>

      {canEdit ? (
        <ClientImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          existingClients={clients}
          onImported={() => clientsQ.refetch()}
        />
      ) : null}

      {canEdit ? (
        <MergeDuplicatesDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          onMerged={() => clientsQ.refetch()}
        />
      ) : null}

      <Sheet
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.name ?? ""}
        description={selected?.contact_name || "כרטיס לקוח"}
      >
        {selectedData ? (
          <div className="space-y-5">
            <div className="space-y-2 text-sm">
              {selectedData.client.phone ? (
                <a href={`tel:${selectedData.client.phone}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                  <Phone className="size-4" />
                  <span dir="ltr">{selectedData.client.phone}</span>
                </a>
              ) : null}
              {selectedData.client.email ? (
                <a href={`mailto:${selectedData.client.email}`} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                  <Mail className="size-4" />
                  <span dir="ltr">{selectedData.client.email}</span>
                </a>
              ) : null}
              {selectedData.client.company ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Building2 className="size-4" />
                  {selectedData.client.company}
                </p>
              ) : null}
              {selectedData.client.address ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="size-4" />
                  {selectedData.client.address}
                </p>
              ) : null}
              {selectedData.client.tax_id ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Hash className="size-4" />
                  <span>ח.פ / ת.ז: <span dir="ltr">{selectedData.client.tax_id}</span></span>
                </p>
              ) : null}
              {selectedData.client.notes ? <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">{selectedData.client.notes}</p> : null}
              <ClientContactsList client={selectedData.client} className="space-y-2" />
            </div>

            <div className={`grid ${can("finance") ? "grid-cols-3" : "grid-cols-2"} gap-2 rounded-xl border border-border p-3 text-center`}>
              <div>
                <p className="num text-lg font-bold text-foreground">{num(selectedData.events.length)}</p>
                <p className="text-[11px] text-muted-foreground">אירועים</p>
              </div>
              <div>
                <p className="num text-lg font-bold text-foreground">{money(selectedData.total)}</p>
                <p className="text-[11px] text-muted-foreground">סה״כ אירועים</p>
              </div>
              {can("finance") ? (
                <div>
                  <p className={`num text-lg font-bold ${selectedData.balance > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(selectedData.balance)}</p>
                  <p className="text-[11px] text-muted-foreground">יתרה</p>
                </div>
              ) : null}
            </div>

            <SectionCard title="היסטוריית אירועים" bodyClassName="p-0">
              {!selectedData.events.length ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">אין אירועים ללקוח הזה.</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {selectedData.events.map((e) => (
                    <li key={e.id}>
                      <Link
                        to="/events/$id"
                        params={{ id: e.id }}
                        onClick={() => setSelected(null)}
                        className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{e.title}</p>
                          <p className="text-xs text-muted-foreground">{dateShort(e.event_date)} · {money(e.total_amount)}</p>
                        </div>
                        <StatusPill status={e.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="מחיקת לקוח"
        description={`האם למחוק את "${deleting?.name ?? ""}"? לא ניתן למחוק לקוח עם אירועים משויכים.`}
        onConfirm={remove}
        busy={busy}
      />
    </div>
  );
}
