import { useState } from "react";
import { useSession } from "@/hooks/use-session";
import { AccountingFiles } from "@/components/events/accounting-files";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/overlay";
import { ErrorState, NoAccess, PageHeader, PageSkeleton, SectionCard, StatCard } from "@/components/shared";
import { accountingCopy as copy } from "@/content/event-accounting";
import { db } from "@/integrations/neon/client";
import { money, dateShort } from "@/lib/format";
import { useAccountingAccess, useEventAccounting, safeAccountingLink, type AccountingReference } from "@/hooks/use-event-accounting";

const emptyForm = { doc_type: "transaction_account", doc_number: "", document_date: "", notes: "", doc_url: "" };

export function EventAccountingPage({ eventId }: { eventId: string }) {
  const { user, profile } = useSession();
  const access = useAccountingAccess();
  const dataQ = useEventAccounting(eventId, access.canView, access.userId);
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [formError, setFormError] = useState("");

  function reset() { setForm(emptyForm); setEditing(null); setFormError(""); }
  function edit(row: AccountingReference) {
    setEditing(row.id);
    setForm({ doc_type: row.doc_type, doc_number: row.doc_number, document_date: row.document_date ?? "", notes: row.notes ?? "", doc_url: row.doc_url ?? "" });
    setFormError("");
  }
  const save = useMutation({
    mutationFn: async () => {
      if (!access.canEdit) throw new Error(copy.saveError);
      if (!copy.manualTypes.includes(form.doc_type) || !form.doc_number.trim() || (form.doc_url.trim() && !safeAccountingLink(form.doc_url.trim()))) throw new Error(copy.invalid);
      const values = { doc_type: form.doc_type, doc_number: form.doc_number.trim(), document_date: form.document_date || null, notes: form.notes.trim() || null, doc_url: form.doc_url.trim() || null };
      const query = editing
        ? db.from<{ id: string }[]>("event_accounting_references").update(values).eq("id", editing).eq("event_id", eventId)
        : db.from<{ id: string }[]>("event_accounting_references").insert({ ...values, event_id: eventId });
      const { data, error } = await query.select("id");
      if (error || !data?.length) throw new Error(error?.code === "23505" ? copy.duplicateNumber : error?.code === "42501" ? (error.message.includes("schema auth") ? copy.schemaError : copy.permissionError) : error?.code === "PGRST205" ? copy.schemaError : copy.saveError);
    },
    onSuccess: async () => { reset(); await queryClient.invalidateQueries({ queryKey: ["event-accounting"] }); },
    onError: (error) => setFormError(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!access.canEdit || !deleting) throw new Error(copy.deleteError);
      const { data, error } = await db.from<{ id: string }[]>("event_accounting_references").delete().eq("id", deleting).eq("event_id", eventId).select("id");
      if (error || !data?.length) throw new Error(copy.deleteError);
    },
    onSuccess: async () => { if (editing === deleting) reset(); setDeleting(null); await queryClient.invalidateQueries({ queryKey: ["event-accounting"] }); },
    onError: () => { setDeleting(null); setFormError(copy.deleteError); },
  });

  if (access.isLoading) return <PageSkeleton />;
  if (access.isError) return <ErrorState message={copy.accessError} onRetry={() => access.refetch()} />;
  if (!access.canView) return <NoAccess moduleLabel={copy.access} />;
  if (dataQ.isLoading) return <PageSkeleton />;
  if (dataQ.error) {
    const status = (dataQ.error as Error & { status?: number }).status;
    if (status === 401 || status === 403) return <NoAccess moduleLabel={copy.access} />;
    return <ErrorState message={status === 404 ? copy.notFound : copy.loadError} onRetry={() => dataQ.refetch()} />;
  }
  const data = dataQ.data;
  if (!data?.event) return <ErrorState message={copy.notFound} onRetry={() => dataQ.refetch()} />;
  const ledger = data.finance ?? [];
  const invoiced = ledger.filter((row) => row.kind === copy.invoiceKind).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const received = ledger.filter((row) => row.kind === copy.paymentKind && row.status === copy.paid).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const charge = invoiced || Number(data.event.total_amount ?? 0);

  return (
    <div dir="rtl" className="space-y-5">
      <PageHeader title={copy.title} description={profile?.full_name?.trim() || user?.name?.trim() || user?.email || copy.userFallback} actions={<>
        <Button asChild type="button" variant="outline"><Link to="/events/$id" params={{ id: eventId }}>{copy.back}</Link></Button>
        <Button asChild type="button" variant="outline"><Link to="/events/$id" params={{ id: eventId }} hash="finance">{copy.tools}</Link></Button>
      </>} />
      <p className="text-sm text-muted-foreground">{copy.eventLabel}: <span className="font-medium text-foreground">{data.event.title}</span> · {copy.description}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={copy.budget} value={money(data.event.total_amount)} />
        <StatCard label={copy.invoiced} value={money(invoiced)} />
        <StatCard label={copy.received} value={money(received)} />
        <StatCard label={copy.balance} value={money(Math.max(0, charge - received))} />
      </div>

      <AccountingFiles eventId={eventId} files={data.files ?? []} canEdit={access.canEdit} scanAvailable={data.scanAvailable === true} />

      <SectionCard title={copy.manualTitle} description={copy.manualNote}>
        <div className="space-y-3">
          {(data.references ?? []).map((row) => (
            <div key={row.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-semibold">{copy.docTypes[row.doc_type] ?? row.doc_type} - <bdi dir="ltr">{row.doc_number}</bdi></p>
                <span className="text-xs text-muted-foreground">{copy.manualBadge}</span>
              </div>
              {row.document_date ? <p className="mt-1 text-xs text-muted-foreground">{dateShort(row.document_date)}</p> : null}
              {row.notes ? <p className="mt-1 whitespace-pre-wrap break-words text-sm">{row.notes}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {safeAccountingLink(row.doc_url) ? <a className="inline-flex min-h-11 items-center text-sm text-primary underline" href={safeAccountingLink(row.doc_url)} target="_blank" rel="noopener noreferrer">{copy.open}</a> : null}
                {access.canEdit ? <>
                  <Button type="button" size="sm" variant="outline" disabled={save.isPending || remove.isPending} onClick={() => edit(row)}>{copy.edit}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={save.isPending || remove.isPending} onClick={() => setDeleting(row.id)}>{copy.remove}</Button>
                </> : null}
              </div>
            </div>
          ))}
          {!(data.references ?? []).length ? <p className="text-sm text-muted-foreground">{copy.noReferences}</p> : null}
        </div>
        {formError ? <p role="alert" className="mt-3 text-sm text-destructive">{formError}</p> : null}
        {access.canEdit ? <form className="mt-4 space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); setFormError(""); save.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={copy.type} htmlFor="accounting-type"><Select id="accounting-type" value={form.doc_type} onChange={(event) => setForm({ ...form, doc_type: event.target.value })}>
              {copy.manualTypes.map((type) => <option key={type} value={type}>{copy.docTypes[type]}</option>)}
            </Select></Field>
            <Field label={copy.number} htmlFor="accounting-number"><Input id="accounting-number" type="text" required maxLength={120} value={form.doc_number} onChange={(event) => setForm({ ...form, doc_number: event.target.value })} /></Field>
            <Field label={copy.date} htmlFor="accounting-date"><Input id="accounting-date" type="date" value={form.document_date} onChange={(event) => setForm({ ...form, document_date: event.target.value })} /></Field>
            <Field label={copy.url} htmlFor="accounting-url"><Input id="accounting-url" type="url" dir="ltr" maxLength={2048} value={form.doc_url} onChange={(event) => setForm({ ...form, doc_url: event.target.value })} /></Field>
          </div>
          <Field label={copy.notes} htmlFor="accounting-notes"><Textarea id="accounting-notes" maxLength={2000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending || remove.isPending}>{save.isPending ? copy.saving : copy.save}</Button>
            {editing ? <Button type="button" variant="outline" disabled={save.isPending} onClick={reset}>{copy.cancel}</Button> : null}
          </div>
        </form> : null}
      </SectionCard>

      <SectionCard title={copy.ledgerTitle}>
        <div className="space-y-2">
          {ledger.map((row) => <div key={row.id} className="flex flex-wrap justify-between gap-2 rounded-lg border border-border p-3 text-sm">
            <div className="min-w-0 break-words"><p className="font-medium">{row.kind}{row.doc_number ? <> - <bdi dir="ltr">{row.doc_number}</bdi></> : null}</p><p className="text-xs text-muted-foreground">{row.status}{row.issued_at ? ` · ${dateShort(row.issued_at)}` : ""}</p>{row.notes ? <p className="mt-1 whitespace-pre-wrap break-words">{row.notes}</p> : null}</div>
            <span className="num font-semibold">{money(row.amount)}</span>
          </div>)}
          {!ledger.length ? <p className="text-sm text-muted-foreground">{copy.noLedger}</p> : null}
        </div>
      </SectionCard>

      {(data.paperless ?? []).length ? <SectionCard title={copy.providerTitle}>
        <div className="space-y-2">
          {(data.paperless ?? []).map((row) => {
            const confirmed = row.status === "issued" && !!(row.doc_number || row.doc_url || row.external_id);
            return <div key={row.id} className="space-y-1 rounded-lg border border-border p-3 text-sm">
              <p className="break-words font-medium">{copy.docTypes[row.doc_type] ?? row.doc_type} - <bdi dir="ltr">{row.doc_number || copy.noNumber}</bdi></p>
              <p className="text-xs text-muted-foreground">{confirmed ? copy.confirmed : copy.unverified}</p>
              {confirmed && safeAccountingLink(row.doc_url) ? <a className="inline-flex min-h-11 items-center text-primary underline" href={safeAccountingLink(row.doc_url)} target="_blank" rel="noopener noreferrer">{copy.open}</a> : null}
            </div>;
          })}
        </div>
      </SectionCard> : null}
      <ConfirmDialog open={!!deleting} onOpenChange={(open) => { if (!open && !remove.isPending) setDeleting(null); }} title={copy.deleteTitle} description={copy.deleteNote} confirmLabel={copy.remove} busy={remove.isPending} onConfirm={() => remove.mutate()} />
    </div>
  );
}
