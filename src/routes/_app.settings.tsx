import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, LogOut, Mail, Phone, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { signOut } from "@/integrations/neon/auth";
import { db } from "@/integrations/neon/client";
import { MODULES, ROLE_LABELS } from "@/lib/permissions";
import { PageHeader, SectionCard, Avatar } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/controls";
import { CompanyQuoteSettings } from "@/components/quotes/company-settings";
import { AuditViewer } from "@/components/settings/audit-viewer";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

function SettingsPage() {
  const { user, profile, perms, isSuperAdmin, effectiveRole, can, refetchProfile } = useSession();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setFullName(profile.full_name ?? "");
      setPhone(profile.phone ?? "");
    }
  }, [profile]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!fullName.trim()) {
      setError("נא להזין שם מלא.");
      return;
    }
    if (!profile) return;
    setBusy(true);
    const { error: dbError } = await db
      .from("profiles")
      .update({ full_name: fullName.trim(), phone: phone.trim() || null })
      .eq("id", profile.id);
    setBusy(false);
    if (dbError) {
      setError("לא הצלחנו לשמור את הפרופיל. נסה שוב.");
      return;
    }
    toast.success("הפרופיל עודכן");
    refetchProfile();
  }

  async function logout() {
    await signOut();
      navigate({ to: "/login", search: { invite: undefined } });
  }

  if (!profile) return null;

  return (
    <div>
      <PageHeader title="הפרופיל שלי" description="פרטים אישיים וההרשאות שלך במערכת" />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <SectionCard title="פרטים אישיים" description="השם והטלפון מוצגים לחברי הצוות">
            <form onSubmit={save} className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3">
                <Avatar name={profile.full_name} className="size-12 text-sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{profile.full_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{ROLE_LABELS[effectiveRole] ?? effectiveRole}</p>
                </div>
              </div>
              <Field label="שם מלא" htmlFor="settings-name">
                <div className="relative">
                  <UserRound className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="settings-name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-11 pe-9" />
                </div>
              </Field>
              <Field label="טלפון" htmlFor="settings-phone">
                <div className="relative">
                  <Phone className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="settings-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" dir="ltr" className="h-11 ps-9 text-start" />
                </div>
              </Field>
              <Field label="כתובת אימייל" htmlFor="settings-email" hint="לא ניתן לשנות את כתובת האימייל">
                <div className="relative">
                  <Mail className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="settings-email" value={profile.email} readOnly dir="ltr" className="h-11 bg-muted ps-9 text-start" />
                </div>
              </Field>
              {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>{busy ? "שומר…" : "שמירת שינויים"}</Button>
              </div>
            </form>
          </SectionCard>

          <SectionCard title="ההרשאות שלי" description="מה המנהל אישר לך לגשת אליו">
            <ul className="divide-y divide-border/60">
              {MODULES.map((m) => {
                const row = perms.find((p) => p.module === m.key);
                const view = isSuperAdmin || !!row?.can_view;
                const edit = isSuperAdmin || !!row?.can_edit;
                return (
                  <li key={m.key} className="flex items-center justify-between gap-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-foreground">{m.label}</p>
                      <p className="text-xs text-muted-foreground">{m.description}</p>
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                        edit
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : view
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {edit ? "צפייה ועריכה" : view ? "צפייה בלבד" : "אין גישה"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="החשבון" description="פרטי התחברות">
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="size-4" />
                <span dir="ltr" className="truncate">{profile.email}</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <ShieldCheck className="size-4" />
                <span>תפקיד: {ROLE_LABELS[effectiveRole] ?? effectiveRole}</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <UserRound className="size-4" />
                <span>סטטוס: {profile.is_active ? "פעיל" : "מושבת"}</span>
              </div>
            </div>
            <Button type="button" variant="outline" className="mt-4 w-full" onClick={logout}>
              <LogOut className="size-4" />
              התנתקות
            </Button>
          </SectionCard>

          <SectionCard title="צריך הרשאה נוספת?" description="פנייה למנהל המערכת">
            <p className="text-sm leading-relaxed text-muted-foreground">
              רק מנהל המערכת יכול לשנות תפקידים והרשאות. אם חסר לך מודול בעבודה היומיומית, פנה אליו והוא יעדכן את
              ההרשאות שלך.
            </p>
          </SectionCard>
        </div>
      </div>

      <div className="mt-5">
        <CompanyQuoteSettings canEdit={can("quotes", "edit")} />
      </div>

      <AuditViewer />

      {can("backup", "view") ? (
        <div className="mt-5">
          <SectionCard title="גיבוי ושחזור" description="ייצוא, שחזור וגיבוי אוטומטי של נתוני העסק">
            <Button asChild variant="outline">
              <Link to="/backup">
                <Archive className="size-4" /> פתיחת מסך הגיבוי
              </Link>
            </Button>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
