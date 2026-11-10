import type { Profile, TimeEntry } from "@/lib/types";
import { attendanceContent } from "@/content/attendance";

function formatAuditDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

export function ManualFlags({ entry, profiles }: { entry: TimeEntry; profiles: Profile[] }) {
  const manual = entry.entry_source === "manual";
  const edited = entry.manually_edited === true;
  if (!manual && !edited) return null;

  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    const person = profiles.find((p) => p.id === id);
    return person?.full_name || person?.email || id;
  };

  const editor = nameOf(entry.edited_by);
  const creator = nameOf(entry.created_by);
  const owner = nameOf(entry.user_id);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {manual ? (
        <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">
          {attendanceContent.manualEntryBadge}
        </span>
      ) : null}
      {edited ? (
        <span className="inline-flex items-center rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
          {attendanceContent.manualEditBadge}
        </span>
      ) : null}
      {edited && editor ? (
        <span className="text-[10px] text-muted-foreground">
          {attendanceContent.editedBy(editor, formatAuditDate(entry.edited_at))}
          {entry.edit_count > 1 ? ` ${attendanceContent.editCount(entry.edit_count)}` : ""}
        </span>
      ) : manual && creator && creator !== owner ? (
        <span className="text-[10px] text-muted-foreground">{attendanceContent.enteredBy(creator)}</span>
      ) : null}
    </div>
  );
}
