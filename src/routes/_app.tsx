import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Loader2, LogOut, ShieldAlert, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useAutoBackup } from "@/hooks/use-auto-backup";
import { signOut } from "@/integrations/neon/auth";
import { dataApiToken, db } from "@/integrations/neon/client";
import { AppShell } from "@/components/app-shell";
import { ErrorState, PageSkeleton } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { site } from "@/content/site";
import { isFullScope } from "@/lib/scope";
import { canAccessPath } from "@/lib/permissions";
import { NoAccessScreen } from "@/components/require-full-scope";

export const Route = createFileRoute("/_app")({ component: AppLayout });

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-sm">טוען את המערכת…</p>
      </div>
    </div>
  );
}

function AppLayout() {
  const { user, authLoading, profile, profileLoading, profileError, permsLoading, adminLoading, superAdminLoading, isAdmin, isSuperAdmin, can, refetchProfile } =
    useSession();
  useAutoBackup();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const passwordStatusQ = useQuery({
    queryKey: ["password_status", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const token = await dataApiToken();
      const res = await fetch("/api/account/password-status", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as { mustChangePassword?: boolean; role?: string | null };
    },
    staleTime: 0,
    retry: 0,
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [fullNameState, setFullNameState] = useState("");

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { invite: undefined } });
  }, [authLoading, user, navigate]);

  // Force a password change after a temporary password. Fail-open: a missing
  // profile or a failed status check never blocks the app.
  useEffect(() => {
    if (!user) return;
    if (profile?.approval_status !== "approved" || profile?.is_active === false) return;
    if (passwordStatusQ.data?.mustChangePassword !== true) return;
    if (pathname === "/set-password") return;
    navigate({ to: "/set-password", replace: true });
  }, [user, profile, passwordStatusQ.data, pathname, navigate]);

  async function logout() {
    await signOut();
    navigate({ to: "/login", search: { invite: undefined } });
  }

  async function createProfile() {
    if (!user) return;
    setCreating(true);
    setCreateError(null);
    const fullName = (fullNameState.trim() || user.name || user.email.split("@")[0] || "משתמש חדש").trim();
    const { error } = await db.from("profiles").insert({
      id: user.id,
      email: user.email,
      full_name: fullName,
      role: "sales",
      is_active: true,
    });
    if (error) {
      setCreating(false);
      setCreateError("לא הצלחנו ליצור את הפרופיל. נסה שוב או פנה למנהל המערכת.");
      return;
    }
    await refetchProfile();
    setCreating(false);
    toast.success("הפרופיל נוצר בהצלחה");
  }

  if (authLoading) return <FullScreenLoader />;
  if (!user) return <FullScreenLoader />;
  if (profileLoading || adminLoading || superAdminLoading || permsLoading) return <FullScreenLoader />;

  if (profileError) {
    return (
      <div className="min-h-screen bg-background">
        <ErrorState message={profileError.message} onRetry={() => refetchProfile()} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
            <UserPlus className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold text-foreground">המשתמש שלך טרם הוגדר</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            החשבון שלך קיים, אבל עדיין אין לו פרופיל במערכת. אפשר ליצור פרופיל בסיסי ולהתחיל, או לפנות למנהל
            המערכת כדי שיוסיף אותך עם ההרשאות המתאימות.
          </p>
          <div className="mt-5 space-y-2 text-start">
            <label htmlFor="newFullName" className="text-sm font-medium text-foreground">
              שם מלא
            </label>
            <input
              id="newFullName"
              value={fullNameState}
              onChange={(e) => setFullNameState(e.target.value)}
              placeholder={user.name || user.email.split("@")[0]}
              className="h-11 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
            />
          </div>
          {createError ? (
            <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {createError}
            </p>
          ) : null}
          <Button type="button" className="mt-5 h-11 w-full" onClick={createProfile} disabled={creating}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : null}
            {creating ? "יוצר פרופיל…" : "יצירת פרופיל בסיסי"}
          </Button>
          <Button type="button" variant="ghost" className="mt-2 w-full" onClick={logout}>
            <LogOut className="size-4" />
            התנתקות
          </Button>
          <p className="mt-4 text-xs text-muted-foreground">{site.name} · {site.tagline}</p>
        </div>
      </div>
    );
  }

  if (!isAdmin && profile.approval_status !== "approved") {
    const rejected = profile.approval_status === "rejected";
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
          <div className={`mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl ${rejected ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}>
            <ShieldAlert className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold text-foreground">
            {rejected ? "הבקשה שלך נדחתה" : "ההרשמה שלך ממתינה לאישור מנהל"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {rejected
              ? "לפרטים פנה למנהל המערכת."
              : "החשבון נוצר בהצלחה, אך אין עדיין הרשאה להיכנס למערכת. המנהל יאשר את החשבון ובכניסה הבאה תהיה לך גישה מלאה."}
          </p>
          <div className="mt-5 space-y-2">
            {!rejected ? (
              <Button type="button" className="h-11 w-full" onClick={() => refetchProfile()}>
                בדוק שוב
              </Button>
            ) : null}
            <Button type="button" variant="outline" className="h-11 w-full" onClick={logout}>
              <LogOut className="size-4" />
              התנתק
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!profile.is_active) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <ShieldAlert className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-bold text-foreground">החשבון שלך מושבת</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            הגישה שלך למערכת הושבתה על ידי מנהל המערכת. לפרטים נוספים אפשר לפנות למנהל.
          </p>
          <Button type="button" variant="outline" className="mt-5 w-full" onClick={logout}>
            <LogOut className="size-4" />
            התנתקות
          </Button>
        </div>
      </div>
    );
  }

  const fullScope = isFullScope(profile, isAdmin);
  const blocked = fullScope
    ? !canAccessPath(pathname, can)
    : pathname === "/clients" ||
      pathname.startsWith("/clients/") ||
      pathname === "/finance" ||
      pathname.startsWith("/finance/") ||
      pathname === "/quotes" ||
      pathname.startsWith("/quotes/") ||
      pathname === "/backup" ||
      pathname.startsWith("/backup/") ||
      pathname === "/users" ||
      pathname.startsWith("/users/");

  return (
    <AppShell profile={profile} isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} can={can} onLogout={logout}>
      {blocked ? <NoAccessScreen /> : <Outlet />}
    </AppShell>
  );
}
