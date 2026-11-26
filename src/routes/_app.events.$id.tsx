import { Fragment, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Camera, PackagePlus, Printer, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useCompanySettings } from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import { ErrorState, LtrText, NoAccess, PageSkeleton } from "@/components/shared";
import { dateLong, dateShort, num, sameDisplayName, timeShort, weekdayShort } from "@/lib/format";
import {
  CHANGE_STATUS_META,
  CHANGE_TYPE_META,
  compressFieldPhoto,
  fetchEventReport,
} from "@/lib/event-report";
import { isMultiDayEvent } from "@/lib/events";
import type { EquipmentChangeType, EventEquipmentChange, EventFieldPhoto } from "@/lib/types";

export const Route = createFileRoute("/_app/events/$id_/crew-sheet")({ component: EventReportPage });

function EventReportPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { can, user, profile, isAdmin, isSuperAdmin } = useSession();
  const settingsQ = useCompanySettings(true);
  const [zoomImg, setZoomImg] = useState<{ url: string; caption?: string | null } | null>(null);

  // דיווח שינוי ציוד מהשטח (+/-)
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeType, setChangeType] = useState<EquipmentChangeType>("add");
  const [itemName, setItemName] = useState("");
  const [itemQty, setItemQty] = useState("1");
  const [itemUnit, setItemUnit] = useState("יח׳");
  const [changeReason, setChangeReason] = useState("");
  const [savingChange, setSavingChange] = useState(false);

  // העלאת תמונת ביצוע מהשטח
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photoCaption, setPhotoCaption] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const reportQ = useQuery({
    queryKey: ["event_report", id],
    queryFn: async () => {
      const result = await fetchEventReport(id);
      if (!result.ok) {
        const error = new Error(result.message) as Error & { status?: number };
        error.status = result.status;
        throw error;
      }
      return result.report;
    },
    retry: 0,
  });

  const changesQ = useQuery({
    queryKey: ["event_equipment_changes", id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data, error } = await db
        .from<EventEquipmentChange[]>("event_equipment_changes")
        .select("*")
        .eq("event_id", id)
        .order("created_at", { ascending: false });
      if (error) return [];
      return data ?? [];
    },
  });

  const fieldPhotosQ = useQuery({
    queryKey: ["event_field_photos", id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data, error } = await db
        .from<EventFieldPhoto[]>("event_field_photos")
        .select("*")
        .eq("event_id", id)
        .order("created_at", { ascending: false });
      if (error) return [];
      return data ?? [];
    },
  });

  if (reportQ.isLoading) return <PageSkeleton />;
  if (reportQ.error) {
    const status = (reportQ.error as Error & { status?: number }).status;
    if (status === 401 || status === 403) return <NoAccess moduleLabel="דוח אירוע" />;
    return <ErrorState message={reportQ.error.message} onRetry={() => reportQ.refetch()} />;
  }
  const report = reportQ.data;
  if (!report) return <ErrorState message="דוח האירוע לא נמצא." onRetry={() => reportQ.refetch()} />;

  const event = report.event;
  const days = report.days ?? [];
  const sections = report.sections ?? [];
  const crew = report.crew ?? [];
  const images = report.images ?? [];
  const eqChanges = changesQ.data ?? [];
  const fieldPhotos = fieldPhotosQ.data ?? [];
  const settings = settingsQ.data;
  const canCreateQuote = can("quotes", "edit");
  const multiDay = isMultiDayEvent(event, days);
  const scheduleDays = days.length
    ? days
    : [
        {
          day_date: event.event_date,
          warehouse_time: event.warehouse_time,
          ready_time: event.ready_time,
          start_time: event.start_time,
          end_time: event.end_time,
          notes: null,
          sort_order: 0,
        },
      ];
  const itemCount = sections.reduce((total, section) => total + section.items.length, 0);

  async function submitEquipmentChange() {
    if (!itemName.trim()) {
      toast.error("נא להזין את שם הפריט שהשתנה");
      return;
    }
    const qty = Math.max(0.5, Number(itemQty) || 1);
    setSavingChange(true);
    const { error } = await db.from("event_equipment_changes").insert({
      id: crypto.randomUUID(),
      event_id: id,
      change_type: changeType,
      item_name: itemName.trim(),
      quantity: qty,
      unit: itemUnit.trim() || null,
      reason: changeReason.trim() || null,
      source: profile?.role === "warehouse" ? "warehouse" : "field",
      status: "pending",
      reported_by: user?.id ?? null,
      reported_by_name: profile?.full_name ?? null,
    });
    setSavingChange(false);
    if (error) {
      toast.error("לא הצלחנו לשמור את הדיווח — ודא שהרצת את ה-SQL של שלב ב׳ ב-Neon");
      return;
    }
    toast.success("שינוי הציוד נשמר ונשלחה התראה למשרד לעדכון ההצעה");
    setItemName("");
    setItemQty("1");
    setChangeReason("");
    setChangeOpen(false);
    changesQ.refetch();
    qc.invalidateQueries({ queryKey: ["pending_equipment_changes"] });
  }

  async function handleFieldPhotoSelect(files: FileList | null) {
    if (!files || !files.length) return;
    setUploadingPhoto(true);
    try {
      for (const file of Array.from(files)) {
        const { dataUrl, mime } = await compressFieldPhoto(file);
        const { error } = await db.from("event_field_photos").insert({
          id: crypto.randomUUID(),
          event_id: id,
          data_url: dataUrl,
          mime,
          caption: photoCaption.trim() || null,
          uploaded_by: user?.id ?? null,
          uploaded_by_name: profile?.full_name ?? null,
        });
        if (error) throw new Error(error.message);
      }
      setPhotoCaption("");
      toast.success("התמונה נשמרה בתיעוד האירוע");
      fieldPhotosQ.refetch();
    } catch {
      toast.error("העלאת התמונה נכשלה — ודא שהרצת את ה-SQL של שלב ב׳ ב-Neon");
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function deleteFieldPhoto(photoId: string) {
    const { error } = await db.from("event_field_photos").delete().eq("id", photoId);
    if (error) {
      toast.error("לא הצלחנו למחוק את התמונה");
      return;
    }
    toast.success("התמונה הוסרה");
    fieldPhotosQ.refetch();
  }

  return (
    <div>
      <div className="print-hidden mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="outline">
          <Link to="/events/$id" params={{ id }}>
            <ArrowRight className="size-4" /> חזרה לאירוע
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setChangeOpen(true)}>
            <PackagePlus className="size-4 text-indigo-600" /> שינוי ציוד בשטח (+/-)
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={uploadingPhoto}
            onClick={() => fileInputRef.current?.click()}
          >
            <Camera className="size-4 text-emerald-600" /> {uploadingPhoto ? "שומר תמונה…" : "צילום מהשטח"}
          </Button>
          <Button type="button" variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" /> הדפסה / PDF
          </Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFieldPhotoSelect(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="quote-document mx-auto max-w-[210mm] bg-white p-6 text-black shadow-sm sm:p-10 print:max-w-none print:p-0 print:shadow-none">
        <div className="border-b-2 border-black pb-3">
          <div className="flex justify-center">
            {settings?.logo_url ? (
              <img src={settings.logo_url} alt="" className="brand-logo-print-lg" />
            ) : (
              <img src="/brand/logo-print.png" alt="" className="brand-logo-print-lg" />
            )}
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="text-start">
              <h1 className="text-xl font-bold">{settings?.company_name || "נס מולטימדיה"}</h1>
              <p className="mt-1 text-sm font-semibold">דוח אירוע</p>
            </div>
            <div className="text-start sm:text-end">
              <p className="text-lg font-bold">{event.title}</p>
              <p className="mt-1 text-sm">
                {multiDay && event.start_date && event.end_date
                  ? `${dateLong(event.start_date)} – ${dateLong(event.end_date)}`
                  : dateLong(event.event_date)}
              </p>
            </div>
          </div>
        </div>
        {event.address ? (
          <p className="mt-3 text-sm"><span className="font-semibold">כתובת האירוע:</span> {event.address}</p>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {event.contact_name ? (
            <div>
              <p className="text-xs font-semibold text-gray-600">איש קשר באירוע</p>
              <p className="text-sm">
                {event.contact_name}
                {event.contact_phone ? <> · <span dir="ltr">{event.contact_phone}</span></> : null}
              </p>
            </div>
          ) : null}
          {event.client_name && !sameDisplayName(event.client_name, event.title) ? (
            <div>
              <p className="text-xs font-semibold text-gray-600">לקוח</p>
              <p className="text-sm">{event.client_name}</p>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-semibold text-gray-600">סוג אירוע</p>
            <p className="text-sm">{event.event_type || "—"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-600">מקום</p>
            <p className="text-sm">{event.venue || "—"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-600">מספר משתתפים</p>
            <p className="text-sm">{event.guest_count ? num(event.guest_count) : "—"}</p>
          </div>
        </div>

        <div className="mt-5">
          <h2 className="mb-2 text-base font-bold">לוח זמנים</h2>
          <div className="space-y-3">
            {scheduleDays.map((day, index) => (
              <div key={`${day.day_date}-${index}`} className="rounded border border-gray-300 p-3">
                <p className="mb-1 text-sm font-bold">
                  {weekdayShort(day.day_date)} · {dateLong(day.day_date)}
                </p>
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    <tr className="border-b border-gray-200">
                      <td className="py-1 font-medium">שעת הגעה למחסן</td>
                      <td className="py-1 text-end">{timeShort(day.warehouse_time)}</td>
                    </tr>
                    <tr className="border-b border-gray-200">
                      <td className="py-1 font-medium">שעת מוכנות האירוע</td>
                      <td className="py-1 text-end">{timeShort(day.ready_time)}</td>
                    </tr>
                    <tr className="border-b border-gray-200">
                      <td className="py-1 font-medium">שעת התחלה</td>
                      <td className="py-1 text-end">{timeShort(day.start_time)}</td>
                    </tr>
                    <tr className="border-b border-gray-200">
                      <td className="py-1 font-medium">שעת סיום</td>
                      <td className="py-1 text-end">{timeShort(day.end_time)}</td>
                    </tr>
                  </tbody>
                </table>
                {day.crew?.length ? (
                  <p className="mt-1 text-sm">
                    צוות: {day.crew.map((member) => (member.role ? `${member.name} (${member.role})` : member.name)).join(", ")}
                  </p>
                ) : null}
                {day.notes ? <p className="mt-1 text-sm text-gray-700">הערה: {day.notes}</p> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <h2 className="mb-2 text-base font-bold">פריטים לאירוע</h2>
          {itemCount ? (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="w-10 py-1.5 text-start">#</th>
                  <th className="py-1.5 text-start">פריט</th>
                  <th className="w-16 py-1.5 text-start">כמות</th>
                  <th className="w-20 py-1.5 text-start">יחידה</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section, sectionIndex) => (
                  <Fragment key={`${section.name ?? "all"}-${sectionIndex}`}>
                    {sections.length > 1 ? (
                      <tr className="bg-gray-100">
                        <td colSpan={4} className="py-1.5 font-semibold">
                          {section.name || "כללי"}
                        </td>
                      </tr>
                    ) : null}
                    {section.items.map((item, itemIndex) => {
                      const itemNumber =
                        sections.slice(0, sectionIndex).reduce((total, group) => total + group.items.length, 0) +
                        itemIndex +
                        1;
                      return (
                        <tr key={`${sectionIndex}-${item.sort_order}-${item.name}-${itemIndex}`} className="border-b border-gray-200">
                          <td className="py-1.5">{itemNumber}</td>
                          <td className="py-1.5">
                            <span className="font-semibold"><LtrText>{item.name}</LtrText></span>
                            {item.is_optional ? (
                              <span className="ms-1 rounded bg-gray-200 px-1 py-0.5 text-[10px] font-medium">אופציונלי</span>
                            ) : null}
                            {item.description ? (
                              <p className="mt-0.5 text-xs text-gray-600"><LtrText>{item.description}</LtrText></p>
                            ) : null}
                          </td>
                          <td className="py-1.5">{num(item.quantity)}</td>
                          <td className="py-1.5">{item.unit || "—"}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="rounded border border-gray-300 p-3 text-sm text-gray-700">
              {canCreateQuote ? "אין עדיין פריטים להצגה — צור הצעת מחיר לאירוע" : "אין פריטים לאירוע"}
            </p>
          )}
        </div>

        {/* עדכוני ציוד חריגים שדווחו מהמחסן או מהשטח — מוצג לצוות בשטח בזמן אמת */}
        {eqChanges.filter((c) => c.status !== "dismissed").length > 0 ? (
          <div className="mt-5 rounded border-2 border-indigo-700 bg-indigo-50/40 p-3">
            <h2 className="mb-2 text-sm font-bold text-indigo-950">עדכוני ותוספות ציוד שדווחו (מחסן / שטח)</h2>
            <ul className="space-y-1.5 text-sm">
              {eqChanges
                .filter((c) => c.status !== "dismissed")
                .map((ch) => {
                  const meta = CHANGE_TYPE_META[ch.change_type];
                  const st = CHANGE_STATUS_META[ch.status];
                  return (
                    <li key={ch.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-200/70 pb-1 last:border-b-0">
                      <div>
                        <span className="font-bold">
                          {meta.sign} {ch.item_name} × {num(ch.quantity)} {ch.unit || ""}
                        </span>
                        {ch.reason ? <span className="text-xs text-gray-700"> — {ch.reason}</span> : null}
                        <span className="ms-1.5 text-[11px] text-gray-600">
                          ({ch.reported_by_name || "צוות"})
                        </span>
                      </div>
                      <span className={`print-hidden rounded px-1.5 py-0.5 text-[10px] font-bold ${st.tone}`}>
                        {st.label}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </div>
        ) : null}

        {images.length ? (
          <div className="mt-5">
            <h2 className="mb-2 text-base font-bold">תמונות וסקיצות לאירוע</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {images.map((image, index) => (
                <figure key={image.id || index} className="break-inside-avoid rounded border border-gray-300 p-1.5">
                  <button
                    type="button"
                    onClick={() => setZoomImg({ url: image.data_url, caption: image.caption })}
                    className="block w-full cursor-zoom-in print:cursor-default"
                    aria-label={image.caption || `הגדלת תמונה ${index + 1}`}
                  >
                    <img
                      src={image.data_url}
                      alt={image.caption || `תמונה ${index + 1}`}
                      className="max-h-52 w-full rounded object-contain print:max-h-60"
                    />
                  </button>
                  {image.caption ? (
                    <figcaption className="mt-1 text-center text-xs text-gray-700">{image.caption}</figcaption>
                  ) : null}
                </figure>
              ))}
            </div>
          </div>
        ) : null}

        {event.field_notes ? (
          <div className="mt-5 rounded border-2 border-gray-800 p-3">
            <h2 className="mb-2 text-base font-bold">הערות לצוות שטח ומחסנאי</h2>
            <p className="whitespace-pre-line text-sm">{event.field_notes}</p>
          </div>
        ) : null}

        {event.notes ? (
          <div className="mt-5">
            <h2 className="mb-2 text-base font-bold">הערות לאירוע</h2>
            <p className="whitespace-pre-line text-sm">{event.notes}</p>
          </div>
        ) : null}

        <div className="mt-5">
          <h2 className="mb-2 text-base font-bold">צוות מאושר לאירוע</h2>
          {crew.length ? (
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {crew.map((member, index) => (
                <li key={`${member.name}-${index}`} className="border-b border-gray-200 py-1">
                  {member.name}
                  {member.role ? <span className="text-gray-600"> · {member.role}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-700">לא שובץ צוות לאירוע</p>
          )}
        </div>
      </div>

      {/* אזור תיעוד ביצוע מהשטח (מוסתר בהדפסת הדוח הרגיל, גלוי בנייד ובמחשב) */}
      <div className="print-hidden mx-auto mt-5 max-w-[210mm] rounded-xl border border-border bg-card p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-foreground">תיעוד תמונות ביצוע מהשטח ({fieldPhotos.length})</h2>
            <p className="text-xs text-muted-foreground">נשמר בכרטיס האירוע כהוכחת הקמה וזיכרון לשנה הבאה (אינו נשלח ב-PDF ללקוח)</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={photoCaption}
              onChange={(e) => setPhotoCaption(e.target.value)}
              placeholder="כיתוב קצר לפני צילום (אופציונלי)"
              className="h-9 w-48 text-xs"
            />
            <Button type="button" size="sm" disabled={uploadingPhoto} onClick={() => fileInputRef.current?.click()}>
              <Camera className="size-4" /> {uploadingPhoto ? "מעלה…" : "צלם / העלה תמונה"}
            </Button>
          </div>
        </div>

        {fieldPhotos.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {fieldPhotos.map((ph) => {
              const canDel = isSuperAdmin || isAdmin || ph.uploaded_by === user?.id;
              return (
                <div key={ph.id} className="group relative rounded-lg border border-border bg-background p-1.5">
                  <button
                    type="button"
                    onClick={() => setZoomImg({ url: ph.data_url, caption: ph.caption || `${ph.uploaded_by_name || "צוות"} · ${dateShort(ph.created_at)}` })}
                    className="block w-full"
                  >
                    <img src={ph.data_url} alt={ph.caption || "תמונת שטח"} className="h-28 w-full rounded object-cover" />
                  </button>
                  <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
                    <span className="truncate">{ph.caption || ph.uploaded_by_name || "צילום שטח"}</span>
                    {canDel ? (
                      <button
                        type="button"
                        onClick={() => deleteFieldPhoto(ph.id)}
                        className="text-red-600 hover:text-red-800"
                        aria-label="מחיקת תמונה"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* חלונית דיווח שינוי ציוד מהשטח (+/-) */}
      <Dialog
        open={changeOpen}
        onOpenChange={(v) => { if (!savingChange) setChangeOpen(v); }}
        title="דיווח שינוי ציוד באירוע (+/-)"
        description="הדיווח מעדכן את דוח האירוע ושולח התראה מיידית לסוכני המכירות ולמנהל לעדכון הצעת המחיר"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setChangeOpen(false)} disabled={savingChange}>ביטול</Button>
            <Button type="button" onClick={submitEquipmentChange} disabled={savingChange}>
              {savingChange ? "שולח…" : "שמירה ושליחת התראה למשרד"}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            {(["add", "remove", "swap"] as EquipmentChangeType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setChangeType(t)}
                className={`rounded-lg border px-2 py-2 text-xs font-bold ${
                  changeType === t ? `${CHANGE_TYPE_META[t].tone} ring-2 ring-primary/30` : "border-border bg-background text-muted-foreground"
                }`}
              >
                {CHANGE_TYPE_META[t].label}
              </button>
            ))}
          </div>
          <Field label="שם הפריט *" htmlFor="chg-item">
            <Input
              id="chg-item"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="לדוגמה: מיקרופון מדונה אלחוטי / מוניטור במה"
              className="h-10"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="כמות" htmlFor="chg-qty">
              <Input id="chg-qty" type="number" min="0.5" step="0.5" value={itemQty} onChange={(e) => setItemQty(e.target.value)} className="h-10" />
            </Field>
            <Field label="יחידה" htmlFor="chg-unit">
              <Input id="chg-unit" value={itemUnit} onChange={(e) => setItemUnit(e.target.value)} placeholder="יח׳ / מ״ר / סט" className="h-10" />
            </Field>
          </div>
          <Field label="סיבה / מי ביקש בשטח" htmlFor="chg-reason">
            <Input
              id="chg-reason"
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder="לדוגמה: לבקשת המפיק באולם נוספו 2 מדונות"
              className="h-10"
            />
          </Field>
        </div>
      </Dialog>

      {zoomImg ? (
        <div
          role="dialog"
          aria-modal="true"
          className="print-hidden fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setZoomImg(null)}
        >
          <div className="relative max-h-[90vh] max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setZoomImg(null)}
              className="absolute -top-10 end-0 inline-flex items-center gap-1 rounded-md bg-white/90 px-2.5 py-1 text-xs font-semibold text-black hover:bg-white"
            >
              <X className="size-4" /> סגירה
            </button>
            <img
              src={zoomImg.url}
              alt={zoomImg.caption || "תמונה מוגדלת"}
              className="max-h-[82vh] w-auto rounded-lg bg-white object-contain shadow-xl"
            />
            {zoomImg.caption ? (
              <p className="mt-2 text-center text-sm font-medium text-white">{zoomImg.caption}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
// END OF FILE - src/routes/_app.events.$id_.crew-sheet.tsx
