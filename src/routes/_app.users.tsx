import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, History, KeyRound, Mail, MailPlus, Search, Settings, UserCog, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useAllPermissions, useInvites, usePasswordResets, useProfiles } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { sendInviteEmail } from "@/lib/invites";
import { sendTestEmail } from "@/lib/password-reset";
import { MODULES, ROLE_LABELS, ROLE_OPTIONS, presetRows } from "@/lib/permissions";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton } from "@/components/shared";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field, Select, Switch, Checkbox } from "@/components/ui/controls";
import { Avatar } from "@/components/shared";
import { PasswordResetDialog } from "@/components/users/password-reset-dialog";
import { UserCalendarPreview } from "@/components/users/user-calendar-preview";
import { RolePermissionReset, useSecurityAccess } from "@/components/users/role-permission-reset";
import { Dialog } from "@/components/ui/overlay";
import { passwordResetContent } from "@/content/users";
import type { Invite, Module, Profile, Role, UserPermission } from "@/lib/types";

export const Route = createFileRoute("/_app/users")({ component: UsersPage });

function HourlyRateField({ profile, onSave }: { profile: Profile; onSave: (value: number | null) => Promise<void> }) {
  const [value, setValue] = useState(profile.hourly_rate != null ? String(profile.hourly_rate) : "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(profile.hourly_rate != null ? String(profile.hourly_rate) : "");
  }, [profile.hourly_rate]);

  async function save() {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast.error("העלות השעתית חייבת להיות מספר חיובי");
      return;
    }
    setSaving(true);
    await onSave(parsed);
    setSaving(false);
  }

  return (
    <div>
      <label htmlFor={`rate-${profile.id}`} className="mb-1 block text-xs font-medium text-muted-foreground">
        עלות שעתית (₪)
      </label>
      <div className="flex gap-2">
        <Input
          id={`rate-${profile.id}`}
          type="number"
          min="0"
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="לא הוגדר"
          className="h-11"
        />
        <Button type="button" variant="outline" className="h-11 shrink-0" onClick={save} disabled={saving}>
          {saving ? "שומר…" : "שמירה"}
        </Button>
      </div>
    </div>
  );
}

