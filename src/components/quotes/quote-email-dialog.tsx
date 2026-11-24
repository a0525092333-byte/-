import { useEffect, useRef, useState } from "react";
import { Mail, Paperclip, Plus, Users, X } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import {
  EMAIL_REGEX,
  fetchQuoteCcEmails,
  parseEmailInput,
  sendQuoteEmail,
  uniqueEmails,
} from "@/lib/quote-email";
import type { Quote } from "@/lib/types";

type CcItem = {
  email: string;
  checked: boolean;
  permanent: boolean;
};

export function QuoteEmailDialog({
  open,
  onOpenChange,
  quote,
  defaultEmail,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  quote: Quote | null;
  defaultEmail: string;
}) {
  const [to, setTo] = useState(defaultEmail);
  const [ccItems, setCcItems] = useState<CcItem[]>([]);
  const [loadingCc, setLoadingCc] = useState(false);
  const [extraCcInput, setExtraCcInput] = useState("");
  const [ccError, setCcError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentResult, setSentResult] = useState<{ to: string; cc: string[] } | null>(null);
  const defaultEmailRef = useRef(defaultEmail);

  useEffect(() => {
    defaultEmailRef.current = defaultEmail;
  }, [defaultEmail]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTo(defaultEmailRef.current);
    setMessage("");
    setError(null);
    setCcError(null);
    setExtraCcInput("");
    setSentResult(null);
    setLoadingCc(true);
    fetchQuoteCcEmails().then((saved) => {
      if (cancelled) return;
      setCcItems(saved.map((email) => ({ email, checked: true, permanent: true })));
      setLoadingCc(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function toggleCc(email: string) {
    setCcItems((prev) =>
      prev.map((item) => (item.email === email ? { ...item, checked: !item.checked } : item)),
    );
  }

  function removeOneTimeCc(email: string) {
    setCcItems((prev) => prev.filter((item) => item.email !== email));
  }

  function handleAddOneTimeCc() {
    setCcError(null);
    const parsed = parseEmailInput(extraCcInput);
    if (!parsed.length) return;
    const invalid = parsed.find((addr) => !EMAIL_REGEX.test(addr));
    if (invalid) {
      setCcError(`כתובת אימייל לא תקינה: ${invalid}`);
      return;
    }
    setCcItems((prev) => {
      const next = [...prev];
      for (const addr of parsed) {
        const existingIdx = next.findIndex((item) => item.email === addr);
        if (existingIdx >= 0) {
          next[existingIdx] = { ...next[existingIdx], checked: true };
        } else {
          next.push({ email: addr, checked: true, permanent: false });
        }
      }
      return next;
    });
    setExtraCcInput("");
  }

  async function send() {
    if (!quote) return;
    const email = to.trim();
    if (!EMAIL_REGEX.test(email)) {
      setError("נא להזין כתובת אימייל תקינה ללקוח");
      return;
    }

    let pendingExtra: string[] = [];
    if (extraCcInput.trim()) {
      pendingExtra = parseEmailInput(extraCcInput);
      const invalid = pendingExtra.find((addr) => !EMAIL_REGEX.test(addr));
      if (invalid) {
        setCcError(`כתובת אימייל בעותק אינה תקינה: ${invalid}`);
        return;
      }
    }

    const selectedCc = uniqueEmails(
      [...ccItems.filter((item) => item.checked).map((item) => item.email), ...pendingExtra],
      email,
    );

    setBusy(true);
    setError(null);
    setCcError(null);
    const result = await sendQuoteEmail(quote.id, email, message, selectedCc);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSentResult({ to: result.to, cc: result.cc });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="שליחת הצעה ללקוח"
      description={quote ? `הצעת מחיר מס׳ ${quote.quote_number}` : undefined}
      footer={
        sentResult ? (
          <div className="flex justify-end">
            <Button type="button" onClick={() => onOpenChange(false)}>
              סגירה
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              ביטול
            </Button>
            <Button type="button" onClick={send} disabled={busy || !quote}>
              <Mail className="size-4" /> {busy ? "שולח…" : "שלח"}
            </Button>
          </div>
        )
      }
    >
      {sentResult ? (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-emerald-700">ההצעה נשלחה בהצלחה</p>
          <p className="text-sm text-muted-foreground">
            נשלחה אל <span dir="ltr" className="font-medium text-foreground">{sentResult.to}</span> עם קובץ PDF מצורף.
          </p>
          {sentResult.cc.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              עותק גלוי (CC): <span dir="ltr" className="font-medium text-foreground">{sentResult.cc.join(", ")}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="אימייל הלקוח" htmlFor="quote-email-to" error={error ?? undefined}>
            <Input
              id="quote-email-to"
              type="email"
              dir="ltr"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-11 text-start"
              placeholder="client@example.com"
            />
          </Field>

          <div className="rounded-lg border border-border bg-muted/25 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Users className="size-3.5 text-muted-foreground" />
                עותק גלוי (CC — גלוי ללקוח עבור &quot;השב לכולם&quot;)
              </span>
            </div>

            {loadingCc ? (
              <p className="text-xs text-muted-foreground">טוען נמענים קבועים…</p>
            ) : ccItems.length > 0 ? (
              <div className="space-y-1.5">
                {ccItems.map((item) => (
                  <div
                    key={item.email}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-xs"
                  >
                    <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={item.checked}
                        onChange={() => toggleCc(item.email)}
                        className="size-4 rounded border-border accent-primary cursor-pointer"
                      />
                      <span
                        dir="ltr"
                        className={`truncate ${item.checked ? "font-medium text-foreground" : "line-through text-muted-foreground"}`}
                      >
                        {item.email}
                      </span>
                    </label>
                    {item.permanent ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                        קבוע
                      </span>
                    ) : (
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
                          חד-פעמי
                        </span>
                        <button
                          type="button"
                          onClick={() => removeOneTimeCc(item.email)}
                          title="הסר כתובת חד-פעמית"
                          className="rounded p-0.5 text-muted-foreground hover:text-red-600"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                לא הוגדרו נמענים קבועים (ניתן להוסיף קבועים בלשונית &quot;הגדרות&quot; של הצעות מחיר).
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <Input
                id="quote-email-extra-cc"
                type="text"
                inputMode="email"
                dir="ltr"
                value={extraCcInput}
                onChange={(e) => {
                  setExtraCcInput(e.target.value);
                  if (ccError) setCcError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddOneTimeCc();
                  }
                }}
                placeholder="הוסף כתובת חד-פעמית לעותק (CC)…"
                className="h-9 text-start text-xs flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleAddOneTimeCc}
                disabled={!extraCcInput.trim()}
              >
                <Plus className="size-3.5" /> הוסף
              </Button>
            </div>

            {ccError ? (
              <p role="alert" className="text-xs font-medium text-red-600">
                {ccError}
              </p>
            ) : null}
          </div>

          <Field label="הודעה ללקוח (אופציונלי)" htmlFor="quote-email-message">
            <Textarea
              id="quote-email-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="הודעה קצרה ללקוח"
            />
          </Field>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Paperclip className="size-4 shrink-0" />
            <span>קובץ מצורף: הצעת-מחיר-{quote?.quote_number}.pdf (PDF)</span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
