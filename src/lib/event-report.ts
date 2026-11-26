import { getAccessToken } from "@/integrations/neon/auth";
import type { EquipmentChangeStatus, EquipmentChangeType } from "@/lib/types";

export type EventReportItem = {
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  is_optional: boolean;
  sort_order: number;
};

export type EventReportSection = {
  name: string | null;
  items: EventReportItem[];
};

export type EventReportDay = {
  day_date: string;
  warehouse_time: string | null;
  ready_time: string | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  sort_order: number;
  crew?: { name: string; role: string | null }[];
};

export type EventReportCrew = {
  name: string;
  role: string | null;
};

export type EventReportImage = {
  id: string;
  data_url: string;
  mime: string;
  caption: string | null;
};

export type EventReport = {
  event: {
    id: string;
    title: string;
    event_type: string;
    event_date: string;
    start_date: string | null;
    end_date: string | null;
    start_time: string | null;
    end_time: string | null;
    venue: string | null;
    address: string | null;
    guest_count: number | null;
    status: string;
    notes: string | null;
    field_notes?: string | null;
    contact_name?: string | null;
    contact_phone?: string | null;
    warehouse_time: string | null;
    ready_time: string | null;
    client_name: string | null;
  };
  days: EventReportDay[];
  sections: EventReportSection[];
  crew: EventReportCrew[];
  images?: EventReportImage[];
};

export const CHANGE_TYPE_META: Record<EquipmentChangeType, { label: string; sign: string; tone: string }> = {
  add: { label: "תוספת ציוד (+)", sign: "+", tone: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  remove: { label: "הורדת ציוד (-)", sign: "−", tone: "bg-amber-100 text-amber-900 border-amber-300" },
  swap: { label: "החלפת ציוד (⇄)", sign: "⇄", tone: "bg-indigo-100 text-indigo-900 border-indigo-300" },
};

export const CHANGE_STATUS_META: Record<EquipmentChangeStatus, { label: string; tone: string }> = {
  pending: { label: "ממתין לטיפול משרד", tone: "bg-red-100 text-red-800" },
  updated_quote: { label: "עודכן בהצעת מחיר", tone: "bg-emerald-100 text-emerald-800" },
  no_charge: { label: "אושר ללא חיוב נוסף", tone: "bg-sky-100 text-sky-800" },
  dismissed: { label: "נסגר", tone: "bg-muted text-muted-foreground" },
};

export async function fetchEventReport(
  eventId: string,
): Promise<{ ok: true; report: EventReport } | { ok: false; status: number; message: string }> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch(`/api/events/${eventId}/report`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        status: res.status,
        message: data?.message || "לא הצלחנו לטעון את דוח האירוע",
      };
    }
    return { ok: true, report: data as EventReport };
  } catch {
    return { ok: false, status: 0, message: "לא הצלחנו לטעון את דוח האירוע — בדוק את החיבור ונסה שוב" };
  }
}

export async function compressFieldPhoto(
  file: File,
  maxDim = 1440,
  quality = 0.78,
): Promise<{ dataUrl: string; mime: string }> {
  if (!file.type.startsWith("image/")) {
    throw new Error("נא לבחור קובץ תמונה תקין");
  }
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("לא הצלחנו לקרוא את התמונה"));
      el.src = bitmapUrl;
    });
    let { width, height } = img;
    if (width > maxDim || height > maxDim) {
      const ratio = Math.min(maxDim / width, maxDim / height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("דפדפן זה אינו תומך בעיבוד תמונה");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    return { dataUrl, mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}
// END OF FILE - src/lib/event-report.ts
