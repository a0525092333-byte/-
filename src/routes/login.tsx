import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2, LockKeyhole, Mail, UserRound } from "lucide-react";
import { signIn, signUp } from "@/integrations/neon/auth";
import { dataApiToken } from "@/integrations/neon/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import { site } from "@/content/site";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    invite: typeof search.invite === "string" ? search.invite : undefined,
  }),
  component: Login,
});

function hebrewAuthError(message: string, status?: number): string {
  const m = (message || "").toLowerCase();
  if (
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("לא הצלחנו להתחבר") ||
    m.includes("החיבור") ||
    m.includes("aborted") ||
    m.includes("ארכה") ||
    m.includes("להגיע") ||
    m.includes("אינו זמין") ||
    m.includes("invalid origin")
  ) {
    return "לא הצלחנו להגיע לשרת. בדוק את החיבור ונסה שוב.";
  }
  if (status === 401) return "אימייל או סיסמה שגויים.";
  if (m.includes("already") || m.includes("exists") || m.includes("duplicate")) return "כתובת האימייל כבר רשומה במערכת.";
  if (m.includes("invalid") && (m.includes("password") || m.includes("credential") || m.includes("login")))
    return "אימייל או סיסמה שגויים.";
  if (m.includes("password")) return "הסיסמה חייבת להכיל לפחות 8 תווים.";
  if (m.includes("email")) return "כתובת האימייל אינה תקינה.";
  if (/[\u0590-\u05FF]/.test(message || "")) return message;
  return "ההתחברות נכשלה. בדוק את הפרטים ונסה שוב.";
}

function Login() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { invite } = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [forgotError, setForgotError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && user) navigate({ to: "/" });
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (invite) {
      setMode("signup");
      setEmail(invite);
      setError(null);
    }
  }, [invite]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("נא להזין כתובת אימייל תקינה.");
      return;
    }
    if (password.length < 8) {
      setError("הסיסמה חייבת להכיל לפחות 8 תווים.");
      return;
    }
    if (mode === "signup") {
      if (!fullName.trim()) {
        setError("נא להזין שם מלא.");
        return;
      }
      if (password !== confirm) {
        setError("הסיסמאות אינן תואמות.");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "signin") await signIn(email.trim(), password);
      else await signUp(email.trim(), password, fullName.trim());
      let mustChange = false;
      try {
        const token = await dataApiToken();
        const res = await fetch("/api/account/password-status", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          mustChange = data?.mustChangePassword === true;
        }
      } catch {
        /* fail-open — never block sign-in on a status check */
      }
      navigate({ to: mustChange ? "/set-password" : "/", replace: true });
    } catch (err: any) {
      setError(hebrewAuthError(err?.message ?? "", err?.status));
    } finally {
      setBusy(false);
    }
  }

  async function sendForgot() {
    setForgotError(null);
    setForgotMessage(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forgotEmail.trim())) {
      setForgotError("נא להזין כתובת אימייל תקינה.");
      return;
    }
    setForgotBusy(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      if (!res.ok) {
        setForgotError("לא הצלחנו לשלוח את הבקשה — בדוק את החיבור ונסה שוב.");
        return;
      }
      const data = await res.json().catch(() => null);
      setForgotMessage(data?.message || "אם הכתובת רשומה במערכת, נשלחה אליה סיסמה זמנית");
    } catch {
      setForgotError("לא הצלחנו להגיע לשרת. בדוק את החיבור ונסה שוב.");
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center text-center">
            <img src="/brand/logo.jpeg" alt="" className="mb-4 h-14 w-auto object-contain" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{site.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{site.tagline}</p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-7">
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="בחירת פעולה">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signin"}
                onClick={() => {
                  setMode("signin");
                  setError(null);
                }}
                className={`min-h-11 rounded-lg text-sm font-medium transition-colors ${
                  mode === "signin" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                התחברות
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signup"}
                onClick={() => {
                  setMode("signup");
                  setError(null);
                }}
                className={`min-h-11 rounded-lg text-sm font-medium transition-colors ${
                  mode === "signup" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                הרשמה
              </button>
            </div>

            {invite ? <div className="mb-4 rounded-lg border border-primary/20 bg-accent/50 px-3 py-2 text-sm leading-relaxed text-accent-foreground">הוזמנת להצטרף למערכת. הירשם עם האימייל הזה כדי לקבל את ההרשאות שהוגדרו עבורך.</div> : null}

            <form onSubmit={submit} className="space-y-4" noValidate>
              {mode === "signup" ? (
                <Field label="שם מלא" htmlFor="fullName">
                  <div className="relative">
                    <UserRound className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="לדוגמה: דנה לוי"
                      autoComplete="name"
                      className="h-11 pe-9"
                    />
                  </div>
                </Field>
              ) : null}

              <Field label="כתובת אימייל" htmlFor="email">
                <div className="relative">
                  <Mail className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    dir="ltr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.co.il"
                    autoComplete="email"
                    className="h-11 ps-9 text-start"
                  />
                </div>
              </Field>

              <Field label="סיסמה" htmlFor="password">
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="לפחות 8 תווים"
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    className="h-11 pe-9 ps-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "הסתרת סיסמה" : "הצגת סיסמה"}
                    className="absolute start-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>

              {mode === "signup" ? (
                <Field label="אימות סיסמה" htmlFor="confirm">
                  <Input
                    id="confirm"
                    type={showPassword ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="הזן שוב את הסיסמה"
                    autoComplete="new-password"
                    className="h-11"
                  />
                </Field>
              ) : null}

              {error ? (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="h-11 w-full" disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? "מתחבר…" : mode === "signin" ? "כניסה למערכת" : "יצירת חשבון"}
              </Button>
              {mode === "signin" ? (
                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setForgotEmail(email);
                      setForgotMessage(null);
                      setForgotError(null);
                      setForgotOpen(true);
                    }}
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    שכחתי סיסמה
                  </button>
                </div>
              ) : null}
              {mode === "signup" ? (
                <p className="text-center text-xs leading-relaxed text-muted-foreground">
                  ההרשמה תיכנס לתוקף רק לאחר אישור המנהל.
                </p>
              ) : null}
            </form>

            <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
              {mode === "signin" ? "אין לך חשבון? " : "כבר יש לך חשבון? "}
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "signin" ? "signup" : "signin");
                  setError(null);
                }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {mode === "signin" ? "הרשמה" : "התחברות"}
              </button>
            </p>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            מערכת פנימית. הגישה ניתנת בהרשאה של מנהל המערכת בלבד.
          </p>
        </div>
      </div>

      <Dialog
        open={forgotOpen}
        onOpenChange={(v) => {
          setForgotOpen(v);
          if (!v) {
            setForgotMessage(null);
            setForgotError(null);
          }
        }}
        title="שכחתי סיסמה"
        description="נשלח סיסמה זמנית לכתובת האימייל הרשומה במערכת."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setForgotOpen(false)}>
              ביטול
            </Button>
            <Button type="button" onClick={sendForgot} disabled={forgotBusy}>
              {forgotBusy ? "שולח…" : "שליחת סיסמה זמנית"}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <
          Field label="כתובת אימייל" htmlFor="forgot-email">
            <Input
  id="forgot-email"
  type="email"
  dir="ltr"
  value={forgotEmail}
  readOnly
  className="h-11 text-start bg-muted"
            />
          </Field>
          {forgotMessage ? (
            <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {forgotMessage}
            </p>
          ) : null}
          {forgotError ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {forgotError}
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
