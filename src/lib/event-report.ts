import { getAccessToken } from "@/integrations/neon/auth";

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
};

export async function fetchEventReport(
  eventId: string,
): Promise<{ ok: true; report: EventReport } | { ok: false; status: number; message: string }> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch(`/api/events/${eventId}/report`, {
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