function UsersPage() {
  const { user, isSuperAdmin, effectiveRole, can } = useSession();
  const canUsers = can("users", "view");
  const canManageUsers = can("users", "edit");
  const securityAccess = useSecurityAccess();
  const canManagePermissions = canManageUsers && securityAccess.canReset;
  const profilesQ = useProfiles(canUsers);
  const permsQ = useAllPermissions(canUsers);
  const invitesQ = useInvites(canUsers);
  const resetsQ = usePasswordResets(canUsers);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("sales");
  const [invitePermissions, setInvitePermissions] = useState(() => presetRows("sales"));
  const [inviteSaving, setInviteSaving] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<Profile | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<Profile | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const resetOpenRef = useRef(resetOpen);
  resetOpenRef.current = resetOpen;

  const profiles = profilesQ.data ?? [];
  const allPerms = permsQ.data ?? [];
  const invites = invitesQ.data ?? [];
  const resets = resetsQ.data ?? [];
  const pendingProfiles = profiles.filter((profile) => profile.approval_status === "pending");
  const pendingInvitesCount = invites.filter((invite) => invite.status === "pending").length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => `${p.full_name} ${p.email} ${ROLE_LABELS[p.role] ?? ""}`.toLowerCase().includes(q));
  }, [profiles, search]);

  if (!canUsers) return <NoAccess moduleLabel="ניהול המשתמשים" />;
  if (profilesQ.isLoading || permsQ.isLoading) return <PageSkeleton />;
  if (profilesQ.error || permsQ.error || invitesQ.error) {
    return (
      <ErrorState
        message={((profilesQ.error || permsQ.error || invitesQ.error) as Error).message}
        onRetry={() => {
          profilesQ.refetch();
          permsQ.refetch();
          invitesQ.refetch();
        }}
      />
    );
  }

  function permsFor(userId: string): UserPermission[] {
    return allPerms.filter((p) => p.user_id === userId);
  }

  async function changeRole(profile: Profile, role: Role) {
    if (!canManagePermissions) return;
    setSaving(profile.id);
    const { error } = await db.from("profiles").update({ role }).eq("id", profile.id);
    if (error) {
      setSaving(null);
      toast.error("לא הצלחנו לעדכן את התפקיד");
      return;
    }
    const rows = presetRows(role).map((r) => ({ user_id: profile.id, ...r }));
    const { error: permError } = await db.from("user_permissions").upsert(rows);
    setSaving(null);
    if (permError) {
      toast.error("התפקיד עודכן, אבל ההרשאות לא נשמרו. נסה שוב.");
      return;
    }
    toast.success(`התפקיד של ${profile.full_name} עודכן ל${ROLE_LABELS[role]}`);
    profilesQ.refetch();
    permsQ.refetch();
  }

  async function toggleActive(profile: Profile, active: boolean) {
    if (!canManagePermissions) return;
    setSaving(profile.id);
    const { error } = await db.from("profiles").update({ is_active: active }).eq("id", profile.id);
    setSaving(null);
    if (error) {
      toast.error("לא הצלחנו לעדכן את סטטוס המשתמש");
      return;
    }
    toast.success(active ? "המשתמש הופעל" : "המשתמש הושבת");
    profilesQ.refetch();
  }

  async function setApproval(profile: Profile, status: "approved" | "pending" | "rejected") {
    if (!canManagePermissions) return;
    setSaving(profile.id);
    const { error } = await db
      .from("profiles")
      .update({
        approval_status: status,
        approved_at: status === "approved" ? new Date().toISOString() : null,
        approved_by: status === "approved" ? user?.id ?? null : null,
      })
      .eq("id", profile.id);
    setSaving(null);
    if (error) {
      toast.error("לא הצלחנו לעדכן את מצב האישור");
      return;
    }
    toast.success(
      status === "approved" ? "המשתמש אושר" : status === "rejected" ? "הבקשה נדחתה" : "המשתמש הוחזר להמתנה",
    );
    profilesQ.refetch();
  }

  async function togglePermission(profile: Profile, module: Module, action: "view" | "edit", value: boolean) {
    if (!canManagePermissions) return;
    const current = permsFor(profile.id).find((p) => p.module === module);
    const next = {
      user_id: profile.id,
      module,
      can_view: action === "view" ? value : value ? true : current?.can_view ?? false,
      can_edit: action === "edit" ? value : value ? current?.can_edit ?? false : false,
    };
    setSaving(profile.id);
    const { error } = await db.from("user_permissions").upsert(next);
    setSaving(null);
    if (error) {
      console.error("[permissions] save failed", error);
      toast.error("לא הצלחנו לעדכן את ההרשאה");
      return;
    }
    toast.success("ההרשאה עודכנה — תיכנס לתוקף בטעינה הבאה של המשתמש");
    permsQ.refetch();
  }

  function setInviteRoleState(role: Role) {
    setInviteRole(role);
    setInvitePermissions(presetRows(role));
  }

  function toggleInvitePermission(module: Module, action: "view" | "edit", value: boolean) {
    setInvitePermissions((current) => current.map((row) => row.module === module
      ? { ...row, can_view: action === "view" ? value : value ? true : row.can_view, can_edit: action === "edit" ? value : value ? row.can_edit : false }
      : row));
  }

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!canManagePermissions) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("נא להזין כתובת אימייל תקינה");
      return;
    }
    if (!user?.id) {
      toast.error("פג תוקף החיבור. התחבר מחדש ונסה שוב.");
      return;
    }
    setInviteSaving(true);
    const payload = {
      email,
      full_name: inviteName.trim() || null,
      role: inviteRole,
      permissions: invitePermissions,
      status: "pending",
      invited_by: user.id,
    };
    const rpcResult = await db.rpc("create_invite", {
      p_email: email,
      p_full_name: inviteName.trim() || null,
      p_role: inviteRole,
      p_permissions: invitePermissions,
    });
    let error = rpcResult.error;
    let createdId = (rpcResult.data as Invite | null)?.id ?? null;
    if (error && (error.code === "PGRST202" || /could not find the function|not found/i.test(error.message))) {
      const fallback = await db.from<{ id: string }[]>("invites").insert(payload).select("id");
      error = fallback.error;
      createdId = fallback.data?.[0]?.id ?? null;
    }
    setInviteSaving(false);
    if (error) {
      const message = error.message.toLowerCase();
      const hebrewMessage = /[\u0590-\u05FF]/.test(error.message) ? error.message : null;
      toast.error(
        error.code === "42501" || message.includes("row-level security")
          ? hebrewMessage || "אין הרשאה ליצור הזמנה. ודא שאתה מחובר כמנהל ונסה שוב."
          : message.includes("unique")
            ? "כבר קיימת הזמנה ממתינה לאימייל הזה"
            : "לא הצלחנו ליצור את ההזמנה. נסה שוב.",
      );
      return;
    }
    setInviteEmail("");
    setInviteName("");
    setInviteRoleState("sales");
    let sent = false;
    if (createdId) {
      const send = await sendInviteEmail(createdId);
      sent = send.ok;
      if (!send.ok) toast.error(send.message);
    }
    toast.success(sent ? "ההזמנה נוצרה ונשלחה למייל" : "ההזמנה נוצרה. אפשר לשלוח אותה מהרשימה.");
    invitesQ.refetch();
  }

  async function resendInvite(id: string) {
    setSending(id);
    const result = await sendInviteEmail(id);
    setSending(null);
    if (result.ok) toast.success("ההזמנה נשלחה שוב");
    else toast.error(result.message);
    invitesQ.refetch();
  }

  async function testEmail() {
    setTestBusy(true);
    const result = await sendTestEmail();
    setTestBusy(false);
    if (result.ok) toast.success(passwordResetContent.testSent);
    else toast.error(`${passwordResetContent.testFailed}: ${result.message}`);
  }

  async function changeHourlyRate(profile: Profile, value: number | null) {
    const { error } = await db.from("profiles").update({ hourly_rate: value }).eq("id", profile.id);
    if (error) {
      toast.error("לא הצלחנו לעדכן את העלות השעתית");
      return;
    }
    toast.success("העלות השעתית עודכנה");
    profilesQ.refetch();
  }

  async function copyInviteLink(email: string) {
    const link = `${window.location.origin}/login?invite=${encodeURIComponent(email)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("קישור ההרשמה הועתק");
    } catch {
      toast.error(`לא ניתן להעתיק אוטומטית. העתק ידנית: ${link}`);
    }
  }

  async function cancelInvite(id: string) {
    const { error } = await db.from("invites").update({ status: "cancelled" }).eq("id", id);
    if (error) {
      toast.error("לא הצלחנו לבטל את ההזמנה");
      return;
    }
    toast.success("ההזמנה בוטלה");
    invitesQ.refetch();
  }

  return (
    <div>
      <PageHeader
        title="ניהול משתמשים"
        description="תפקידים, הרשאות מודולים והפעלת חשבונות"
      />

      <RolePermissionReset />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button type="button" className="w-full sm:w-auto" onClick={() => setInviteOpen(true)}>
          <MailPlus className="size-4" />
          הזמנת משתמש חדש
        </Button>
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setInvitesOpen(true)}>
          <Mail className="size-4" />
          הזמנות ממתינות
          {pendingInvitesCount > 0 ? (
            <span className="ms-1 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
              {pendingInvitesCount}
            </span>
          ) : null}
        </Button>
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setTestOpen(true)}>
          <Mail className="size-4" />
          בדיקת שליחה
        </Button>
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setHistoryOpen(true)}>
          <History className="size-4" />
          היסטוריית איפוסים
        </Button>
      </div>

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש לפי שם, אימייל או תפקיד"
          className="h-11 pe-9"
          aria-label="חיפוש משתמשים"
        />
      </div>

      {!filtered.length ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState icon={UserCog} title="לא נמצאו משתמשים" description="נסה מונח חיפוש אחר." />
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((profile) => {
            const isMe = profile.id === user?.id;
            const displayRole = isMe ? effectiveRole : profile.role;
            const statusLabel = !profile.is_active
              ? "מושבת"
              : profile.approval_status === "approved"
                ? "פעיל"
                : profile.approval_status === "rejected"
                  ? "נדחה"
                  : "ממתין";
            const statusTone = !profile.is_active
              ? "bg-muted text-muted-foreground"
              : profile.approval_status === "approved"
                ? "bg-emerald-100 text-emerald-800"
                : profile.approval_status === "rejected"
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-800";
            return (
              <div
                key={profile.id}
                role="button"
                tabIndex={0}
                onClick={() => setSettingsTarget(profile)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSettingsTarget(profile);
                  }
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                <Avatar name={profile.full_name} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile.full_name}
                    {isMe ? <span className="ms-1 text-[10px] text-muted-foreground">(אתה)</span> : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground" dir="ltr">{profile.email}</p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {ROLE_LABELS[displayRole] ?? displayRole}
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>
                  {statusLabel}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSettingsTarget(profile);
                  }}
                >
                  <Settings className="size-4" />
                  הגדרות
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="הזמנת משתמש חדש"
        description="המשתמש יירשם בעצמו, וההרשאות יוחלו אוטומטית לאחר ההרשמה."
        size="lg"
      >
        <form onSubmit={createInvite} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="אימייל *" htmlFor="invite-email" hint="זהה לאימייל שבו המשתמש יירשם">
              <Input id="invite-email" type="email" dir="ltr" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@company.co.il" className="h-11 text-start" required />
            </Field>
            <Field label="שם מלא (אופציונלי)" htmlFor="invite-name">
              <Input id="invite-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="לדוגמה: דנה לוי" className="h-11" />
            </Field>
            <Field label="תפקיד" htmlFor="invite-role">
              <Select id="invite-role" value={inviteRole} onChange={(e) => setInviteRoleState(e.target.value as Role)}>
                {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">הרשאות מודולים</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border bg-muted/40 text-muted-foreground"><th className="px-3 py-2 text-start font-medium">מודול</th><th className="px-3 py-2 text-center font-medium">צפייה</th><th className="px-3 py-2 text-center font-medium">עריכה</th></tr></thead>
                <tbody className="divide-y divide-border/60">
                  {MODULES.map((module) => {
                    const row = invitePermissions.find((permission) => permission.module === module.key)!;
                    return <tr key={module.key}><td className="px-3 py-2"><p className="font-medium text-foreground">{module.label}</p><p className="text-[10px] text-muted-foreground">{module.description}</p></td><td className="px-3 py-2 text-center"><div className="flex justify-center"><Checkbox checked={row.can_view} onCheckedChange={(value) => toggleInvitePermission(module.key, "view", value)} label={`צפייה ב${module.label} בהזמנה`} /></div></td><td className="px-3 py-2 text-center"><div className="flex justify-center"><Checkbox checked={row.can_edit} onCheckedChange={(value) => toggleInvitePermission(module.key, "edit", value)} label={`עריכה ב${module.label} בהזמנה`} /></div></td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>ההזמנה נשלחת למייל של המשתמש. אם שליחת הדוא״ל אינה מוגדרת במערכת, אפשר להעתיק את קישור ההרשמה מהרשימה ולשלוח אותו ידנית. לאחר הרשמה עם אותו אימייל, התפקיד וההרשאות יוחלו ללא פעולה נוספת.</p>
            <Button type="submit" className="h-11 shrink-0" disabled={inviteSaving || !canManagePermissions}>{inviteSaving ? "יוצר הזמנה…" : "יצירת הזמנה"}<MailPlus className="size-4" /></Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={invitesOpen}
        onOpenChange={setInvitesOpen}
        title="הזמנות ממתינות"
        description="הזמנות שטרם מומשו באמצעות הרשמה."
        size="lg"
      >
        {!invites.length ? (
          <p className="py-5 text-sm text-muted-foreground">אין כרגע הזמנות ממתינות.</p>
        ) : (
          <div className="space-y-2">
            {invites.map((invite) => {
              const state =
                invite.status === "accepted"
                  ? "אושר"
                  : invite.status === "cancelled"
                    ? "בוטל"
                    : invite.last_send_error
                      ? "שליחה נכשלה"
                      : invite.last_sent_at
                        ? "נשלח"
                        : "ממתין לאישור";
              const tone =
                invite.status === "accepted"
                  ? "bg-emerald-100 text-emerald-800"
                  : invite.status === "cancelled"
                    ? "bg-muted text-muted-foreground"
                    : invite.last_send_error
                      ? "bg-red-100 text-red-700"
                      : invite.last_sent_at
                        ? "bg-sky-100 text-sky-800"
                        : "bg-amber-100 text-amber-800";
              return (
                <div key={invite.id} className="flex flex-col gap-3 rounded-lg border border-border/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground" dir="ltr">{invite.email}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{state}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ROLE_LABELS[invite.role]} · {new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" }).format(new Date(invite.created_at))}
                    </p>
                    {invite.last_send_error ? <p className="mt-1 text-xs text-red-700">{invite.last_send_error}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => copyInviteLink(invite.email)}>
                      <Copy className="size-4" />העתקת קישור
                    </Button>
                    {invite.status === "pending" ? (
                      <Button type="button" variant="outline" size="sm" disabled={sending === invite.id} onClick={() => resendInvite(invite.id)}>
                        <MailPlus className="size-4" /> {sending === invite.id ? "שולח..." : "שלח הזמנה שוב"}
                      </Button>
                    ) : null}
                    {invite.status === "pending" ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => cancelInvite(invite.id)}>
                        <X className="size-4" />ביטול
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Dialog>

      <Dialog
        open={testOpen}
        onOpenChange={setTestOpen}
        title={passwordResetContent.emailTestTitle}
        description={passwordResetContent.emailTestDescription}
        size="sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={testEmail} disabled={testBusy}>
            <Mail className="size-4" /> {testBusy ? passwordResetContent.sendingTest : passwordResetContent.testSend}
          </Button>
          <span className="text-xs text-muted-foreground" dir="ltr">{profiles.find((p) => p.id === user?.id)?.email}</span>
        </div>
      </Dialog>

      <Dialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title={passwordResetContent.auditTitle}
        description="מי איפס למי ומתי — ללא הסיסמה"
        size="lg"
      >
        {!resets.length ? (
          <p className="py-5 text-sm text-muted-foreground">{passwordResetContent.auditEmpty}</p>
        ) : (
          <div className="space-y-2">
            {resets.map((row) => {
              const admin = profiles.find((p) => p.id === row.admin_id);
              const target = profiles.find((p) => p.id === row.target_user_id);
              const adminName = admin?.full_name || admin?.email || "מנהל";
              const targetName = target?.full_name || row.target_email || "משתמש";
              const when = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" }).format(
                new Date(row.created_at),
              );
              return (
                <p key={row.id} className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                  {passwordResetContent.auditLine(adminName, targetName, when)}
                </p>
              );
            })}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!settingsTarget}
        onOpenChange={(v) => {
          if (!v && resetOpenRef.current) return;
          if (!v) setSettingsTarget(null);
        }}
        title={settingsTarget?.full_name ?? "הגדרות משתמש"}
        description={settingsTarget?.email}
        size="lg"
      >
        {settingsTarget ? (() => {
          const profile = settingsTarget;
          const perms = permsFor(profile.id);
          const isMe = profile.id === user?.id;
          const displayRole = isMe ? effectiveRole : profile.role;
          return (
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={profile.full_name} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{profile.full_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{ROLE_LABELS[displayRole] ?? displayRole}</p>
                    </div>
                  </div>
                  <div>
                    <label htmlFor={`role-${profile.id}`} className="mb-1 block text-xs font-medium text-muted-foreground">תפקיד</label>
                    <Select id={`role-${profile.id}`} value={displayRole} onChange={(e) => changeRole(profile, e.target.value as Role)} disabled={saving === profile.id || isMe || !canManagePermissions} className="h-11 text-sm">
                      {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </Select>
                  </div>
                  <div>
                    <label htmlFor={`approval-${profile.id}`} className="mb-1 block text-xs font-medium text-muted-foreground">מצב אישור</label>
                    <Select id={`approval-${profile.id}`} value={profile.approval_status} onChange={(e) => setApproval(profile, e.target.value as "approved" | "pending" | "rejected")} disabled={saving === profile.id || isMe || !canManagePermissions} className="h-11 text-sm">
                      <option value="approved">מאושר</option>
                      <option value="pending">ממתין לאישור</option>
                      <option value="rejected">נדחה</option>
                    </Select>
                  </div>
                  <HourlyRateField profile={profile} onSave={(value) => changeHourlyRate(profile, value)} />
                  {profile.phone ? <p className="text-xs text-muted-foreground" dir="ltr">{profile.phone}</p> : null}
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">חשבון פעיל</span>
                    <Switch checked={profile.is_active} onCheckedChange={(v) => toggleActive(profile, v)} disabled={saving === profile.id || isMe || !canManagePermissions} label={`הפעלת ${profile.full_name}`} />
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">הרשאות מודולים</p>
                  <p className="mb-2 text-[11px] text-muted-foreground">שורת החיפוש מופיעה רק למי שמסומן כאן.</p>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                          <th className="px-3 py-2 text-start font-medium">מודול</th>
                          <th className="px-3 py-2 text-center font-medium">צפייה</th>
                          <th className="px-3 py-2 text-center font-medium">עריכה</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {MODULES.map((m) => {
                          const row = perms.find((p) => p.module === m.key);
                          const canView = (isMe && isSuperAdmin) || (row?.can_view ?? false);
                          const canEdit = (isMe && isSuperAdmin) || (row?.can_edit ?? false);
                          return (
                            <tr key={m.key}>
                              <td className="px-3 py-2">
                                <p className="font-medium text-foreground">{m.label}</p>
                                <p className="text-[10px] text-muted-foreground">{m.description}</p>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <div className="flex justify-center">
                                  <Checkbox checked={canView} onCheckedChange={(v) => togglePermission(profile, m.key, "view", v)} disabled={saving === profile.id || isMe || !canManagePermissions} label={`צפייה ב${m.label} עבור ${profile.full_name}`} />
                                </div>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <div className="flex justify-center">
                                  <Checkbox checked={canEdit} onCheckedChange={(v) => togglePermission(profile, m.key, "edit", v)} disabled={saving === profile.id || isMe || !canManagePermissions} label={`עריכה ב${m.label} עבור ${profile.full_name}`} />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <UserCalendarPreview profile={profile} />
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-foreground">איפוס סיסמה</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  יצירת סיסמה זמנית חדשה למשתמש. הסיסמה תוצג לאחר האיפוס וניתן להעתיק אותה או לשלוח אותה במייל.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  onClick={() => {
                    setResetTarget(profile);
                    setResetOpen(true);
                  }}
                >
                  <KeyRound className="size-4" />
                  {passwordResetContent.button}
                </Button>
              </div>
            </div>
          );
        })() : null}
      </Dialog>

      <PasswordResetDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        profile={resetTarget}
        isSelf={resetTarget?.id === user?.id}
        onDone={() => resetsQ.refetch()}
      />
    </div>
  );
}
