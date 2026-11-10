import { useEffect, useRef, useState } from "react";
import { Mail, Paperclip } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { sendQuoteEmail } from "@/lib/quote-email";
import type { Quote } from "@/lib/types";

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
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const defaultEmailRef = useRef(defaultEmail);

  useEffect(() => {
    defaultEmailRef.current = defaultEmail;
  }, [defaultEmail]);

  useEffect(() => {
    if (open) {
      setTo(defaultEmailRef.current);
      setMessage("");
      setError(null);
      setSentTo(null);
    }
  }, [open]);

  async function send() {
    if (!quote) return;
    const email = to.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("נא להזין כתובת אימייל תקינה");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendQuoteEmail(quote.id, email, message);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSentTo(result.to);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="שליחת הצעה ללקוח"
      description={quote ? `הצעת מחיר מס׳ ${quote.quote_number}` : undefined}
      footer={
        sentTo ? (
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
      {sentTo ? (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-emerald-700">ההצעה נשלחה בהצלחה</p>
          <p className="text-sm text-muted-foreground">
            נשלחה אל <span dir="ltr">{sentTo}</span> עם קובץ PDF מצורף.
          </p>
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
