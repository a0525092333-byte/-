// Device → the site's OWN storage upload widget. Use this ANYWHERE a site needs an image
// or file (admin forms, a user's avatar, a submission) — INSTEAD of a "paste image URL"
// text input. The user picks a file from their device; it uploads to the site's storage
// (Cloudflare R2, via the platform's `POST /__api/files`) and this returns the served URL
// (`/__api/files/<id>`) which you store on your DB row / form field. NEVER ask for a remote
// image URL again: no external hotlinks, no fabricated Unsplash links, no 404s.
//
//   const [cover, setCover] = useState("");
//   <ImageUpload value={cover} onChange={setCover} />   // store `cover` on the row
//
// Requires the site's storage to be enabled (the platform does this) — until then uploads
// return 501 and the widget shows a clear message.
import { useRef, useState } from "react";
import { getAccessToken } from "@/integrations/neon/auth";

export function ImageUpload({
  value,
  onChange,
  accept = "image/*",
  label = "העלאת תמונה",
  className = "",
  preview = true,
  changeLabel = "החלפה",
  removeLabel = "הסרה",
  busyLabel = "מעלה…",
  uploadFile,
  capture,
  disabled = false,
}: {
  value?: string | null;
  onChange: (url: string) => void;
  accept?: string;
  label?: string;
  className?: string;
  preview?: boolean;
  changeLabel?: string;
  removeLabel?: string;
  busyLabel?: string;
  uploadFile?: (file: File) => Promise<string>;
  capture?: "user" | "environment";
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      // Sensitive documents can supply an authenticated, private transport.
      if (uploadFile) {
        onChange(await uploadFile(file));
        return;
      }
      const fd = new FormData();
      fd.append("file", file);
      // Attach the signed-in user's token when present (needed once uploads are
      // gated to authenticated users); harmless when storage allows public writes.
      const token = await getAccessToken().catch(() => null);
      const res = await fetch("/__api/files", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        throw new Error(data?.error || `Upload failed (${res.status})`);
      }
      onChange(data.url as string);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {preview && value ? (
        <img src={value} alt="" className="h-28 w-auto rounded-md border object-cover" />
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture}
        disabled={busy || disabled}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
          className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? busyLabel : value ? changeLabel : label}
        </button>
        {value ? (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => onChange("")}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {removeLabel}
          </button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">ההעלאה נכשלה. נסה שוב.</p> : null}
    </div>
  );
}
