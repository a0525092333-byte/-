import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, KeyRound, Loader2, LockKeyhole, LogOut } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/integrations/neon/auth";
import { dataApiToken } from "@/integrations/neon/client";
import { changeOwnPassword } from "@/lib/password-reset";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/controls";
import { site } from "@/content/site";

export const Route = createFileRoute("/set-password")({
  component: SetPasswordPage,
});

function SetPasswordPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusQ = useQuery({
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

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { invite: undefined }, replace: true });
    }
  }, [authLoading, user, navigate]);

  const mustChange = statusQ.data?.mustChangePassword === true;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!currentPassword) {
      setError("נא להזין את הסיסמה הנוכחית.");
      return;
    }
    if (newPassword.length < 8) {
      setError("הסיסמה החדשה חייבת להיות באורך 8 תווים לפחות.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("אימות הסיסמה החדשה אינו תואם.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("הסיסמה החדשה חייבת להיות שונה מהסיסמה הנוכחית.");
      return;
    }

    setBusy(true);
    const result = await changeOwnPassword(currentPassword, newPassword);
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    queryClient.setQueryData(["password_status", user?.id], {
      ok: true,
      mustChangePassword: false,
      role: statusQ.data?.role ?? null,
    });
    await queryClient.invalidateQueries({ queryKey: ["password_status"] });
    toast.success("הסיסמה עודכנה בהצלחה");
    navigate({ to: "/", replace: true });
  }

  async function handleLogout() {
    await signOut();
    navigate({ to: "/login", search: { invite: undefined }, replace: true });
  }

  if (authLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/brand/logo.jpeg" alt="" className="mb-4 h-12 w-auto object-contain" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {mustChange ? "החלפת סיסמה זמנית" : "שינוי סיסמה"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mustChange
              ? "התחברת עם סיסמה זמנית — יש לבחור סיסמה אישית חדשה כדי להמשיך למערכת."
              : `${site.name} · עדכון סיסמת ההתחברות שלך`}
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-7">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field label={mustChange ? "סיסמה זמנית (נוכחית)" : "סיסמה נוכחית"} htmlFor="current-password">
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="current-password"
                  type={showPasswords ? "text" : "password"}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  className="h-11 pe-9 ps-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords((v) => !v)}
                  aria-label={showPasswords ? "הסתרת סיסמה" : "הצגת סיסמה"}
                  className="absolute start-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  {showPasswords ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>

            <Field label="סיסמה חדשה" htmlFor="new-password" hint="לפחות 8 תווים">
              <Input
                id="new-password"
                type={showPasswords ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="לפחות 8 תווים"
                autoComplete="new-password"
                className="h-11"
              />
            </Field>

            <Field label="אימות סיסמה חדשה" htmlFor="confirm-new-password">
              <Input
                id="confirm-new-password"
                type={showPasswords ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="הזן שוב את הסיסמה החדשה"
                autoComplete="new-password"
                className="h-11"
              />
            </Field>

            {error ? (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <Button type="submit" className="h-11 w-full" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {busy ? "מעדכן סיסמה…" : "שמירת סיסמה חדשה"}
            </Button>

            <div className="flex flex-wrap gap-2 pt-1">
              {!mustChange ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 flex-1"
                  onClick={() => navigate({ to: "/" })}
                  disabled={busy}
                >
                  חזרה למערכת
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="h-11 flex-1"
                onClick={handleLogout}
                disabled={busy}
              >
                <LogOut className="size-4" />
                התנתקות
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
