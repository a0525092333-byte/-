import { useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { currentUser, getAccessToken, subscribe } from "@/integrations/neon/auth";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { MODULES } from "@/lib/permissions";
import { securityContent as copy } from "@/content/security";

type ResetRole = "admin" | "warehouse" | "accounting" | "crew";
type Preview = {
  fingerprint: string;
  accounts: { id: string; full_name: string; role: ResetRole; changed: number }[];
  count: number;
  presets: Record<ResetRole, Record<string, { view: boolean; edit: boolean }>>;
};

export async function securityRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error(copy.loadError);
  const response = await fetch(path, {
    ...init, cache: "no-store",
    headers: { "content-type": "application/json", ...init.headers, authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) {
    // Do not render raw backend messages, which may contain internal SQL details.
    const stale = response.status === 409 || /stale|40001/i.test(String(data?.error ?? data?.code ?? data?.message ?? ""));
    throw Object.assign(new Error(stale ? copy.stale : copy.loadError), { stale });
  }
  return data as T;
}

export function useSecurityAccess() {
  const user = useSyncExternalStore(subscribe, currentUser, currentUser);
  const query = useQuery({
    queryKey: ["security-access", user?.id],
    enabled: !!user?.id,
    queryFn: () => securityRequest<{ ok: true; canReset: boolean; canAudit: boolean }>("/api/security/access"),
    staleTime: 20_000,
    retry: false,
  });
  return {
    userId: user?.id,
    canReset: !!user && !query.isError && query.data?.ok === true && query.data.canReset === true,
    canAudit: !!user && !query.isError && query.data?.ok === true && query.data.canAudit === true,
  };
}

export function RolePermissionReset() {
  const { userId, canReset } = useSecurityAccess();
  // Identity-keyed children discard a previous account's preview and confirmation.
  return canReset && userId ? <ResetWidget key={userId} userId={userId} /> : null;
}

function ResetWidget({ userId }: { userId: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const preview = useQuery({
    queryKey: ["permission-reset-preview", userId],
    enabled: open,
    queryFn: () => securityRequest<Preview>("/api/users/permission-reset-preview"),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const reset = useMutation({
    mutationFn: (fingerprint: string) => securityRequest<{ ok: true; count: number; changed: number }>(
      "/api/users/permission-reset", { method: "POST", body: JSON.stringify({ fingerprint, confirm: true }) },
    ),
    onSuccess: async (result) => {
      setOpen(false);
      setNotice(copy.success(result.count, result.changed));
      await Promise.all([
        "all_permissions", "permissions", "profiles", "profile", "is_admin", "is_super_admin",
        "security-access", "event-accounting-access", "security-audit", "permission-reset-preview",
      ].map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: () => {
      // Never replay a mutation. Refreshing the preview still requires a new click.
      void preview.refetch();
    },
  });
  const data = !preview.isError && !preview.isFetching ? preview.data : undefined;
  const changed = data?.accounts.reduce((sum, account) => sum + account.changed, 0) ?? 0;
  return (
    <div className="mb-4 min-w-0" dir="rtl">
      <Button type="button" variant="outline" className="min-h-11 w-full whitespace-normal sm:w-auto"
        onClick={() => { reset.reset(); setNotice(""); setOpen(true); }}>
        {copy.reset}
      </Button>
      {notice ? <p role="status" className="mt-2 break-words text-sm">{notice}</p> : null}
      <Dialog open={open} onOpenChange={(value) => { if (!reset.isPending) setOpen(value); }}
        title={copy.previewTitle} description={copy.previewDescription} size="lg">
        <div dir="rtl" className="min-w-0 space-y-4 break-words">
          {preview.isFetching ? <p role="status">{copy.loading}</p> : null}
          {preview.isError ? <p role="alert">{copy.loadError}</p> : null}
          {reset.isError ? <p role="alert">{(reset.error as Error & { stale?: boolean }).stale ? copy.stale : copy.resetError}</p> : null}
          {data ? <>
            <p className="text-sm font-medium">{copy.summary(data.count, changed)}</p>
            {!data.accounts.length ? <p className="text-sm">{copy.noTargets}</p> : null}
            <ul className="space-y-2">
              {data.accounts.map((account) => <li key={account.id} className="rounded-lg border border-border p-3 text-sm">
                <p className="break-words font-medium">{account.full_name}</p>
                <p className="text-muted-foreground">{copy.roles[account.role]} · {copy.accountChanges(account.changed)}</p>
              </li>)}
            </ul>
            <h3 className="text-sm font-semibold">{copy.presets}</h3>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {Object.entries(data.presets).map(([role, flags]) => <div key={role} className="min-w-0 rounded-lg border border-border p-3 text-xs">
                <h4 className="mb-2 font-semibold">{copy.roles[role as ResetRole]}</h4>
                <ul className="space-y-1">{MODULES.map((module) => <li key={module.key} className="flex flex-wrap justify-between gap-x-2">
                  <span>{module.label}</span><span className="text-muted-foreground">{flags[module.key]?.edit ? copy.edit : flags[module.key]?.view ? copy.view : copy.denied}</span>
                </li>)}</ul>
              </div>)}
            </div>
          </> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11 max-w-full whitespace-normal" disabled={!data || !data.count || !changed || reset.isPending}
              onClick={() => { if (data) reset.mutate(data.fingerprint); }}>
              {reset.isPending ? copy.resetting : copy.confirm}
            </Button>
            <Button type="button" variant="outline" className="min-h-11 max-w-full whitespace-normal" disabled={reset.isPending || preview.isFetching}
              onClick={() => { reset.reset(); void preview.refetch(); }}>{copy.refresh}</Button>
            <Button type="button" variant="ghost" className="min-h-11" disabled={reset.isPending} onClick={() => setOpen(false)}>{copy.cancel}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
