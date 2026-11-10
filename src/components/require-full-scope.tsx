import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useScope } from "@/lib/scope";

export function NoAccessScreen({
  message = "אין לך הרשאה לצפות בעמוד הזה.",
}: {
  message?: string;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-50 text-red-600">
          <ShieldAlert className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold text-foreground">אין הרשאה</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>
        <Button asChild variant="outline" className="mt-5 w-full">
          <Link to="/">חזרה לדף הבית</Link>
        </Button>
      </div>
    </div>
  );
}

export function RequireFullScope({
  children,
  message,
}: {
  children: ReactNode;
  message?: string;
}) {
  const { isFullScope } = useScope();
  if (!isFullScope) return <NoAccessScreen message={message} />;
  return <>{children}</>;
}
