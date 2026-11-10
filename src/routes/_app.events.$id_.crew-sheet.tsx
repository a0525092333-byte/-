import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Printer } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useCompanySettings } from "@/hooks/use-data";
import { Button } from "@/components/ui/button";
import { ErrorState, LtrText, NoAccess, PageSkeleton } from "@/components/shared";
import { dateLong, num, sameDisplayName, timeShort, weekdayShort } from "@/lib/format";
import { fetchEventReport } from "@/lib/event-report";
import { isMultiDayEvent } from "@/lib/events";

export const Route = createFileRoute("/_app/events/$id_/crew-sheet")({ component: EventReportPage });

function EventReportPage() {
  const { id } = Route.useParams();
  const { can, isAdmin } = useSession();
  const settingsQ = useCompanySettings(true);
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

  return (
    <div>
      <div className="print-hidden mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="outline">
          <Link to="/events/$id" params={{ id }}>
            <ArrowRight className="size-4" /> חזרה לאירוע
          </Link>
        </Button>
        <Button type="button" variant="outline" onClick={() => window.print()}>
          <Printer className="size-4" /> הדפסה / שמירה כ-PDF
        </Button>
      </div>

      <div className="quote-document mx-auto max-w-[210mm] bg-white p-6 text-black shadow-sm sm:p-10 print:max-w-none print:p-0 print:shadow-none">
        <div className="border-b-2 border-black pb-3">
          <div className="flex justify-center">
            <img src="/brand/logo-print.png" alt="" className="brand-logo-print-lg" />
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
    </div>
  );
}
