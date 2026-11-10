import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, FileText } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import {
  PAPERLESS_DOC_LABELS,
  issuePaperlessDocument,
  type PaperlessDocType,
} from "@/lib/paperless";
import type { Quote } from "@/lib/types";

type QuoteWithPaperless = Quote & {
  paperless_document_number?: string | null;
  paperless_url?: string | null;
  paperless_document_id?: string | null;
};

export function PaperlessIssueDialog({
  open,
  onOpenChange,
  quote,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quote: QuoteWithPaperless | null;
  onIssued: () => void;
}) {
  const [docType, setDocType] = useState<PaperlessDocType>("payment_request");
  const [dueDate, setDueDate] = useState("");
  const [confirmReissue, setConfirmReissue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedResult, setIssuedResult] = useState<{
    docNumber: string | null;
    docUrl: string | null;
  } | null>(null);

  const alreadyIssued = Boolean(
    quote?.paperless_document_number || quote?.paperless_url || quote?.paperless_document_id,
  );

  useEffect(() => {
    if (open) {
      setDocType("payment_request");
      setDueDate(quote?.valid_until ?? "");
      setConfirmReissue(false);
      setError(null);
      setIssuedResult(null);
    }
  }, [open, quote?.valid_until]);

  async function handleIssue() {
    if (!quote) return;
    if (alreadyIssued && !confirmReissue) {
      setError("להצעה זו כבר הופק מסמך. סמן אישור הנפקה חוזרת כדי להפיק מסמך חדש.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await issuePaperlessDocument({
      quoteId: quote.id,
      docType,
      dueDate: dueDate || null,
      confirmReissue,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setIssuedResult({ docNumber: res.docNumber, docUrl: res.docUrl });
    onIssued();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="הפקת מסמך ב-Paperless"
      description={quote ? `הצעת מחיר מס׳ ${quote.quote_number} · ${quote.client_name}` : undefined}
      footer={
        issuedResult ? (
          <div className="flex justify-end gap-2">
            {issuedResult.docUrl ? (
              <Button asChild variant="outline">
                <a href={issuedResult.docUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> פתיחת המסמך
                </a>
              </Button>
            ) : null}
            <Button type="button" onClick={() => onOpenChange(false)}>
              סגירה
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              ביטול
            </Button>
            <Button
              type="button"
              onClick={handleIssue}
              disabled={busy || !quote || quote.status !== "approved"}
            >
              <FileText className="size-4" /> {busy ? "מפיק מסמך…" : "הפק מסמך"}
            </Button>
          </div>
        )
      }
    >
      {issuedResult ? (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="size-5 text-emerald-600" />
            <span>המסמך הופק בהצלחה ב-Paperless!</span>
          </div>
          {issuedResult.docNumber ? <p>מספר מסמך: {issuedResult.docNumber}</p> : null}
        </div>
      ) : (
        <div className="space-y-4">
          {quote && quote.status !== "approved" ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              יש לעדכן/לאשר את הצעת המחיר לפני הפקת מסמך חשבונאי.
            </p>
          ) : null}

          <Field label="סוג מסמך להפקה" htmlFor="paperless-doc-type">
            <Select
              id="paperless-doc-type"
              value={docType}
              onChange={(e) => setDocType(e.target.value as PaperlessDocType)}
            >
              {(Object.keys(PAPERLESS_DOC_LABELS) as PaperlessDocType[]).map((key) => (
                <option key={key} value={key}>
                  {PAPERLESS_DOC_LABELS[key]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="תאריך לתשלום (אופציונלי)" htmlFor="paperless-due-date">
            <Input
              id="paperless-due-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="h-11"
            />
          </Field>

          {alreadyIssued ? (
            <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <input
                type="checkbox"
                checked={confirmReissue}
                onChange={(e) => setConfirmReissue(e.target.checked)}
              />
              <span>
                להצעה זו כבר הופק מסמך {quote?.paperless_document_number ? `(${quote.paperless_document_number})` : ""} — אני מאשר הפקת מסמך נוסף
              </span>
            </label>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
