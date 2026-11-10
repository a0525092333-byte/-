import { getAccessToken } from "@/integrations/neon/auth";
import { backupContent } from "@/content/backup";
import { BACKUP_FORMAT, BACKUP_VERSION, sanitizeBackupData, validateBackupSnapshot } from "@/lib/backup-format";

export { BACKUP_TABLES } from "@/lib/backup-format";

export type BackupStatus = {
  lastManualAt: string | null;
  lastAutoAt: string | null;
  nextAutoDueAt: string | null;
  backupCount: number;
  autoEnabled: boolean;
};

export type BackupMeta = {
  app: string;
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  checksum: string;
  created_at: string;
  kind: "manual" | "auto";
  created_by_email: string | null;
  counts: Record<string, number>;
  total_rows: number;
  skipped: string[];
};

export type BackupSnapshot = {
  meta: BackupMeta;
  data: Record<string, Record<string, unknown>[]>;
};

export type BackupRunResult = {
  id: string;
  created_at: string;
  counts: Record<string, number>;
  total_rows: number;
  size_bytes: number;
  payload: BackupSnapshot;
};

export type RestorePerTable = {
  table: string;
  insert: number;
  update: number;
  unchanged: number;
  deleted: number;
  skipped: number;
};

export type RestoreResult = {
  ok: boolean;
  mode: string;
  per_table: RestorePerTable[];
  warnings: string[];
};

export type DriveStatus = {
  enabled: boolean;
  url: string;
  folder: string;
  tokenPresent: boolean;
  lastSentAt: string | null;
  lastUrl: string | null;
  lastError: string | null;
};

export type DriveTestResult = {
  ok: boolean;
  status: string;
  message: string;
  url: string | null;
};

export const BACKUP_ERROR_MESSAGES: Record<string, string> = {
  ...backupContent.errors,
  unauthorized: "פג תוקף ההתחברות — יש להתחבר מחדש",
  forbidden: "אין לך הרשאה לבצע פעולה זו",
  invalid_backup: "הקובץ אינו קובץ גיבוי של המערכת",
  not_found: "הגיבוי לא נמצא",
  unavailable: "שירות הגיבוי אינו זמין בגרסה זו — נסה לרענן, ואם זה נמשך פרסם את האתר מחדש",
  network: "לא הצלחנו להתחבר לשרת — נסה שוב",
  server: "שגיאה בגיבוי — נסה שוב",
};

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function backupFetch<T>(path: string, init: RequestInit = {}): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string; message?: string; routeUnavailable?: boolean }
> {
  let res: Response | null = null;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(await authHeaders()), ...(init.headers || {}) },
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (!res) return { ok: false, error: "network" };

  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  const payload = (data && typeof data === "object" ? data : {}) as {
    error?: string;
    message?: string;
  };

  if (res.status === 401) return { ok: false, error: "unauthorized" };
  if (res.status === 403) return { ok: false, error: "forbidden" };
  if (res.status === 404) {
    if (payload.error && ["not_found", "invalid_backup", "forbidden", "unauthorized"].includes(payload.error)) {
      return { ok: false, error: payload.error, message: payload.message };
    }
    return {
      ok: false,
      error: "unavailable",
      message: "שירות הגיבוי אינו זמין בגרסה זו — נסה לרענן, ואם זה נמשך פרסם את האתר מחדש",
      routeUnavailable: true,
    };
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    return {
      ok: false,
      error: "unavailable",
      message: "שירות הגיבוי אינו זמין בגרסה זו — נסה לרענן, ואם זה נמשך פרסם את האתר מחדש",
      routeUnavailable: true,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: payload.error || "server",
      message: payload.message || (text && !data ? "שגיאה בגיבוי — נסה שוב" : undefined),
    };
  }
  if (data === null) {
    return {
      ok: false,
      error: "unavailable",
      message: "שירות הגיבוי אינו זמין בגרסה זו — נסה לרענן, ואם זה נמשך פרסם את האתר מחדש",
      routeUnavailable: true,
    };
  }
  return { ok: true, data: data as T };
}

