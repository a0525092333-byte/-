import { useEffect } from "react";
import { useSession } from "./use-session";
import { autoBackup } from "@/lib/backup";

/**
 * Catch-up weekly backup: there is no cron, so the app checks once per browser
 * session whether an automatic backup is due and runs it silently.
 */
export function useAutoBackup() {
  const { can, isAdmin } = useSession();

  useEffect(() => {
    if (!isAdmin && !can("backup", "view")) return;
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("backup_auto_checked")) return;
    sessionStorage.setItem("backup_auto_checked", "1");
    autoBackup().catch(() => {});
  }, [can, isAdmin]);
}
