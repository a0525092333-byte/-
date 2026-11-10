import * as React from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Inbox, RefreshCw, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { initials } from "@/lib/format";
import { EVENT_STATUS_SOLID, formatStatusLabel } from "@/lib/status-labels";

const STATUS_STYLES: Record<string, string> = {
  ממתין: "bg-amber-50 text-amber-800 border-amber-200",
  באיחור: "bg-red-50 text-red-700 border-red-200",
  חלקי: "bg-amber-50 text-amber-800 border-amber-200",
  "לא שולם": "bg-red-50 text-red-700 border-red-200",
  משובץ: "bg-slate-100 text-slate-700 border-slate-200",
  אושר: "bg-blue-50 text-blue-800 border-blue-200",
  הגיע: "bg-emerald-50 text-emerald-800 border-emerald-200",
  "לא הגיע": "bg-red-50 text-red-700 border-red-200",
  במחסן: "bg-emerald-50 text-emerald-800 border-emerald-200",
  בשטח: "bg-blue-50 text-blue-800 border-blue-200",
  בתיקון: "bg-amber-50 text-amber-800 border-amber-200",
  הוגש: "bg-blue-50 text-blue-800 border-blue-200",
  מאושר: "bg-emerald-50 text-emerald-800 border-emerald-200",
  טיוטה: "bg-slate-100 text-slate-700 border-slate-200",
  נשלחה: "bg-blue-50 text-blue-800 border-blue-200",
  מאושרת: "bg-emerald-50 text-emerald-800 border-emerald-200",
  נדחתה: "bg-red-50 text-red-800 border-red-200",
  בוטלה: "bg-slate-100 text-slate-600 border-slate-200",
  ...EVENT_STATUS_SOLID,
};

export function StatusPill({ status, className }: { status: string | null | undefined; className?: string }) {
  const key = status ?? "—";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_STYLES[key] ?? "bg-muted text-muted-foreground border-border",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {formatStatusLabel(key)}
    </span>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-50 text-red-600">
        <AlertTriangle className="size-6" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-foreground">לא הצלחנו לטעון את הנתונים</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {message || "אירעה תקלה זמנית. בדוק את החיבור ונסה שוב."}
      </p>
      {onRetry ? (
        <Button type="button" variant="outline" className="mt-5" onClick={onRetry}>
          <RefreshCw className="size-4" />
          נסה שוב
        </Button>
      ) : null}
    </div>
  );
}

export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="טוען נתונים">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "green" | "amber" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    default: "bg-accent text-accent-foreground",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
    blue: "bg-blue-50 text-blue-700",
  };
  return (
    <Card className="card-soft border-border/80 py-0">
      <CardContent className="flex items-start justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="num mt-1.5 text-2xl font-bold tracking-tight text-foreground">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {Icon ? (
          <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", tones[tone])}>
            <Icon className="size-5" aria-hidden="true" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("card-soft gap-0 border-border/80 py-0", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </Card>
  );
}

export function Avatar({ name, className }: { name: string | null | undefined; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground",
        className,
      )}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function NoAccess({ moduleLabel }: { moduleLabel?: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-red-50 text-red-600">
        <AlertTriangle className="size-7" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-bold text-foreground">אין הרשאה</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {moduleLabel ? `אין לך הרשאה לצפות ב${moduleLabel}.` : "אין לך הרשאה לצפות בעמוד הזה."} פנה למנהל המערכת
        כדי לקבל גישה.
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/">חזרה לסקירה</Link>
      </Button>
    </div>
  );
}

const LTR_PATTERN = /(\d+(?:[.,]\d+)?\s*[*xX×]\s*\d+(?:[.,]\d+)?)/g;

/** Insert bidi isolation marks around LTR dimension patterns for input values. */
export function isolateLtrText(value: string | null | undefined): string {
  return String(value ?? "").replace(LTR_PATTERN, "\u2066$1\u2069");
}

/** Remove bidi isolation marks before storing an edited value. */
export function stripBidiMarks(value: string | null | undefined): string {
  return String(value ?? "").replace(/[\u2066\u2067\u2068\u2069]/g, "");
}

/** Keeps LTR dimension patterns (2.5*4, 3*5) from being reordered inside RTL text. */
export function LtrText({ children }: { children: string | null | undefined }) {
  const text = String(children ?? "");
  if (!text) return null;
  return (
    <>
      {text.split(LTR_PATTERN).map((part, index) =>
        /^\d+(?:[.,]\d+)?\s*[*xX×]\s*\d+(?:[.,]\d+)?$/.test(part) ? (
          <span key={index} dir="ltr" style={{ unicodeBidi: "isolate" }}>
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}
