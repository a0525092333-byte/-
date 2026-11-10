/** The only valid stored event status values, in workflow order. */
export const EVENT_STATUSES = ["ממתין לסגירה", "נסגר", "ממתין לתשלום", "שולם"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const DEFAULT_EVENT_STATUS: EventStatus = "ממתין לסגירה";

/** Display labels for stored event status values. */
export const EVENT_STATUS_LABELS: Record<string, string> = {
  "ממתין לסגירה": "ממתין לסגירה",
  נסגר: "נסגר",
  "ממתין לתשלום": "ממתין לתשלום",
  שולם: "שולם",
};

/** Calm standard pill/chip colors: soft background, readable dark text, light border. */
export const EVENT_STATUS_SOLID: Record<string, string> = {
  "ממתין לסגירה": "bg-amber-100 text-amber-900 border-amber-300",
  נסגר: "bg-blue-100 text-blue-900 border-blue-300",
  "ממתין לתשלום": "bg-red-100 text-red-800 border-red-300",
  שולם: "bg-green-100 text-green-900 border-green-300",
};

/** Light card variant for the day details (dark body text, soft tinted border). */
export const EVENT_STATUS_CARD: Record<string, string> = {
  "ממתין לסגירה": "bg-amber-50 border-amber-200",
  נסגר: "bg-blue-50 border-blue-200",
  "ממתין לתשלום": "bg-red-50 border-red-200",
  שולם: "bg-green-50 border-green-200",
};

export function formatStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return EVENT_STATUS_LABELS[status] ?? status;
}
