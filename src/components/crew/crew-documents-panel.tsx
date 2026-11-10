import { useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useCrewDocuments } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { getAccessToken } from "@/integrations/neon/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/overlay";
import { dateShort, todayISO } from "@/lib/format";
import type { CrewDocType, CrewDocument } from "@/lib/types";

const DOC_TYPES: { type: CrewDocType; label: string }[] = [
  { type: "id_card", label: "תעודת זהות" },
  { type: "driver_license", label: "רישיון נהיגה" },
  { type: "height_license", label: "רישיון עבודה בגובה" },
];

async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    let source: CanvasImageSource;
    let width = 0;
    let height = 0;
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } else {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image"));
        img.src = url;
      });
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
      URL.revokeObjectURL(url);
    }
    const scale = Math.min(1, 2000 / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function CrewDocumentsPanel({
  crewMember,
  canEdit,
  onChanged,
}: {
  crewMember: { id: string; full_name: string };
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const { user } = useSession();
  const docsQ = useCrewDocuments(crewMember.id, true);
  const docs = docsQ.data ?? [];
  const [uploading, setUploading] = useState<CrewDocType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CrewDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingType, setPendingType] = useState<CrewDocType | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function pick(type: CrewDocType) {
    setPendingType(type);
    fileRef.current?.click();
  }

  async function uploadDoc(type: CrewDocType, file: File) {
    setUploading(type);
    setError(null);
    try {
      const compressed = await compressImage(file);
      const fd = new FormData();
      fd.append("file", compressed);
      const token = await getAccessToken().catch(() => null);
      const res = await fetch("/__api/files", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data?.url) throw new Error(data?.error || "upload_failed");
      const existing = docs.find((doc) => doc.doc_type === type);
      const payload = {
        file_url: data.url,
        file_name: compressed.name,
        mime: compressed.type,
        size: compressed.size,
        uploaded_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      };
      const result = existing
        ? await db.from("crew_documents").update(payload).eq("id", existing.id)
        : await db.from("crew_documents").insert({ crew_member_id: crewMember.id, doc_type: type, ...payload });
      if (result.error) throw new Error(result.error.message);
      toast.success("התמונה הועלתה");
      docsQ.refetch();
      onChanged?.();
    } catch {
      setError("העלאת התמונה נכשלה. נסה שוב.");
    } finally {
      setUploading(null);
    }
  }

  async function saveExpiry(type: CrewDocType, value: string) {
    const existing = docs.find((doc) => doc.doc_type === type);
    if (!existing) return;
    const { error: updateError } = await db
      .from("crew_documents")
      .update({ expiry_date: value || null, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (updateError) {
      toast.error("לא הצלחנו לשמור את תאריך התפוגה");
      return;
    }
    toast.success("תאריך התפוגה נשמר");
    docsQ.refetch();
  }

  async function removeDoc() {
    if (!deleting) return;
    setBusy(true);
    const { error: deleteError } = await db.from("crew_documents").delete().eq("id", deleting.id);
    setBusy(false);
    if (deleteError) {
      toast.error("לא הצלחנו למחוק את המסמך");
      return;
    }
    toast.success("המסמך נמחק");
    setDeleting(null);
    docsQ.refetch();
    onChanged?.();
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && pendingType) void uploadDoc(pendingType, file);
          e.target.value = "";
        }}
      />

      {error ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {DOC_TYPES.map(({ type, label }) => {
        const doc = docs.find((item) => item.doc_type === type);
        const expired = Boolean(doc?.expiry_date && doc.expiry_date < todayISO());
        return (
          <div key={type} className="rounded-xl border border-border bg-card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {!doc ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">חסר</span>
                  ) : (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">הועלה</span>
                  )}
                  {expired ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">פג תוקף</span>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canEdit || uploading === type}
                  onClick={() => pick(type)}
                >
                  {uploading === type ? "מעלה תמונה..." : doc ? "החלף" : "העלה תמונה"}
                </Button>
                {doc ? (
                  <Button type="button" size="sm" variant="ghost" disabled={!canEdit} onClick={() => setDeleting(doc)}>
                    מחק
                  </Button>
                ) : null}
              </div>
            </div>

            {doc ? (
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
                <a href={doc.file_url} target="_blank" rel="noreferrer" className="block shrink-0">
                  <img
                    src={doc.file_url}
                    alt={label}
                    className="h-28 w-40 rounded-lg border border-border object-cover"
                  />
                </a>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>הועלה: {dateShort(doc.uploaded_at)}</p>
                  <label className="block">
                    <span className="mb-1 block">תאריך תפוגה</span>
                    <Input
                      key={`${doc.id}-${doc.expiry_date ?? ""}`}
                      type="date"
                      defaultValue={doc.expiry_date ?? ""}
                      onBlur={(e) => saveExpiry(type, e.target.value)}
                      className="h-10 w-40"
                      disabled={!canEdit}
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(value) => !value && setDeleting(null)}
        title="מחיקת מסמך"
        description="האם למחוק את המסמך? הפעולה אינה ניתנת לשחזור."
        onConfirm={removeDoc}
        busy={busy}
      />
    </div>
  );
}
