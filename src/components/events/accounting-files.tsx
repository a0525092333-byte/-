import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageUpload } from "@/components/image-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { SectionCard } from "@/components/shared";
import { accountingCopy as common, accountingFilesCopy as copy } from "@/content/event-accounting";
import { accountingRequest, type AccountingFile } from "@/hooks/use-event-accounting";
import { dateShort, num } from "@/lib/format";

type Review = { doc_type: string; doc_number: string; document_date: string; supplier: string; customer: string; amount: string; vat: string; notes: string };
type Duplicate = { kind: "upload"; file: File } | { kind: "reference"; file: AccountingFile; values: Review };
type ApiError = Error & { code?: string; status?: number };
const ProtectedPdfPreview = lazy(() => import("@/components/events/protected-pdf-preview"));

function scanMessage(file: AccountingFile) {
  const code = (file.scan_result?.warnings ?? []).find((warning) => copy.scanErrors[warning]);
  return code ? copy.scanErrors[code] : copy.scanFailed;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(copy.uploadError));
    reader.readAsDataURL(file);
  });
}

export function AccountingFiles({ eventId, files, canEdit, scanAvailable }: { eventId: string; files: AccountingFile[]; canEdit: boolean; scanAvailable: boolean }) {
  const queryClient = useQueryClient();
  const base = `/api/events/${encodeURIComponent(eventId)}/accounting/files`;
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<AccountingFile | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [deleting, setDeleting] = useState<AccountingFile | null>(null);
  const [rescanTarget, setRescanTarget] = useState<AccountingFile | null>(null);
  const [preview, setPreview] = useState<{ url: string; mime: string; name: string; bytes: Uint8Array } | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  function refresh() { return queryClient.invalidateQueries({ queryKey: ["event-accounting"] }); }
  function startReview(file: AccountingFile) {
    const proposed = !file.confirmed_at && file.scan_result && "doc_type" in file.scan_result ? file.scan_result : null;
    const source = proposed ?? file;
    setReviewing(file);
    setReview({
      doc_type: source.doc_type ?? "", doc_number: source.doc_number ?? "", document_date: source.document_date ?? "",
      supplier: source.supplier ?? "", customer: source.customer ?? "", amount: source.amount == null ? "" : String(source.amount),
      vat: source.vat == null ? "" : String(source.vat), notes: file.notes ?? "",
    });
    setError("");
  }
  const scan = useMutation({
    retry: 0,
    mutationFn: async ({ file, rescan = false }: { file: AccountingFile; rescan?: boolean }) => {
      if (!canEdit || file.confirmed_at) throw new Error(copy.actionError);
      let text = "";
      if (file.mime === "application/pdf") {
        const original = await fetchOriginal(file);
        try {
          const { extractPdfLines, hasExtractableText } = await import("@/lib/quote-import/extract");
          const lines = await extractPdfLines(new File([new Uint8Array(original.bytes)], original.name, { type: original.mime }));
          const extracted = lines.map((line) => line.text).join("\n");
          if (hasExtractableText(lines) && extracted.length <= 100_000 && /חשבונית|חשבון\s+עסקה|קבלה|זיכוי/.test(extracted)) text = extracted;
        } catch { /* Image-only or unsupported PDFs retain the existing vision scan. */ }
      }
      return await accountingRequest<{ file: AccountingFile; scanSucceeded?: boolean; scanError?: string }>(`${base}/${file.id}/scan`, { method: "POST", ...(text || rescan ? { body: JSON.stringify({ ...(text ? { text } : {}), ...(rescan ? { rescan: true } : {}) }) } : {}) });
    },
    onSuccess: async (data) => { await refresh(); startReview(data.file); if (data.scanSucceeded === false || data.file.scan_status !== "scanned") setError(data.scanError ? copy.scanErrors[data.scanError] ?? scanMessage(data.file) : scanMessage(data.file)); },
    onError: async (failure: ApiError, variables) => {
      if (failure.code === "scan_review_available") { startReview(variables.file); setError(copy.scanAlreadyScanned); }
      else setError(failure.code === "scan_confirmed" ? copy.scanConfirmed : copy.scanFailed);
      await refresh();
    },
  });
  const upload = useMutation({
    mutationFn: async ({ file, allowDuplicate = false }: { file: File; allowDuplicate?: boolean }) => {
      if (!canEdit) throw new Error(common.permissionError);
      const mime = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "");
      if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mime) || !file.size || file.size > 8 * 1024 * 1024) throw new Error(copy.sizeError);
      return await accountingRequest<{ file: AccountingFile }>(base, { method: "POST", body: JSON.stringify({ name: file.name, mime, data: await readFile(file), allowDuplicate }) });
    },
    onSuccess: async (data) => {
      setError(""); setDuplicate(null); await refresh();
      if (scanAvailable || data.file.mime === "application/pdf") scan.mutate({ file: data.file }); else startReview(data.file);
    },
    onError: (failure: ApiError, variables) => {
      if (failure.code === "duplicate_file") setDuplicate({ kind: "upload", file: variables.file });
      else setError(failure.message === copy.sizeError ? copy.sizeError : copy.uploadError);
    },
  });
  const confirm = useMutation({
    mutationFn: async ({ file, values, allowDuplicate = false }: { file: AccountingFile; values: Review; allowDuplicate?: boolean }) => {
      if (!canEdit || !common.manualTypes.includes(values.doc_type)) throw new Error(copy.confirmError);
      return await accountingRequest(`${base}/${file.id}`, { method: "PATCH", body: JSON.stringify({ ...values, doc_number: values.doc_number.trim() || null, document_date: values.document_date || null, amount: values.amount === "" ? null : Number(values.amount), vat: values.vat === "" ? null : Number(values.vat), allowDuplicate }) });
    },
    onSuccess: async () => { setDuplicate(null); setReviewing(null); setReview(null); setError(""); await refresh(); },
    onError: (failure: ApiError, variables) => {
      if (failure.code === "duplicate_reference") setDuplicate({ kind: "reference", file: variables.file, values: variables.values });
      else setError(failure.code === "accounting_storage_permission" ? copy.storagePermission : copy.confirmError);
    },
  });
  const remove = useMutation({
    mutationFn: async (file: AccountingFile) => {
      if (!canEdit) throw new Error(common.permissionError);
      await accountingRequest(`${base}/${file.id}`, { method: "DELETE" });
    },
    onSuccess: async () => { setDeleting(null); setError(""); await refresh(); },
    onError: () => { setDeleting(null); setError(copy.actionError); },
  });
  const busy = upload.isPending || scan.isPending || confirm.isPending || remove.isPending;

  async function pick(file: File) {
    if (busy) throw new Error(copy.actionError);
    setError("");
    await upload.mutateAsync({ file });
    return "";
  }
  async function openFile(file: AccountingFile, download: boolean) {
    setOpening(true); setError("");
    try {
      const data = await fetchOriginal(file);
      const bytes = data.bytes;
      const url = URL.createObjectURL(new Blob([bytes], { type: data.mime }));
      if (download) {
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = data.name; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else setPreview({ url, mime: data.mime, name: data.name, bytes });
    } catch { setError(copy.openError); }
    finally { setOpening(false); }
  }

  async function fetchOriginal(file: AccountingFile) {
    const data = await accountingRequest<{ name: string; mime: string; data: string }>(`${base}/${file.id}`);
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(data.mime) || typeof data.data !== "string" || data.data.length > 11_184_812) throw new Error(copy.openError);
    return { ...data, bytes: Uint8Array.from(atob(data.data), (character) => character.charCodeAt(0)) };
  }

  return <SectionCard title={copy.title} description={copy.description}>
    <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{copy.formats}</p>
    {!scanAvailable ? <p role="status" className="mb-3 text-sm text-amber-900">{copy.scanUnavailable}</p> : null}
    {canEdit ? <div className="mb-4 flex flex-wrap gap-2" aria-busy={busy}>
      <ImageUpload key={`upload-${files.length}`} preview={false} disabled={busy} accept="application/pdf,image/jpeg,image/png,image/webp" label={copy.upload} busyLabel={copy.uploading} onChange={() => {}} uploadFile={pick} />
      <ImageUpload key={`camera-${files.length}`} preview={false} disabled={busy} accept="image/jpeg,image/png,image/webp" capture="environment" label={copy.camera} busyLabel={copy.uploading} onChange={() => {}} uploadFile={pick} />
      {scan.isPending ? <p role="status" className="self-center text-sm">{copy.scanning}</p> : null}
    </div> : null}
    {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
    <div className="space-y-3">
      {(files ?? []).map((file) => <article key={file.id} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 break-all text-sm font-semibold">{file.file_name}</p>
          <span className="text-xs text-muted-foreground">{file.confirmed_at ? copy.filed : copy.statuses[file.scan_status] ?? copy.statuses.pending}</span>
        </div>
        <p className="text-xs text-muted-foreground">{dateShort(file.uploaded_at)} · {file.mime} · {Math.ceil((file.size_bytes ?? 0) / 1024)} KB</p>
        {file.confirmed_at ? <div className="space-y-1 text-sm">
          <p className="break-words">{common.docTypes[file.doc_type] ?? common.docTypes.other}{file.doc_number ? <> - <bdi dir="ltr">{file.doc_number}</bdi></> : null}</p>
          {file.document_date ? <p>{dateShort(file.document_date)}</p> : null}
          {file.supplier ? <p className="break-words">{copy.supplier}: {file.supplier}</p> : null}
          {file.customer ? <p className="break-words">{copy.customer}: {file.customer}</p> : null}
          {file.amount != null ? <p>{copy.amount}: {num(Number(file.amount))}</p> : null}
          {file.vat != null ? <p>{copy.vat}: {num(Number(file.vat))}</p> : null}
          {file.notes ? <p className="whitespace-pre-wrap break-words">{file.notes}</p> : null}
        </div> : null}
        {file.scan_status === "failed" || file.scan_status === "unavailable" ? <p className="text-xs text-amber-900">{scanMessage(file)}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={opening} onClick={() => void openFile(file, false)}>{copy.open}</Button>
          <Button type="button" size="sm" variant="outline" disabled={opening} onClick={() => void openFile(file, true)}>{copy.download}</Button>
          {canEdit ? <>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => startReview(file)}>{file.confirmed_at ? copy.edit : copy.review}</Button>
            {!file.confirmed_at ? <Button type="button" size="sm" variant="outline" disabled={busy || (!scanAvailable && file.mime !== "application/pdf")} onClick={() => file.scan_status === "scanned" ? setRescanTarget(file) : scan.mutate({ file })}>{file.scan_status === "scanned" ? copy.rescan : copy.scan}</Button> : null}
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDeleting(file)}>{copy.remove}</Button>
          </> : null}
        </div>
      </article>)}
      {!files.length ? <p className="text-sm text-muted-foreground">{copy.empty}</p> : null}
    </div>

    <Dialog open={!!reviewing && !!review && canEdit} onOpenChange={(open) => { if (!open && !busy) { setReviewing(null); setReview(null); } }} title={copy.review} size="lg">
      {review && reviewing ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); confirm.mutate({ file: reviewing, values: review }); }}>
        <p className="break-all text-sm font-medium">{reviewing.file_name}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.reviewNote}</p>
        {reviewing.confirmed_at ? <p className="text-xs leading-relaxed text-muted-foreground">{copy.retainedReferenceNote}</p> : null}
        {!review.doc_number || !review.document_date || !review.amount || (reviewing.scan_result?.warnings ?? []).length ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{copy.missing}</p> : null}
        {reviewing.scan_status === "failed" || reviewing.scan_status === "unavailable" ? <p className="text-sm text-amber-900">{scanMessage(reviewing)}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          <Field label={common.type} htmlFor="file-doc-type"><Select id="file-doc-type" required value={review.doc_type} onChange={(event) => setReview({ ...review, doc_type: event.target.value })}>
            <option value="">{copy.chooseType}</option>{common.manualTypes.map((type) => <option key={type} value={type}>{common.docTypes[type]}</option>)}
          </Select></Field>
          <Field label={copy.number} htmlFor="file-doc-number"><Input id="file-doc-number" type="text" maxLength={120} value={review.doc_number} onChange={(event) => setReview({ ...review, doc_number: event.target.value })} /></Field>
          <Field label={common.date} htmlFor="file-doc-date"><Input id="file-doc-date" type="date" value={review.document_date} onChange={(event) => setReview({ ...review, document_date: event.target.value })} /></Field>
          <Field label={copy.supplier} htmlFor="file-doc-supplier"><Input id="file-doc-supplier" maxLength={250} value={review.supplier} onChange={(event) => setReview({ ...review, supplier: event.target.value })} /></Field>
          <Field label={copy.customer} htmlFor="file-doc-customer"><Input id="file-doc-customer" maxLength={250} value={review.customer} onChange={(event) => setReview({ ...review, customer: event.target.value })} /></Field>
          <Field label={copy.amount} htmlFor="file-doc-amount"><Input id="file-doc-amount" type="number" step="0.01" inputMode="decimal" value={review.amount} onChange={(event) => setReview({ ...review, amount: event.target.value })} /></Field>
          <Field label={copy.vat} htmlFor="file-doc-vat"><Input id="file-doc-vat" type="number" step="0.01" inputMode="decimal" value={review.vat} onChange={(event) => setReview({ ...review, vat: event.target.value })} /></Field>
          <Field label={common.notes} htmlFor="file-doc-notes" className="sm:col-span-2"><Textarea id="file-doc-notes" maxLength={2000} value={review.notes} onChange={(event) => setReview({ ...review, notes: event.target.value })} /></Field>
        </fieldset>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{confirm.isPending ? copy.confirming : copy.confirm}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setReviewing(null); setReview(null); }}>{copy.cancel}</Button></div>
      </form> : null}
    </Dialog>
    <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }} title={preview?.name ?? copy.open} size="lg">
      {preview?.mime === "application/pdf" ? <Suspense fallback={<p role="status">{copy.previewLoading}</p>}><ProtectedPdfPreview bytes={preview.bytes} /></Suspense> : preview ? <img src={preview.url} alt={preview.name} className="mx-auto max-h-[60vh] max-w-full object-contain" /> : null}
      {preview ? <a href={preview.url} download={preview.name} className="mt-2 inline-flex min-h-11 items-center text-sm text-primary underline">{copy.download}</a> : null}
      <Button type="button" variant="outline" className="mt-3" onClick={() => setPreview(null)}>{copy.close}</Button>
    </Dialog>
    <ConfirmDialog open={!!deleting} onOpenChange={(open) => { if (!open && !remove.isPending) setDeleting(null); }} title={copy.deleteTitle} description={copy.deleteNote} confirmLabel={copy.remove} busy={remove.isPending} onConfirm={() => { if (deleting) remove.mutate(deleting); }} />
    <ConfirmDialog open={!!rescanTarget} onOpenChange={(open) => { if (!open) setRescanTarget(null); }} title={copy.rescanTitle} description={copy.rescanNote} confirmLabel={copy.rescanConfirm} onConfirm={() => { if (rescanTarget) { scan.mutate({ file: rescanTarget, rescan: true }); setRescanTarget(null); } }} />
    <ConfirmDialog open={!!duplicate} onOpenChange={(open) => { if (!open && !busy) setDuplicate(null); }} title={copy.duplicateTitle} description={copy.duplicateNote} confirmLabel={copy.duplicateConfirm} busy={busy} onConfirm={() => {
      if (duplicate?.kind === "upload") upload.mutate({ file: duplicate.file, allowDuplicate: true });
      else if (duplicate?.kind === "reference") confirm.mutate({ file: duplicate.file, values: duplicate.values, allowDuplicate: true });
    }} />
  </SectionCard>;
}