export async function getBackupStatus(): Promise<BackupStatus | null> {
  const result = await backupFetch<BackupStatus>("/api/backup/status");
  if (!result.ok) return null;
  return result.data;
}

async function safeSnapshot(snapshot: unknown): Promise<
  | { ok: true; data: BackupSnapshot }
  | { ok: false; error: string; message: string }
> {
  const validation = await validateBackupSnapshot(snapshot);
  if (!validation.ok) {
    return { ...validation, message: BACKUP_ERROR_MESSAGES[validation.error] ?? BACKUP_ERROR_MESSAGES.invalid_backup };
  }
  try {
    const { meta, data } = snapshot as BackupSnapshot;
    const clean = sanitizeBackupData(data);
    // Project both data and metadata; never serialize the original response.
    return {
      ok: true,
      data: {
        meta: {
          app: meta.app,
          format: meta.format,
          version: meta.version,
          checksum: meta.checksum,
          created_at: meta.created_at,
          kind: meta.kind,
          created_by_email: meta.created_by_email,
          counts: Object.fromEntries(Object.entries(clean).map(([table, rows]) => [table, rows.length])),
          total_rows: meta.total_rows,
          skipped: [...meta.skipped],
        },
        data: clean,
      },
    };
  } catch {
    return { ok: false, error: "invalid_backup", message: BACKUP_ERROR_MESSAGES.invalid_backup };
  }
}

export async function runBackup(kind: "manual" | "auto" = "manual", _email?: string | null) {
  const result = await backupFetch<BackupRunResult>("/api/backup/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  // Persistence must remain server-side so the backup and its audit are atomic.
  if (!result.ok) return result;
  const snapshot = await safeSnapshot(result.data?.payload);
  if (!snapshot.ok) return snapshot;
  return { ok: true as const, data: { ...result.data, payload: snapshot.data } };
}

export async function autoBackup() {
  return backupFetch<{ skipped: boolean; lastAutoAt?: string | null }>("/api/backup/auto", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function getDriveStatus(): Promise<DriveStatus> {
  const result = await backupFetch<DriveStatus>("/api/backup/drive/status");
  if (!result.ok) {
    return { enabled: false, url: "", folder: "גיבויי נס מולטימדיה", tokenPresent: false, lastSentAt: null, lastUrl: null, lastError: null };
  }
  return result.data;
}

export async function saveDriveSettings(body: {
  enabled: boolean;
  url: string;
  folder: string;
  token?: string;
}) {
  return backupFetch<DriveStatus>("/api/backup/drive/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function testDrive() {
  return backupFetch<DriveTestResult>("/api/backup/drive/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function resendBackupToDrive(id: string) {
  return backupFetch<DriveTestResult>(`/api/backup/${id}/drive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function restoreBackup(body: {
  backup_id?: string;
  payload?: BackupSnapshot;
  mode: "merge" | "replace" | "dry_run";
}) {
  if (body.payload !== undefined) {
    const snapshot = await safeSnapshot(body.payload);
    if (!snapshot.ok) return snapshot;
    body = { ...body, payload: snapshot.data };
  }
  return backupFetch<RestoreResult>("/api/backup/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function downloadSnapshot(snapshot: unknown, filename?: string) {
  const checked = await safeSnapshot(snapshot);
  if (!checked.ok) return checked;
  try {
    const blob = new Blob([JSON.stringify(checked.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    try {
      link.href = url;
      link.download = filename || `hapaqa-backup-${new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "")}.json`;
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      URL.revokeObjectURL(url);
    }
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "server", message: BACKUP_ERROR_MESSAGES.server };
  }
}

export async function downloadStoredBackup(id: string) {
  const result = await backupFetch<unknown>(`/api/backup/${encodeURIComponent(id)}/download`);
  if (!result.ok) return result;
  return downloadSnapshot(result.data, `hapaqa-backup-${new Date().toISOString().slice(0, 10)}.json`);
}
