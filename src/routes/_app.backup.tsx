import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronDown, ChevronUp, CloudUpload, Copy, Download, ExternalLink, FileSpreadsheet, RotateCcw, Send, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import { EmptyState, ErrorState, NoAccess, PageHeader, PageSkeleton, SectionCard } from "@/components/shared";
import { num } from "@/lib/format";
import {
  BACKUP_ERROR_MESSAGES,
  downloadSnapshot,
  downloadStoredBackup,
  getBackupStatus,
  getDriveStatus,
  resendBackupToDrive,
  restoreBackup,
  runBackup,
  saveDriveSettings,
  testDrive,
  type BackupSnapshot,
  type DriveTestResult,
  type RestoreResult,
} from "@/lib/backup";
import type { BackupRow, CompanySettings } from "@/lib/types";
import { validateBackupSnapshot } from "@/lib/backup-format";
import { backupContent } from "@/content/backup";

export const Route = createFileRoute("/_app/backup")({
  component: BackupPage,
  errorComponent: BackupErrorComponent,
});

function BackupErrorComponent({ reset }: { reset?: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <p className="text-lg font-semibold text-foreground">לא הצלחנו לטעון את מסך הגיבוי</p>
      <p className="mt-2 text-sm text-muted-foreground">אירעה שגיאה בלתי צפויה. נסה שוב.</p>
      <Button type="button" className="mt-4" onClick={() => reset?.()}>
        נסה שוב
      </Button>
    </div>
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatSize(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function downloadCsv(table: string, rows: Record<string, unknown>[]) {
  const cols = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.map(escape).join(","), ...rows.map((row) => cols.map((c) => escape(row[c])).join(","))];
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${table}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const APPS_SCRIPT_TEMPLATE = `function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body.token || body.token !== '{{TOKEN}}') {
      return ContentService.createTextOutput(JSON.stringify({ok:false, error:'invalid token'}))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var folderName = '{{FOLDER}}';
    var it = DriveApp.getFoldersByName(folderName);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
    var name = body.filename || ('backup-' + new Date().toISOString() + '.json');
    var file = folder.createFile(Utilities.newBlob(body.content, 'application/json', name));
    return ContentService.createTextOutput(JSON.stringify({ok:true, fileId:file.getId(), url:file.getUrl(), name:name}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ok:true, service:'drive-backup'}))
    .setMimeType(ContentService.MimeType.JSON);
}`;

function buildAppsScript(token: string, folder: string): string {
  return APPS_SCRIPT_TEMPLATE
    .replace("{{TOKEN}}", token || "PUT_YOUR_TOKEN_HERE")
    .replace("{{FOLDER}}", folder || "גיבויי נס מולטימדיה");
}

function BackupPage() {
  const { can, isAdmin, user } = useSession();
  const canView = can("backup", "view");
  const canEdit = can("backup", "edit");
  const queryClient = useQueryClient();

  const statusQ = useQuery({
    queryKey: ["backup_status"],
    queryFn: getBackupStatus,
    enabled: canView,
    retry: 0,
  });
  const backupsQ = useQuery({
    queryKey: ["backups"],
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await db
        .from<BackupRow[]>("backups")
        .select("id,created_at,kind,created_by,created_by_email,counts,total_rows,size_bytes,note,drive_status,drive_url,drive_file_id,drive_error,drive_sent_at")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreSource, setRestoreSource] = useState<"stored" | "upload">("stored");
  const [selectedBackupId, setSelectedBackupId] = useState("");
  const [uploadedSnapshot, setUploadedSnapshot] = useState<BackupSnapshot | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [restoreMode, setRestoreMode] = useState<"merge" | "replace">("merge");
  const [replaceConfirm, setReplaceConfirm] = useState("");
  const [dryRunResult, setDryRunResult] = useState<RestoreResult | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoring, setRestoring] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadRevision = useRef(0);

  const driveQ = useQuery({
    queryKey: ["backup_drive_status"],
    queryFn: getDriveStatus,
    enabled: can("backup", "edit"),
    retry: 0,
  });
  const settingsQ = useQuery({
    queryKey: ["company_settings"],
    enabled: can("backup", "edit"),
    queryFn: async () => {
      const { data, error } = await db
        .from<CompanySettings[]>("company_settings")
        .select("backup_drive_enabled,backup_drive_url,backup_drive_folder")
        .eq("id", 1)
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
  const [driveEnabled, setDriveEnabled] = useState(false);
  const [driveUrl, setDriveUrl] = useState("");
  const [driveFolder, setDriveFolder] = useState("גיבויי נס מולטימדיה");
  const [driveToken, setDriveToken] = useState("");
  const [savingDrive, setSavingDrive] = useState(false);
  const [testingDrive, setTestingDrive] = useState(false);
  const [driveTest, setDriveTest] = useState<DriveTestResult | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);

  useEffect(() => {
    const drive = driveQ.data;
    const settings = settingsQ.data;
    if (drive && (drive.url || drive.enabled || drive.tokenPresent)) {
      setDriveEnabled(drive.enabled);
      setDriveUrl(drive.url);
      setDriveFolder(drive.folder || "גיבויי נס מולטימדיה");
      return;
    }
    if (settings) {
      setDriveEnabled(Boolean(settings.backup_drive_enabled));
      setDriveUrl(settings.backup_drive_url ?? "");
      setDriveFolder(settings.backup_drive_folder || "גיבויי נס מולטימדיה");
    }
  }, [driveQ.data, settingsQ.data]);

  const backups = backupsQ.data ?? [];
  const status = statusQ.data;
  const statusUnavailable = statusQ.data === null;
  const tokenPresent = Boolean(driveQ.data?.tokenPresent) || Boolean(settingsQ.data?.backup_drive_url);
  const selectedBackup = backups.find((backup) => backup.id === selectedBackupId) ?? null;

  const preview = useMemo(() => {
    if (restoreSource === "upload" && uploadedSnapshot) {
      return {
        created_at: uploadedSnapshot.meta.created_at,
        counts: uploadedSnapshot.meta.counts ?? {},
        total_rows: uploadedSnapshot.meta.total_rows ?? 0,
      };
    }
    if (selectedBackup) {
      return {
        created_at: selectedBackup.created_at,
        counts: selectedBackup.counts ?? {},
        total_rows: selectedBackup.total_rows,
      };
    }
    return null;
  }, [restoreSource, uploadedSnapshot, selectedBackup]);

  if (!canView) return <NoAccess moduleLabel="גיבוי ושחזור" />;
  if (statusQ.isLoading || backupsQ.isLoading) return <PageSkeleton />;
  if (statusQ.error || backupsQ.error) {
    return (
      <ErrorState
        message="לא הצלחנו לטעון את מסך הגיבוי. נסה שוב."
        onRetry={() => {
          statusQ.refetch();
          backupsQ.refetch();
        }}
      />
    );
  }

  async function handleRun() {
    if (!canEdit) return;
    setRunning(true);
    setRunError(null);
    const result = await runBackup("manual", user?.email);
    setRunning(false);
    if (!result.ok) {
      const reason =
        result.error === "unavailable"
          ? "שירות הגיבוי אינו זמין בגרסה זו — נסה לרענן, ואם זה נמשך פרסם את האתר מחדש"
          : result.error === "forbidden"
            ? "אין לך הרשאה לבצע גיבוי"
            : `הגיבוי נכשל (${result.message || BACKUP_ERROR_MESSAGES[result.error] || "שגיאה לא ידועה"})`;
      setRunError(reason);
      toast.error(reason);
      return;
    }
    toast.success(`הגיבוי נוצר בהצלחה (${num(result.data.total_rows)} רשומות)`);
    const download = await downloadSnapshot(result.data.payload);
    if (!download.ok) toast.error(BACKUP_ERROR_MESSAGES[download.error] ?? BACKUP_ERROR_MESSAGES.server);
    statusQ.refetch();
    backupsQ.refetch();
  }

  async function handleExportJson() {
    if (!canEdit) return;
    const newest = backups[0];
    if (newest && Date.now() - new Date(newest.created_at).getTime() < 2 * 60 * 1000) {
      const result = await downloadStoredBackup(newest.id);
      if (!result.ok) toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    setRunning(true);
    const result = await runBackup("manual", user?.email);
    setRunning(false);
    if (!result.ok) {
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    const download = await downloadSnapshot(result.data.payload);
    if (!download.ok) toast.error(BACKUP_ERROR_MESSAGES[download.error] ?? BACKUP_ERROR_MESSAGES.server);
    statusQ.refetch();
    backupsQ.refetch();
  }

  async function handleExportExcel() {
    if (!canEdit) return;
    setExporting(true);
    const result = await runBackup("manual", user?.email);
    if (!result.ok) {
      setExporting(false);
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      for (const [table, rows] of Object.entries(result.data.payload.data)) {
        const sheet = XLSX.utils.json_to_sheet(rows as Record<string, unknown>[]);
        XLSX.utils.book_append_sheet(workbook, sheet, table.slice(0, 31));
      }
      XLSX.writeFile(workbook, `nes-mulichum-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("קובץ האקסל נוצר");
    } catch {
      for (const [table, rows] of Object.entries(result.data.payload.data)) {
        downloadCsv(table, rows as Record<string, unknown>[]);
      }
      toast.info("ייצוא האקסל אינו זמין — הורדנו קבצי CSV במקום");
    }
    setExporting(false);
    statusQ.refetch();
    backupsQ.refetch();
  }

  async function handleDownload(id: string) {
    const result = await downloadStoredBackup(id);
    if (!result.ok) toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
  }

  async function saveDrive() {
    const url = driveUrl.trim();
    if (!url) {
      toast.error("יש למלא כתובת Web App (…) שמסתיימת ב-exec");
      return;
    }
    setSavingDrive(true);
    const result = await saveDriveSettings({
      enabled: driveEnabled,
      url: driveUrl.trim(),
      folder: driveFolder.trim() || "גיבויי נס מולטימדיה",
      token: driveToken.trim() || undefined,
    });
    setSavingDrive(false);
    if (!result.ok) {
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    toast.success("הגדרות הדרייב נשמרו");
    driveQ.refetch();
  }

  async function testDriveConnection() {
    const url = driveUrl.trim();
    if (!url) {
      toast.error("יש למלא כתובת Web App (…) שמסתיימת ב-exec");
      return;
    }
    setTestingDrive(true);
    const result = await testDrive();
    setTestingDrive(false);
    if (!result.ok) {
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    setDriveTest(result.data);
    if (result.data.ok) toast.success("החיבור לגוגל דרייב עובד");
    else toast.error(result.data.message || "החיבור נכשל");
  }

  async function resendToDrive(id: string) {
    setResendingId(id);
    const result = await resendBackupToDrive(id);
    setResendingId(null);
    if (!result.ok) {
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    if (result.data.ok) toast.success("הגיבוי נשלח לגוגל דרייב");
    else toast.error(result.data.message || "השליחה נכשלה");
    backupsQ.refetch();
    driveQ.refetch();
  }

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(buildAppsScript(driveToken, driveFolder));
      setCopied(true);
      toast.success("הקוד הועתק");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("לא הצלחנו להעתיק — אפשר לסמן ולהעתיק ידנית");
    }
  }

  function openRestore(backupId?: string) {
    uploadRevision.current += 1;
    setRestoreOpen(true);
    setRestoreSource(backupId ? "stored" : backups.length ? "stored" : "upload");
    setSelectedBackupId(backupId ?? backups[0]?.id ?? "");
    setUploadedSnapshot(null);
    setUploadError(null);
    setRestoreMode("merge");
    setReplaceConfirm("");
    setDryRunResult(null);
    setRestoreResult(null);
  }

  function openRestoreUpload() {
    uploadRevision.current += 1;
    setRestoreOpen(true);
    setRestoreSource("upload");
    setSelectedBackupId("");
    setUploadedSnapshot(null);
    setUploadError(null);
    setRestoreMode("merge");
    setReplaceConfirm("");
    setDryRunResult(null);
    setRestoreResult(null);
  }

  async function handleFile(file: File | null) {
    const revision = ++uploadRevision.current;
    setUploadError(null);
    setUploadedSnapshot(null);
    setDryRunResult(null);
    setRestoreResult(null);
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const validation = await validateBackupSnapshot(parsed);
      if (revision !== uploadRevision.current) return;
      if (!validation.ok) {
        setUploadError(BACKUP_ERROR_MESSAGES[validation.error] ?? BACKUP_ERROR_MESSAGES.invalid_backup);
        return;
      }
      setUploadedSnapshot(parsed as BackupSnapshot);
    } catch {
      if (revision === uploadRevision.current) setUploadError(BACKUP_ERROR_MESSAGES.invalid_backup);
    }
  }

  function restoreBody(mode: "merge" | "replace" | "dry_run") {
    if (restoreSource === "upload") {
      if (!uploadedSnapshot) return null;
      return { payload: uploadedSnapshot, mode };
    }
    if (!selectedBackupId) return null;
    return { backup_id: selectedBackupId, mode };
  }

  async function handleDryRun() {
    if (!canEdit) return;
    const body = restoreBody("dry_run");
    if (!body) {
      toast.error("בחר גיבוי או העלה קובץ תקין");
      return;
    }
    setRestoring(true);
    const result = await restoreBackup(body);
    setRestoring(false);
    if (!result.ok) {
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    setDryRunResult(result.data);
  }

  async function handleRestore() {
    if (!canEdit) return;
    if (restoreMode === "replace" && (!isAdmin || replaceConfirm.trim() !== "מחק ושחזר")) return;
    const body = restoreBody(restoreMode);
    if (!body) {
      toast.error("בחר גיבוי או העלה קובץ תקין");
      return;
    }
    setRestoring(true);
    const result = await restoreBackup(body);
    setRestoring(false);
    if (!result.ok) {
      toast.error(BACKUP_ERROR_MESSAGES[result.error] ?? BACKUP_ERROR_MESSAGES.server);
      return;
    }
    setRestoreResult(result.data);
    const totals = result.data.per_table.reduce(
      (acc, row) => ({
        insert: acc.insert + row.insert,
        update: acc.update + row.update,
        deleted: acc.deleted + row.deleted,
      }),
      { insert: 0, update: 0, deleted: 0 },
    );
    toast.success(`השחזור הושלם: נוספו ${num(totals.insert)}, עודכנו ${num(totals.update)}, נמחקו ${num(totals.deleted)}`);
    queryClient.invalidateQueries();
    statusQ.refetch();
    backupsQ.refetch();
  }

  const replaceReady = isAdmin && replaceConfirm.trim() === "מחק ושחזר";
  const restoreReady = canEdit && (restoreSource === "upload" ? Boolean(uploadedSnapshot) && !uploadError : Boolean(selectedBackupId));

  return (
    <div>
      <PageHeader
        title="גיבוי ושחזור"
        description="הנתונים שלך נשמרים במסד האתר — כאן אפשר ליצור גיבוי, להוריד אותו ולשחזר."
      />

      <div className="space-y-4">
        {can("backup", "edit") ? (
          <SectionCard title="גיבוי אוטומטי לגוגל דרייב" description="שליחה שבועית של קובץ הגיבוי לתיקייה בדרייב שלך">
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={driveEnabled}
                  onChange={(e) => setDriveEnabled(e.target.checked)}
                  className="size-4 accent-[var(--primary)]"
                />
                שלח את הגיבויים לגוגל דרייב אוטומטית
              </label>

              <Field label="כתובת האפליקציה בגוגל (Web App URL)" htmlFor="drive-url">
                <Input
                  id="drive-url"
                  value={driveUrl}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  dir="ltr"
                  placeholder="https://script.google.com/macros/s/..."
                  className="h-11 text-start"
                />
              </Field>

              <Field
                label="סיסמת שיתוף"
                htmlFor="drive-token"
                hint={
                  tokenPresent
                    ? "מוצג כ־מוגדר אם כבר שמור. השאירו ריק כדי לשמור על הסיסמה הקיימת."
                    : "בחרו סיסמה ותשתמשו בה גם בקוד האפליקציה."
                }
              >
                <Input
                  id="drive-token"
                  type="password"
                  value={driveToken}
                  onChange={(e) => setDriveToken(e.target.value)}
                  dir="ltr"
                  placeholder={tokenPresent ? "•••••••• (שמור)" : "סיסמת שיתוף"}
                  className="h-11 text-start"
                  autoComplete="new-password"
                />
              </Field>

              <Field label="שם התיקייה בדרייב" htmlFor="drive-folder">
                <Input
                  id="drive-folder"
                  value={driveFolder}
                  onChange={(e) => setDriveFolder(e.target.value)}
                  placeholder="גיבויי נס מולטימדיה"
                  className="h-11"
                />
              </Field>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" onClick={saveDrive} disabled={savingDrive}>
                  {savingDrive ? "שומר..." : "שמור הגדרות"}
                </Button>
                <Button type="button" variant="outline" onClick={testDriveConnection} disabled={testingDrive}>
                  <CloudUpload className="size-4" />
                  {testingDrive ? "בודק..." : "בדיקת חיבור"}
                </Button>
              </div>

              {driveTest ? (
                <p
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    driveTest.ok
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-red-200 bg-red-50 text-red-700"
                  }`}
                >
                  {driveTest.message}
                  {driveTest.ok && driveTest.url ? (
                    <a href={driveTest.url} target="_blank" rel="noreferrer" className="ms-2 inline-flex items-center gap-1 underline">
                      פתח בדרייב <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </p>
              ) : null}

              <p className="text-xs text-muted-foreground">
                {driveQ.data?.lastSentAt ? (
                  <>
                    הגיבוי האחרון נשלח לדרייב ב־{formatDateTime(driveQ.data.lastSentAt)}
                    {driveQ.data.lastUrl ? (
                      <>
                        {" · "}
                        <a href={driveQ.data.lastUrl} target="_blank" rel="noreferrer" className="underline">
                          פתח בדרייב
                        </a>
                      </>
                    ) : null}
                  </>
                ) : (
                  "עוד לא נשלח גיבוי לדרייב"
                )}
              </p>
              {driveQ.data?.lastError ? <p className="text-xs text-red-700">שגיאה אחרונה: {driveQ.data.lastError}</p> : null}

              <div className="rounded-xl border border-border">
                <button
                  type="button"
                  onClick={() => setShowInstructions((value) => !value)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-foreground"
                >
                  <span>הוראות התקנה (4 שלבים)</span>
                  {showInstructions ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                </button>
                {showInstructions ? (
                  <div className="space-y-3 border-t border-border p-3 text-sm">
                    <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
                      <li>היכנסו ל-script.google.com וצרו פרויקט חדש.</li>
                      <li>הדביקו את הקוד (החליפו את הסיסמה אם שיניתם אותה).</li>
                      <li>Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone, ואשרו הרשאות.</li>
                      <li>העתיקו את כתובת ה-Web App לשדה למעלה ולחצו "בדיקת חיבור".</li>
                    </ol>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      הגיבוי השבועי נוצר ונשלח בפתיחה הבאה של המערכת לאחר שעברו 7 ימים. קובץ ה-JSON בדרייב ניתן לשחזר מאותו מסך.
                    </p>
                    {!driveToken ? (
                      <p className="text-xs text-amber-700">
                        הזינו את סיסמת השיתוף בשדה למעלה כדי שהיא תופיע בקוד. אחרת החליפו את PUT_YOUR_TOKEN_HERE בסיסמה ששמרתם.
                      </p>
                    ) : null}
                    <div className="space-y-2">
                      <div className="flex justify-end">
                        <Button type="button" size="sm" variant="outline" onClick={copyScript}>
                          <Copy className="size-3.5" /> {copied ? "הועתק" : "העתק"}
                        </Button>
                      </div>
                      <pre dir="ltr" className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">
                        <code>{buildAppsScript(driveToken, driveFolder)}</code>
                      </pre>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title="מצב גיבוי" description="סקירה של הגיבויים האחרונים">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">גיבוי ידני אחרון</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{formatDateTime(status?.lastManualAt)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">גיבוי אוטומטי אחרון</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{formatDateTime(status?.lastAutoAt)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">גיבוי אוטומטי הבא</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{formatDateTime(status?.nextAutoDueAt)}</p>
            </div>
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">סה״כ גיבויים</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{num(status?.backupCount ?? 0)}</p>
            </div>
          </div>
          {statusUnavailable ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              לא ניתן לטעון את מצב הגיבוי
            </p>
          ) : null}
          {runError ? (
            <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {runError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {status?.lastManualAt || status?.lastAutoAt ? backupContent.scope : "עדיין לא נוצר גיבוי"}
            </p>
            <Button type="button" onClick={handleRun} disabled={!canEdit || running}>
              <Archive className="size-4" />
              {running ? "מגבה..." : "גבה עכשיו"}
            </Button>
          </div>
          {!canEdit ? <p className="mt-2 text-xs text-amber-700">אין לך הרשאה ליצור גיבוי.</p> : null}
        </SectionCard>

        <SectionCard title="ייצוא" description="הורדת הנתונים לקובץ">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={handleExportJson} disabled={!canEdit || running}>
              <Download className="size-4" /> הורדת גיבוי מלא (JSON)
            </Button>
            <Button type="button" variant="outline" onClick={handleExportExcel} disabled={!canEdit || exporting}>
              <FileSpreadsheet className="size-4" /> {exporting ? "מייצא..." : "ייצוא לאקסל"}
            </Button>
            <Button type="button" variant="outline" onClick={openRestoreUpload} disabled={!canEdit}>
              <Upload className="size-4" /> שחזור מקובץ
            </Button>
          </div>
        </SectionCard>

        <SectionCard title="גיבויים אחרונים" description="עד 20 גיבויים אחרונים">
          {backups.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-start text-xs text-muted-foreground">
                    <th className="py-2 text-start font-medium">תאריך</th>
                    <th className="py-2 text-start font-medium">סוג</th>
                    <th className="py-2 text-start font-medium">שורות</th>
                    <th className="py-2 text-start font-medium">גודל</th>
                    <th className="py-2 text-start font-medium">דרייב</th>
                    <th className="py-2 text-start font-medium">פעולות</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((backup) => (
                    <tr key={backup.id} className="border-b border-border/70">
                      <td className="py-2">{formatDateTime(backup.created_at)}</td>
                      <td className="py-2">
                        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                          {backup.kind === "auto" ? "אוטומטי" : "ידני"}
                        </span>
                      </td>
                      <td className="py-2">{num(backup.total_rows)}</td>
                      <td className="py-2">{formatSize(backup.size_bytes)}</td>
                      <td className="py-2">
                        {!can("backup", "edit") ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : backup.drive_status === "sent" ? (
                          <a
                            href={backup.drive_url ?? "#"}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 underline"
                          >
                            <ExternalLink className="size-3" /> נשלח לדרייב
                          </a>
                        ) : backup.drive_status === "error" ? (
                          <span
                            className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700"
                            title={backup.drive_error ?? ""}
                          >
                            שגיאה
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">לא נשלח</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" variant="outline" onClick={() => handleDownload(backup.id)}>
                            <Download className="size-4" /> הורדה
                          </Button>
                          <Button type="button" size="sm" variant="outline" disabled={!canEdit} onClick={() => openRestore(backup.id)}>
                            <RotateCcw className="size-4" /> שחזור
                          </Button>
                          {can("backup", "edit") && backup.drive_status !== "sent" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={resendingId === backup.id}
                              onClick={() => resendToDrive(backup.id)}
                            >
                              <Send className="size-4" /> {resendingId === backup.id ? "שולח..." : "שלח לדרייב"}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={Archive} title="אין עדיין גיבויים" description="לחץ על גבה עכשיו כדי ליצור את הגיבוי הראשון." />
          )}
        </SectionCard>

        <SectionCard title="גיבוי אוטומטי" description="שמירה שבועית אוטומטית">
          <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/20 p-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">{status?.autoEnabled ? "פעיל" : "כבוי"}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                הגיבוי האוטומטי רץ פעם בשבוע כשהמערכת נפתחת, ונשמרים 8 הגיבויים האוטומטיים האחרונים.
              </p>
            </div>
          </div>
        </SectionCard>

        <p className="rounded-xl border border-border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          הגיבוי כולל את נתוני העסק. שחזור אינו משחזר משתמשים, סיסמאות והרשאות התחברות.
          {" "}{backupContent.exclusions}
          {" "}{backupContent.integrityNotice}
        </p>
      </div>

      <Dialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title="שחזור מגיבוי"
        description="בחירת גיבוי, בדיקה ושחזור"
        size="lg"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setRestoreOpen(false)}>סגירה</Button>
            <Button type="button" variant="outline" onClick={handleDryRun} disabled={restoring || !restoreReady}>
              בדיקה בלבד
            </Button>
            <Button
              type="button"
              onClick={handleRestore}
              disabled={restoring || !restoreReady || (restoreMode === "replace" && !replaceReady)}
            >
              {restoring ? "משחזר..." : "שחזר"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {backupContent.integrityNotice}{" "}{backupContent.exclusions}
          </p>
          <div className="flex gap-1 rounded-xl border border-border bg-muted/30 p-1">
            <button
              type="button"
              onClick={() => setRestoreSource("stored")}
              className={`min-h-10 flex-1 rounded-lg px-3 text-sm font-medium ${restoreSource === "stored" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              מגיבוי שמור
            </button>
            <button
              type="button"
              onClick={() => setRestoreSource("upload")}
              className={`min-h-10 flex-1 rounded-lg px-3 text-sm font-medium ${restoreSource === "upload" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              העלאת קובץ גיבוי
            </button>
          </div>

          {restoreSource === "stored" ? (
            <Field label="בחירת גיבוי" htmlFor="restore-backup">
              <Select id="restore-backup" value={selectedBackupId} onChange={(e) => setSelectedBackupId(e.target.value)}>
                <option value="">בחר גיבוי</option>
                {backups.map((backup) => (
                  <option key={backup.id} value={backup.id}>
                    {formatDateTime(backup.created_at)} · {backup.kind === "auto" ? "אוטומטי" : "ידני"} · {num(backup.total_rows)} שורות
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="space-y-2">
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" /> בחירת קובץ JSON
              </Button>
              {uploadedSnapshot ? (
                <p className="text-xs text-emerald-700">הקובץ נטען: {formatDateTime(uploadedSnapshot.meta.created_at)}</p>
              ) : null}
              {uploadError ? <p role="alert" className="text-xs text-red-700">{uploadError}</p> : null}
            </div>
          )}

          {preview ? (
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-sm font-medium text-foreground">תצוגה מקדימה</p>
              {restoreSource === "upload" && uploadedSnapshot ? (
                <p role="status" className="mt-1 text-xs text-emerald-700">{backupContent.checksumVerified}</p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                נוצר: {formatDateTime(preview.created_at)} · סה״כ שורות: {num(preview.total_rows)}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                {Object.entries(preview.counts).map(([table, count]) => (
                  <span key={table}>{table}: {num(count)}</span>
                ))}
              </div>
            </div>
          ) : null}

          <Field label="מצב שחזור" htmlFor="restore-mode">
            <Select
              id="restore-mode"
              value={restoreMode}
              onChange={(e) => setRestoreMode(e.target.value as "merge" | "replace")}
            >
              <option value="merge">מיזוג (מומלץ) — מוסיף ומעדכן בלי למחוק</option>
              <option value="replace" disabled={!isAdmin}>החלפה מלאה — מוחק נתונים שלא קיימים בגיבוי</option>
            </Select>
          </Field>

          {restoreMode === "replace" ? (
            <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
              <p className="text-xs text-red-700">
                החלפה מלאה מוחקת נתונים שלא קיימים בגיבוי. פעולה זו אינה זמינה למשתמשים שאינם מנהלים.
              </p>
              <Field label="להמשך, הקלד: מחק ושחזר" htmlFor="replace-confirm">
                <Input id="replace-confirm" value={replaceConfirm} onChange={(e) => setReplaceConfirm(e.target.value)} disabled={!isAdmin} />
              </Field>
            </div>
          ) : null}

          {dryRunResult ? (
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="text-sm font-medium text-foreground">תוכנית השחזור</p>
              <div className="mt-2 max-h-48 overflow-y-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-start text-muted-foreground">
                      <th className="py-1 text-start font-medium">טבלה</th>
                      <th className="py-1 text-start font-medium">הוספה</th>
                      <th className="py-1 text-start font-medium">עדכון</th>
                      <th className="py-1 text-start font-medium">מחיקה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dryRunResult.per_table.map((row) => (
                      <tr key={row.table} className="border-t border-border/60">
                        <td className="py-1">{row.table}</td>
                        <td className="py-1">{num(row.insert)}</td>
                        <td className="py-1">{num(row.update)}</td>
                        <td className="py-1">{num(row.deleted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {restoreResult ? (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              השחזור הושלם: נוספו {num(restoreResult.per_table.reduce((a, r) => a + r.insert, 0))}, עודכנו{" "}
              {num(restoreResult.per_table.reduce((a, r) => a + r.update, 0))}, נמחקו{" "}
              {num(restoreResult.per_table.reduce((a, r) => a + r.deleted, 0))}
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
