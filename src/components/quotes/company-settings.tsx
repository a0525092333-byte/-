import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { useCompanySettings } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { ImageUpload } from "@/components/image-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { SectionCard } from "@/components/shared";
import { DEFAULT_TERMS } from "@/lib/quotes";
import {
  fetchPaperlessStatus,
  probePaperlessConnection,
  savePaperlessConfig,
  type PaperlessStatusResponse,
} from "@/lib/paperless";

export function CompanyQuoteSettings({ canEdit }: { canEdit: boolean }) {
  const settingsQ = useCompanySettings(true);
  const [companyName, setCompanyName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [taxId, setTaxId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vatRate, setVatRate] = useState("18");
  const [termsText, setTermsText] = useState(DEFAULT_TERMS.join("\n"));
  const [notes, setNotes] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pStatus, setPStatus] = useState<PaperlessStatusResponse | null>(null);
  const [pEnv, setPEnv] = useState<"production" | "sandbox">("production");
  const [pBaseUrl, setPBaseUrl] = useState("https://api.paperless.tax");
  const [pPath, setPPath] = useState("/api/invoices/wordpress");
  const [pApiKey, setPApiKey] = useState("");
  const [pBusy, setPBusy] = useState(false);
  const [pMessage, setPMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const settings = settingsQ.data;
    if (!settings) return;
    setCompanyName(settings.company_name ?? "");
    setLogoUrl(settings.logo_url ?? "");
    setTaxId(settings.tax_id ?? "");
    setAddress(settings.address ?? "");
    setPhone(settings.phone ?? "");
    setEmail(settings.email ?? "");
    setVatRate(String(settings.default_vat_rate ?? 18));
    setTermsText(
      settings.default_terms_text ??
        (Array.isArray(settings.default_terms) && settings.default_terms.length
          ? settings.default_terms
          : DEFAULT_TERMS
        ).join("\n"),
    );
    setNotes(settings.default_notes ?? "");
    setPrefix(settings.quote_number_prefix ?? "");
  }, [settingsQ.data]);

  useEffect(() => {
    if (!canEdit) return;
    fetchPaperlessStatus()
      .then((res) => {
        setPStatus(res);
        setPEnv(res.environment === "sandbox" ? "sandbox" : "production");
        if (res.baseUrl) setPBaseUrl(res.baseUrl);
        if (res.documentPath) setPPath(res.documentPath);
      })
      .catch(() => {});
  }, [canEdit]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setError(null);
    if (!companyName.trim()) {
      setError("נא להזין שם חברה.");
      return;
    }
    setBusy(true);
    const payload = {
      id: 1,
      company_name: companyName.trim(),
      logo_url: logoUrl || null,
      tax_id: taxId.trim() || null,
      address: address.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      default_vat_rate: Number(vatRate) || 0,
      default_terms: termsText.split(/\r?\n/).map((term) => term.trim()).filter(Boolean),
      default_terms_text: termsText.trim() || null,
      default_notes: notes.trim() || null,
      quote_number_prefix: prefix.trim(),
    };
    const { error: dbError } = await db.from("company_settings").upsert(payload);
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשמור את פרטי החברה. נסה שוב.");
      return;
    }
    toast.success("פרטי החברה עודכנו");
    settingsQ.refetch();
  }

  async function handleSavePaperless(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setPBusy(true);
    setPMessage(null);
    try {
      const updated = await savePaperlessConfig({
        apiKey: pApiKey.trim() || undefined,
        environment: pEnv,
        baseUrl: pBaseUrl.trim(),
        documentPath: pPath.trim(),
      });
      setPStatus(updated);
      setPApiKey("");
      toast.success("הגדרות Paperless נשמרו בהצלחה");
      setPMessage({
        ok: updated.ready,
        text: updated.ready
          ? "החיבור ל-Paperless מוכן להפקת מסמכים"
          : updated.keyPresent
            ? "ההגדרות נשמרו — לחץ על בדיקת חיבור לאימות מול השרת"
            : "נא להזין מפתח API של Paperless ולשמור",
      });
    } catch (err) {
      setPMessage({ ok: false, text: err instanceof Error ? err.message : "שמירת ההגדרות נכשלה" });
    } finally {
      setPBusy(false);
    }
  }

  async function handleProbePaperless() {
    setPBusy(true);
    setPMessage(null);
    try {
      if (pApiKey.trim()) {
        const saved = await savePaperlessConfig({
          apiKey: pApiKey.trim(),
          environment: pEnv,
          baseUrl: pBaseUrl.trim(),
          documentPath: pPath.trim(),
        });
        setPStatus(saved);
        setPApiKey("");
      }
      const res = await probePaperlessConnection();
      setPMessage({ ok: res.ok, text: res.message });
      if (res.ok) toast.success("החיבור ל-Paperless תקין!");
      else toast.error(res.message);
    } catch (err) {
      setPMessage({ ok: false, text: err instanceof Error ? err.message : "בדיקת החיבור נכשלה" });
    } finally {
      setPBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <SectionCard title="פרטי החברה להצעת מחיר" description="הפרטים שיודפסו בכותרת ההצעה">
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="שם החברה" htmlFor="company-name">
              <Input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} disabled={!canEdit} className="h-11" />
            </Field>
            <Field label="ח.פ / ע.מ" htmlFor="company-tax">
              <Input id="company-tax" value={taxId} onChange={(e) => setTaxId(e.target.value)} disabled={!canEdit} className="h-11" />
            </Field>
            <Field label="כתובת" htmlFor="company-address">
              <Input id="company-address" value={address} onChange={(e) => setAddress(e.target.value)} disabled={!canEdit} className="h-11" />
            </Field>
            <Field label="טלפון" htmlFor="company-phone">
              <Input id="company-phone" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!canEdit} dir="ltr" className="h-11 text-start" />
            </Field>
            <Field label="אימייל" htmlFor="company-email">
              <Input id="company-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!canEdit} dir="ltr" className="h-11 text-start" />
            </Field>
            <Field label="מע״מ ברירת מחדל %" htmlFor="company-vat">
              <Input id="company-vat" type="number" min="0" step="0.01" value={vatRate} onChange={(e) => setVatRate(e.target.value)} disabled={!canEdit} className="h-11" />
            </Field>
            <Field label="קידומת מספר הצעה" htmlFor="company-prefix">
              <Input id="company-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} disabled={!canEdit} placeholder="לדוגמה: Q-" className="h-11" />
            </Field>
          </div>
          <Field label="לוגו" htmlFor="company-logo">
            {canEdit ? (
              <ImageUpload value={logoUrl} onChange={setLogoUrl} label="העלאת לוגו" />
            ) : logoUrl ? (
              <img src={logoUrl} alt="" className="h-20 w-auto rounded border object-contain" />
            ) : (
              <p className="text-sm text-muted-foreground">לא הוגדר לוגו.</p>
            )}
          </Field>
          <Field label="תנאי הסכם ברירת מחדל" htmlFor="company-terms" hint="שורה אחת לכל תנאי">
            <Textarea id="company-terms" value={termsText} onChange={(e) => setTermsText(e.target.value)} disabled={!canEdit} className="min-h-32" />
          </Field>
          <Field label="הערות ברירת מחדל" htmlFor="company-notes" hint="כל שורה תודפס כנקודה">
            <Textarea id="company-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canEdit} className="min-h-24" />
          </Field>
          {error ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}
          {canEdit ? (
            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>{busy ? "שומר…" : "שמירת פרטי החברה"}</Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">רק מנהל או מי שיש לו הרשאת עריכה להצעות מחיר יכול לשנות את פרטי החברה.</p>
          )}
        </form>
      </SectionCard>

      {canEdit ? (
        <SectionCard
          title="חיבור ל-Paperless (הפקת חשבוניות וקבלות)"
          description="הגדרת מפתח API ובדיקת תקשורת מול api.paperless.tax"
        >
          <form onSubmit={handleSavePaperless} className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-medium ${
                  pStatus?.keyPresent
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                {pStatus?.keyPresent ? <CheckCircle2 className="size-3.5" /> : <KeyRound className="size-3.5" />}
                {pStatus?.keyPresent ? "מפתח API מוגדר במערכת" : "טרם הוגדר מפתח API"}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="מפתח API של Paperless"
                htmlFor="paperless-api-key"
                hint={pStatus?.keyPresent ? "השאר ריק כדי לשמור על המפתח הקיים" : "הדבק את מפתח ה-API מחשבון Paperless שלך"}
              >
                <Input
                  id="paperless-api-key"
                  type="password"
                  dir="ltr"
                  value={pApiKey}
                  onChange={(e) => setPApiKey(e.target.value)}
                  placeholder={pStatus?.keyPresent ? "••••••••••••••••" : "הדבק מפתח API"}
                  className="h-11 text-start"
                />
              </Field>
              <Field label="סביבת עבודה" htmlFor="paperless-env">
                <Select
                  id="paperless-env"
                  value={pEnv}
                  onChange={(e) => setPEnv(e.target.value as "production" | "sandbox")}
                >
                  <option value="production">אמיתית / ייצור (Production)</option>
                  <option value="sandbox">בדיקות (Sandbox — חוסם הנפקה אמיתית)</option>
                </Select>
              </Field>
              <Field label="כתובת שרת Paperless" htmlFor="paperless-base-url">
                <Input
                  id="paperless-base-url"
                  dir="ltr"
                  value={pBaseUrl}
                  onChange={(e) => setPBaseUrl(e.target.value)}
                  className="h-11 text-start"
                />
              </Field>
              <Field label="נתיב API להפקת מסמך" htmlFor="paperless-path">
                <Input
                  id="paperless-path"
                  dir="ltr"
                  value={pPath}
                  onChange={(e) => setPPath(e.target.value)}
                  className="h-11 text-start"
                />
              </Field>
            </div>

            {pMessage ? (
              <p
                role="status"
                className={`rounded-lg border px-3 py-2 text-sm ${
                  pMessage.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {pMessage.text}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleProbePaperless} disabled={pBusy}>
                <PlugZap className="size-4" /> {pBusy ? "בודק…" : "בדיקת חיבור"}
              </Button>
              <Button type="submit" disabled={pBusy}>
                {pBusy ? "שומר…" : "שמירת הגדרות Paperless"}
              </Button>
            </div>
          </form>
        </SectionCard>
      ) : null}
    </div>
  );
}
