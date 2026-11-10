import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { dataApiToken } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { num } from "@/lib/format";
import { notifyDataChanged } from "@/lib/data-events";

type SampleRow = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
};
type SampleGroup = { key: string; rows: SampleRow[] };
type Preview = { totalClients: number; groups: number; sample: SampleGroup[] };
type MergeResult = { merged: number; remaining: number; backupId: string | null; message?: string };

export function MergeDuplicatesDialog({
  open,
  onOpenChange,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMerged: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    setResult(null);
    (async () => {
      try {
        const token = await dataApiToken();
        const res = await fetch("/api/clients/merge-duplicates", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ confirm: false }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          setError(data?.message || "לא הצלחנו לבדוק כפילויות. נסה שוב.");
          return;
        }
        setPreview({
          totalClients: Number(data.totalClients) || 0,
          groups: Number(data.groups) || 0,
          sample: Array.isArray(data.sample) ? data.sample : [],
        });
      } catch {
        setError("לא הצלחנו להתחבר לשרת — נסה שוב.");
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  async function confirmMerge() {
    setConfirming(true);
    setError(null);
    try {
      const token = await dataApiToken();
      const res = await fetch("/api/clients/merge-duplicates", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(data?.message || "האיחוד נכשל — לא נשמרו שינויים.");
        return;
      }
      setResult({
        merged: Number(data.merged) || 0,
        remaining: Number(data.remaining) || 0,
        backupId: data.backupId ?? null,
        message: data.message,
      });
      notifyDataChanged("clients");
      onMerged();
    } catch {
      setError("לא הצלחנו להתחבר לשרת — נסה שוב.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="איחוד כפילויות לקוחות"
      description="מאחד רשומות כפולות של אותו לקוח ומעביר אליהן את האירועים וההצעות"
      size="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
            {result ? "סגירה" : "ביטול"}
          </Button>
          {!result && preview && preview.groups > 0 ? (
            <Button type="button" className="w-full sm:w-auto" onClick={confirmMerge} disabled={confirming || loading}>
              {confirming ? "מאחד…" : `איחוד ${num(preview.groups)} קבוצות`}
            </Button>
          ) : null}
        </div>
      }
    >
      {loading ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
          <Loader2 className="size-7 animate-spin text-primary" />
          <p className="text-sm">בודק כפילויות…</p>
        </div>
      ) : error ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : result ? (
        <div className="rounded-2xl border border-border bg-card p-5 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
            <CheckCircle2 className="size-6" aria-hidden="true" />
          </div>
          <p className="text-lg font-bold text-foreground">
            {result.merged > 0 ? `אוחדו ${num(result.merged)} כפילויות` : "לא נמצאו כפילויות לאיחוד"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            נותרו {num(result.remaining)} לקוחות{result.backupId ? " · גיבוי נשמר" : ""}
          </p>
        </div>
      ) : preview ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-muted/50 p-3 text-sm">
            <p className="font-medium text-foreground">
              נמצאו {num(preview.groups)} קבוצות כפילויות מתוך {num(preview.totalClients)} לקוחות
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              לא יאוחדו לקוחות שונים בעלי אותו שם אך טלפון שונה. לפני האיחוד נשמר גיבוי מלא.
            </p>
          </div>
          {preview.groups === 0 ? (
            <p className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              אין כפילויות לאיחוד — הנתונים נקיים.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">דוגמה ל-{num(preview.sample.length)} קבוצות:</p>
              {preview.sample.map((group) => (
                <div key={group.key} className="rounded-xl border border-border p-3">
                  <p className="mb-2 text-sm font-medium text-foreground">{group.rows[0]?.name || group.key}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="px-2 py-1 text-start font-medium">שם</th>
                          <th className="px-2 py-1 text-start font-medium">איש קשר</th>
                          <th className="px-2 py-1 text-start font-medium">טלפון</th>
                          <th className="px-2 py-1 text-start font-medium">אימייל</th>
                          <th className="px-2 py-1 text-start font-medium">חברה</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {group.rows.map((row) => (
                          <tr key={row.id}>
                            <td className="px-2 py-1 text-foreground">{row.name || "—"}</td>
                            <td className="px-2 py-1 text-muted-foreground">{row.contact_name || "—"}</td>
                            <td className="px-2 py-1 text-muted-foreground" dir="ltr">{row.phone || "—"}</td>
                            <td className="px-2 py-1 text-muted-foreground" dir="ltr">{row.email || "—"}</td>
                            <td className="px-2 py-1 text-muted-foreground">{row.company || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
