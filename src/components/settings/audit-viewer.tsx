import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/shared";
import { securityRequest, useSecurityAccess } from "@/components/users/role-permission-reset";
import { securityContent as copy } from "@/content/security";

type AuditRow = {
  id: string; user_id: string; action: string; module: string;
  details: Record<string, unknown>; created_at: string;
};
const detailKeys = new Set([
  "target_id", "target_ids", "event_id", "quote_id", "backup_id", "mode", "rows", "tables", "count", "outcome", "role", "changed",
  "view", "edit", "old_view", "old_edit", "user_id", "module", "operation",
]);

function safeDetails(details: Record<string, unknown>) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return "{}";
  // Server sanitization is authoritative; never display unrecognized detail keys.
  return JSON.stringify(Object.fromEntries(Object.entries(details).filter(([key]) => detailKeys.has(key))));
}

export function AuditViewer() {
  const { userId, canAudit } = useSecurityAccess();
  return canAudit && userId ? <AuditPages key={userId} userId={userId} /> : null;
}

function AuditPages({ userId }: { userId: string }) {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["security-audit", userId, offset],
    queryFn: () => securityRequest<{ ok: true; rows: AuditRow[]; hasMore: boolean }>(`/api/audit?limit=20&offset=${offset}`),
    retry: false,
  });
  return (
    <div className="mt-5 min-w-0" dir="rtl">
      <SectionCard title={copy.auditTitle} description={copy.auditDescription}>
        {query.isPending ? <p role="status" className="text-sm">{copy.loading}</p> : null}
        {query.isError ? <div role="alert" className="space-y-2 text-sm">
          <p>{copy.loadError}</p><Button type="button" variant="outline" className="min-h-11" onClick={() => void query.refetch()}>{copy.retry}</Button>
        </div> : null}
        {!query.isError && query.data ? <>
          {!query.data.rows.length ? <p className="text-sm text-muted-foreground">{copy.auditEmpty}</p> : null}
          <ul className="min-w-0 space-y-2">
            {query.data.rows.map((row) => <li key={row.id} className="min-w-0 rounded-lg border border-border p-3 text-xs [overflow-wrap:anywhere]">
              <p className="font-medium">{copy.actions[row.action as keyof typeof copy.actions] ?? row.action} · {row.module}</p>
              <time dateTime={row.created_at} className="text-muted-foreground">{new Date(row.created_at).toLocaleString("he-IL")}</time>
              <p className="mt-1">{copy.actor}: <bdi>{row.user_id}</bdi></p>
              <details className="mt-2 min-w-0">
                <summary className="flex min-h-11 cursor-pointer items-center">{copy.details}</summary>
                <pre dir="ltr" className="max-w-full whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px]">{safeDetails(row.details)}</pre>
              </details>
            </li>)}
          </ul>
        </> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={!offset || query.isFetching} onClick={() => setOffset((value) => Math.max(0, value - 20))}>{copy.previous}</Button>
          <span className="text-xs text-muted-foreground">{copy.page(offset / 20 + 1)}</span>
          <Button type="button" variant="outline" className="min-h-11" disabled={query.isError || query.isFetching || !query.data?.hasMore} onClick={() => setOffset((value) => value + 20)}>{copy.next}</Button>
        </div>
      </SectionCard>
    </div>
  );
}
