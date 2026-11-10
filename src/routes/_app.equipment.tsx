import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Boxes, PackageCheck, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useAssignments, useEquipment, useEvents } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { dateShort, isPastDate, money, num, todayISO } from "@/lib/format";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton, SectionCard, StatusPill } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { isFullScope } from "@/lib/scope";
import type { EquipmentAssignment, EquipmentItem } from "@/lib/types";

export const Route = createFileRoute("/_app/equipment")({ component: EquipmentPage });

const CATEGORIES = ["הגברה", "תאורה", "במה", "ריהוט", "אחר"];
const ITEM_STATUSES = ["במחסן", "בשטח", "בתיקון"];

function EquipmentPage() {
  const { can, profile, isAdmin } = useSession();
  const equipmentQ = useEquipment(can("equipment"));
  const assignmentsQ = useAssignments(can("equipment"));
  const eventsQ = useEvents(can("equipment") || can("clients"));
  const [tab, setTab] = useState<"catalog" | "out">("catalog");
  const [itemForm, setItemForm] = useState(false);
  const [editing, setEditing] = useState<EquipmentItem | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [deleting, setDeleting] = useState<EquipmentItem | null>(null);
  const [busy, setBusy] = useState(false);

  const equipment = equipmentQ.data ?? [];
  const assignments = assignmentsQ.data ?? [];
  const events = eventsQ.data ?? [];

  const outGroups = useMemo(() => {
    const open = assignments.filter((a) => !a.returned_at);
    const map = new Map<string, EquipmentAssignment[]>();
    for (const a of open) {
      const arr = map.get(a.event_id) ?? [];
      arr.push(a);
      map.set(a.event_id, arr);
    }
    return Array.from(map.entries())
      .map(([eventId, items]) => {
        const event = events.find((e) => e.id === eventId);
        return { eventId, event, items };
      })
      .sort((a, b) => (a.event?.event_date ?? "").localeCompare(b.event?.event_date ?? ""));
  }, [assignments, events]);

  if (!can("equipment")) return <NoAccess moduleLabel="מודול הציוד והמחסן" />;
  if (equipmentQ.isLoading || assignmentsQ.isLoading || eventsQ.isLoading) return <PageSkeleton />;
  if (equipmentQ.error || assignmentsQ.error || eventsQ.error) {
    return (
      <ErrorState
        message={((equipmentQ.error || assignmentsQ.error || eventsQ.error) as Error).message}
        onRetry={() => {
          equipmentQ.refetch();
          assignmentsQ.refetch();
          eventsQ.refetch();
        }}
      />
    );
  }

  const fullScope = isFullScope(profile, isAdmin);
  const canEdit = fullScope && can("equipment", "edit");
  const totalUnits = equipment.reduce((s, e) => s + Number(e.quantity_total ?? 0), 0);
  const outUnits = equipment.reduce((s, e) => s + Number(e.quantity_out ?? 0), 0);
  const lowStock = equipment.filter((e) => Number(e.quantity_total ?? 0) - Number(e.quantity_out ?? 0) <= Number(e.min_quantity ?? 0));

  async function removeItem() {
    if (!deleting) return;
    setBusy(true);
    const { error } = await db.from("equipment_items").delete().eq("id", deleting.id);
    setBusy(false);
    if (error) {
      toast.error("לא הצלחנו למחוק את הפריט. ייתכן שיש שיבוצים משויכים.");
      return;
    }
    toast.success("הפריט נמחק");
    setDeleting(null);
    equipmentQ.refetch();
  }

  async function returnItem(a: EquipmentAssignment) {
    const { error } = await db.from("equipment_assignments").update({ returned_at: new Date().toISOString() }).eq("id", a.id);
    if (error) {
      toast.error("לא הצלחנו לרשום החזרה");
      return;
    }
    toast.success("הציוד הוחזר למחסן");
    assignmentsQ.refetch();
    equipmentQ.refetch();
  }

  return (
    <div>
      <PageHeader
        title="ציוד ומחסן"
        description="קטלוג הציוד, מלאי זמין ושיבוצים לאירועים"
        actions={
          canEdit ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
                <PackageCheck className="size-4" />
                שיבוץ ציוד
              </Button>
              <Button type="button" size="sm" onClick={() => (setEditing(null), setItemForm(true))}>
                <Plus className="size-4" />
                פריט חדש
              </Button>
            </>
          ) : null
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0 rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">סה״כ יחידות</p>
          <p className="num mt-1 text-2xl font-bold text-foreground">{num(totalUnits)}</p>
        </div>
        <div className="min-w-0 rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">בחוץ כרגע</p>
          <p className="num mt-1 text-2xl font-bold text-blue-700">{num(outUnits)}</p>
        </div>
        <div className="min-w-0 rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">פריטים בקטלוג</p>
          <p className="num mt-1 text-2xl font-bold text-foreground">{num(equipment.length)}</p>
        </div>
        <div className="min-w-0 rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">התראות מלאי</p>
          <p className={cn("num mt-1 text-2xl font-bold", lowStock.length ? "text-amber-700" : "text-emerald-700")}>{num(lowStock.length)}</p>
        </div>
      </div>

      <div className="mb-4 flex gap-1 rounded-xl border border-border bg-card p-1" role="tablist" aria-label="תצוגת ציוד">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "catalog"}
          onClick={() => setTab("catalog")}
          className={cn("min-h-11 flex-1 rounded-lg px-3 text-sm font-medium", tab === "catalog" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
        >
          קטלוג ({num(equipment.length)})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "out"}
          onClick={() => setTab("out")}
          className={cn("min-h-11 flex-1 rounded-lg px-3 text-sm font-medium", tab === "out" ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
        >
          מה בחוץ עכשיו ({num(assignments.filter((a) => !a.returned_at).length)})
        </button>
      </div>

      {tab === "catalog" ? (
        !equipment.length ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState
              icon={Boxes}
              title="הקטלוג ריק"
              description="הוספת פריטי ציוד תאפשר לעקוב אחרי מלאי ושיבוצים לאירועים."
              action={
                canEdit ? (
                  <Button type="button" size="sm" onClick={() => (setEditing(null), setItemForm(true))}>
                    <Plus className="size-4" />
                    פריט חדש
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {equipment.map((item) => {
              const available = Math.max(0, Number(item.quantity_total ?? 0) - Number(item.quantity_out ?? 0));
              const low = available <= Number(item.min_quantity ?? 0);
              return (
                <div key={item.id} className="min-w-0 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.category}</p>
                    </div>
                    <StatusPill status={item.status} />
                  </div>
                  <div className="mt-3 grid min-w-0 grid-cols-3 gap-2 text-center">
                    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
                      <p className="num truncate text-base font-bold text-foreground">{num(item.quantity_total)}</p>
                      <p className="text-[10px] text-muted-foreground">סה״כ</p>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
                      <p className="num truncate text-base font-bold text-blue-700">{num(item.quantity_out)}</p>
                      <p className="text-[10px] text-muted-foreground">בחוץ</p>
                    </div>
                    <div className={cn("min-w-0 rounded-lg p-2", low ? "bg-amber-50" : "bg-emerald-50")}>
                      <p className={cn("num truncate text-base font-bold", low ? "text-amber-700" : "text-emerald-700")}>{num(available)}</p>
                      <p className="text-[10px] text-muted-foreground">זמין</p>
                    </div>
                  </div>
                  {low ? (
                    <p className="mt-2 flex items-center gap-1 text-xs font-medium text-amber-700">
                      <AlertTriangle className="size-3.5" />
                      מלאי נמוך — מינימום {num(item.min_quantity)}
                    </p>
                  ) : null}
                  {item.notes ? <p className="mt-2 text-xs text-muted-foreground">{item.notes}</p> : null}
                  {canEdit ? (
                    <div className="mt-3 flex items-center justify-end gap-1 border-t border-border/60 pt-3">
                      <button
                        type="button"
                        aria-label="עריכת פריט"
                        onClick={() => {
                          setEditing(item);
                          setItemForm(true);
                        }}
                        className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="מחיקת פריט"
                        onClick={() => setDeleting(item)}
                        className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )
      ) : !outGroups.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState
            icon={PackageCheck}
            title="אין ציוד בחוץ"
            description="כל הציוד נמצא במחסן. שיבוץ ציוד לאירוע יופיע כאן."
            action={
              canEdit ? (
                <Button type="button" size="sm" onClick={() => setAssignOpen(true)}>
                  <Plus className="size-4" />
                  שיבוץ ציוד
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="space-y-4">
          {outGroups.map(({ eventId, event, items }) => {
            const late = event ? isPastDate(event.event_date) : false;
            return (
              <SectionCard
                key={eventId}
                title={event?.title ?? "אירוע"}
                description={event ? `${dateShort(event.event_date)} · ${event.venue || "ללא מקום"}` : undefined}
                action={
                  late ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
                      <AlertTriangle className="size-3.5" />
                      ציוד באיחור
                    </span>
                  ) : null
                }
                bodyClassName="p-0"
              >
                <ul className="divide-y divide-border/60">
                  {items.map((a) => {
                    const item = equipment.find((e) => e.id === a.equipment_item_id);
                    return (
                      <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {item?.name ?? "פריט ציוד"} <span className="num text-muted-foreground">× {num(a.quantity)}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">יצא ב־{dateShort(a.out_at)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {event ? (
                            <Button asChild size="sm" variant="ghost">
                              <Link to="/events/$id" params={{ id: eventId }}>לאירוע</Link>
                            </Button>
                          ) : null}
                          {canEdit ? (
                            <Button type="button" size="sm" variant="outline" onClick={() => returnItem(a)}>
                              <RotateCcw className="size-4" />
                              החזרה
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </SectionCard>
            );
          })}
        </div>
      )}

      <ItemForm
        open={itemForm}
        onOpenChange={setItemForm}
        item={editing}
        onSaved={() => equipmentQ.refetch()}
      />

      <AssignEquipmentDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        equipment={equipment}
        events={events}
        onSaved={() => {
          assignmentsQ.refetch();
          equipmentQ.refetch();
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="מחיקת פריט ציוד"
        description={`האם למחוק את "${deleting?.name ?? ""}"? שיבוצים משויכים יימחקו גם הם.`}
        onConfirm={removeItem}
        busy={busy}
      />
    </div>
  );
}

function ItemForm({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: EquipmentItem | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("הגברה");
  const [total, setTotal] = useState("1");
  const [min, setMin] = useState("0");
  const [status, setStatus] = useState("במחסן");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(item?.name ?? "");
      setCategory(item?.category ?? "הגברה");
      setTotal(item ? String(item.quantity_total ?? 1) : "1");
      setMin(item ? String(item.min_quantity ?? 0) : "0");
      setStatus(item?.status ?? "במחסן");
      setNotes(item?.notes ?? "");
      setError(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("נא להזין שם פריט.");
      return;
    }
    const totalNum = Number(total);
    if (!totalNum || totalNum < 1) {
      setError("הכמות הכוללת חייבת להיות לפחות 1.");
      return;
    }
    setBusy(true);
    const payload = {
      name: name.trim(),
      category,
      quantity_total: totalNum,
      min_quantity: Number(min) || 0,
      status,
      notes: notes.trim() || null,
    };
    const { error: dbError } = item
      ? await db.from("equipment_items").update(payload).eq("id", item.id)
      : await db.from("equipment_items").insert({ ...payload, quantity_out: 0 });
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשמור את הפריט. נסה שוב.");
      return;
    }
    toast.success(item ? "הפריט עודכן" : "הפריט נוצר");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? "עריכת פריט ציוד" : "פריט ציוד חדש"}
      description="פרטי מלאי וקטגוריה"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" form="item-form" disabled={busy}>{busy ? "שומר…" : "שמירה"}</Button>
        </div>
      }
    >
      <form id="item-form" onSubmit={save} className="space-y-4">
        <Field label="שם הפריט" htmlFor="item-name">
          <Input id="item-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: מערכת הגברה JBL" className="h-11" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="קטגוריה" htmlFor="item-category">
            <Select id="item-category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="סטטוס" htmlFor="item-status">
            <Select id="item-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {ITEM_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="כמות כוללת" htmlFor="item-total">
            <Input id="item-total" type="number" min={1} value={total} onChange={(e) => setTotal(e.target.value)} className="h-11" />
          </Field>
          <Field label="מלאי מינימום" htmlFor="item-min" hint="התראה כשהמלאי הזמין יורד מתחת לזה">
            <Input id="item-min" type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="item-notes">
          <Textarea id="item-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="מצב הפריט, אביזרים, אחריות" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function AssignEquipmentDialog({
  open,
  onOpenChange,
  equipment,
  events,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  equipment: EquipmentItem[];
  events: import("@/lib/types").EventRow[];
  onSaved: () => void;
}) {
  const [eventId, setEventId] = useState("");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("1");
  const [outAt, setOutAt] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = equipment.find((e) => e.id === itemId);
  const available = selected ? Math.max(0, Number(selected.quantity_total ?? 0) - Number(selected.quantity_out ?? 0)) : 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!eventId) {
      setError("נא לבחור אירוע.");
      return;
    }
    if (!itemId) {
      setError("נא לבחור פריט ציוד.");
      return;
    }
    const quantity = Number(qty);
    if (!quantity || quantity < 1) {
      setError("הכמות חייבת להיות לפחות 1.");
      return;
    }
    if (quantity > available) {
      setError(`אין מספיק מלאי. זמין כרגע: ${available}.`);
      return;
    }
    setBusy(true);
    const { error: dbError } = await db.from("equipment_assignments").insert({
      equipment_item_id: itemId,
      event_id: eventId,
      quantity,
      out_at: outAt,
      returned_at: null,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשבץ את הציוד. ייתכן שהמלאי השתנה — נסה שוב.");
      return;
    }
    toast.success("הציוד שובץ לאירוע");
    setEventId("");
    setItemId("");
    setQty("1");
    setNotes("");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="שיבוץ ציוד לאירוע"
      description="בחירת אירוע, פריט וכמות"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" form="assign-eq-form" disabled={busy}>{busy ? "משבץ…" : "שיבוץ"}</Button>
        </div>
      }
    >
      <form id="assign-eq-form" onSubmit={save} className="space-y-4">
        <Field label="אירוע" htmlFor="ae-event">
          <Select id="ae-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">בחירת אירוע</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.title} · {dateShort(ev.event_date)}</option>
            ))}
          </Select>
        </Field>
        <Field label="פריט ציוד" htmlFor="ae-item">
          <Select id="ae-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">בחירת פריט</option>
            {equipment.map((e) => {
              const avail = Math.max(0, Number(e.quantity_total ?? 0) - Number(e.quantity_out ?? 0));
              return (
                <option key={e.id} value={e.id} disabled={avail <= 0}>
                  {e.name} · זמין {avail}
                </option>
              );
            })}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="כמות" htmlFor="ae-qty" hint={selected ? `זמין: ${available}` : undefined}>
            <Input id="ae-qty" type="number" min={1} max={available || undefined} value={qty} onChange={(e) => setQty(e.target.value)} className="h-11" />
          </Field>
          <Field label="תאריך יציאה" htmlFor="ae-out">
            <Input id="ae-out" type="date" value={outAt} onChange={(e) => setOutAt(e.target.value)} className="h-11" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="ae-notes">
          <Textarea id="ae-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="מצב הפריט, אביזרים נלווים" />
        </Field>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}
