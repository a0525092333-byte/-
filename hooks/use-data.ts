import { useQuery } from "@tanstack/react-query";
import { db } from "@/integrations/neon/client";
import type {
  Client,
  CrewMember,
  CrewDocument,
  DocumentRow,
  EquipmentAssignment,
  EquipmentItem,
  EventRow,
  EventWithBudget,
  EventDay,
  EventDayCrew,
  FinanceEntry,
  Meeting,
  Profile,
  Shift,
  UserPermission,
  Invite,
  TimeEntry,
  TimeEntryAddition,
  Quote,
  QuoteSection,
  QuoteImage,
  QuoteItem,
  QuoteVersion,
  PriceCatalogItem,
  CompanySettings,
  PaperlessDocument,
} from "@/lib/types";

function rows<T>(data: T[] | null, error: { message: string } | null): T[] {
  if (error) throw new Error(error.message);
  return data ?? [];
}

type DbError = { message: string; code?: string };

function isSchemaCacheError(error: DbError | null): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST205" ||
    /schema cache/i.test(error.message) ||
    /Could not find the table/i.test(error.message)
  );
}

async function withSchemaCacheRetry<T>(
  run: () => Promise<{ data: T[] | null; error: DbError | null }>,
): Promise<T[]> {
  let result = await run();
  if (result.error && isSchemaCacheError(result.error)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result = await run();
  }
  if (result.error) {
    if (isSchemaCacheError(result.error)) {
      throw new Error("מודול שעון הנוכחות עדיין בהקמה — נסה שוב בעוד דקה");
    }
    throw new Error(result.error.message);
  }
  return result.data ?? [];
}

export function useEvents(enabled = true) {
  return useQuery({
    queryKey: ["events"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<EventRow[]>("events")
        .select("*")
        .order("event_date", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useEventsWithBudget(enabled = true) {
  return useQuery({
    queryKey: ["events", "with-budget"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<EventWithBudget[]>("events")
        .select("*, quotes!quotes_event_id_fkey(grand_total, created_at)")
        .order("event_date", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useEventsRange(startDate: string, endDate: string, enabled = true) {
  return useQuery({
    queryKey: ["events", "range", startDate, endDate],
    enabled: enabled && Boolean(startDate && endDate),
    queryFn: async () => {
      const { data, error } = await db
        .from<EventRow[]>("events")
        .select("*")
        .gte("event_date", startDate)
        .lte("event_date", endDate)
        .order("event_date", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useClients(enabled = true) {
  return useQuery({
    queryKey: ["clients"],
    enabled,
    queryFn: async () => {
      // The Data API caps a single response (often 1000 rows). Fetch every page
      // so the manager can always reach the full client base, then sort by name.
      const pageSize = 1000;
      const all: Client[] = [];
      for (let offset = 0; offset < 200_000; offset += pageSize) {
        const { data, error } = await db
          .from<Client[]>("clients")
          .select("*")
          .order("id", { ascending: true })
          .limit(pageSize)
          .offset(offset);
        if (error) throw new Error(error.message);
        const page = data ?? [];
        all.push(...page);
        if (page.length < pageSize) break;
      }
      return all.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "he"));
    },
  });
}

export function useMeetings(enabled = true) {
  return useQuery({
    queryKey: ["meetings"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<Meeting[]>("meetings")
        .select("*")
        .order("starts_at", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useFinance(enabled = true) {
  return useQuery({
    queryKey: ["finance_entries"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<FinanceEntry[]>("finance_entries")
        .select("*")
        .order("issued_at", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useCrewMembers(enabled = true) {
  return useQuery({
    queryKey: ["crew_members"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<CrewMember[]>("crew_members")
        .select("*")
        .order("full_name", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useCrewDocuments(crewMemberId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["crew_documents", crewMemberId ?? "all"],
    enabled,
    queryFn: async () => {
      let query = db
        .from<CrewDocument[]>("crew_documents")
        .select("*")
        .order("uploaded_at", { ascending: false });
      if (crewMemberId) query = query.eq("crew_member_id", crewMemberId);
      const { data, error } = await query;
      return rows(data, error);
    },
  });
}

export function useShifts(enabled = true) {
  return useQuery({
    queryKey: ["shifts"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<Shift[]>("shifts")
        .select("*")
        .order("starts_at", { ascending: true });
      return rows(data, error);
    },
  });
}

export type EventCrewSheetData = {
  items: { section_name: string | null; description: string; quantity: number; sort_order: number }[];
  crew: string[];
};

export function useEventCrewSheet(eventId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["event_crew_sheet", eventId],
    enabled: enabled && Boolean(eventId),
    queryFn: async () => {
      const { data, error } = await db.rpc<EventCrewSheetData>("event_crew_sheet", { p_event: eventId });
      if (error) throw new Error(error.message);
      return data ?? { items: [], crew: [] };
    },
  });
}

export function useEquipment(enabled = true) {
  return useQuery({
    queryKey: ["equipment_items"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<EquipmentItem[]>("equipment_items")
        .select("*")
        .order("name", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useAssignments(enabled = true) {
  return useQuery({
    queryKey: ["equipment_assignments"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<EquipmentAssignment[]>("equipment_assignments")
        .select("*")
        .order("out_at", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useDocuments(enabled = true) {
  return useQuery({
    queryKey: ["documents"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<DocumentRow[]>("documents")
        .select("*")
        .order("created_at", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useProfiles(enabled = true) {
  return useQuery({
    queryKey: ["profiles"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from<Profile[]>("profiles").select("*").order("full_name", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useAllPermissions(enabled = true) {
  return useQuery({
    queryKey: ["all_permissions"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from<UserPermission[]>("user_permissions").select("*");
      return rows(data, error);
    },
  });
}

export function useInvites(enabled = true) {
  return useQuery({
    queryKey: ["invites"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<Invite[]>("invites")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useTimeEntries(
  enabled = true,
  range?: { from: string; to: string },
  userId?: string | null,
) {
  return useQuery({
    queryKey: ["time_entries", range?.from ?? "all", range?.to ?? "all", userId ?? "all"],
    enabled,
    retry: 0,
    queryFn: async () =>
      withSchemaCacheRetry(async () => {
        let query = db.from<TimeEntry[]>("time_entries").select("*");
        if (range) query = query.gte("work_date", range.from).lte("work_date", range.to);
        if (userId) query = query.eq("user_id", userId);
        return await query.order("work_date", { ascending: false });
      }),
  });
}

export function useTimeEntryAdditions(enabled = true, userId?: string | null) {
  return useQuery({
    queryKey: ["time_entry_additions", userId ?? "all"],
    enabled,
    retry: 0,
    queryFn: async () =>
      withSchemaCacheRetry(async () => {
        let query = db.from<TimeEntryAddition[]>("time_entry_additions").select("*");
        if (userId) {
          const own = await db.from<{ id: string }[]>("time_entries").select("id").eq("user_id", userId);
          if (own.error) return { data: null, error: own.error };
          const ids = (own.data ?? []).map((e) => e.id);
          if (!ids.length) return { data: [], error: null };
          query = query.in("entry_id", ids);
        }
        return await query.order("created_at", { ascending: true });
      }),
  });
}

export function useQuotes(enabled = true) {
  return useQuery({
    queryKey: ["quotes"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from<Quote[]>("quotes").select("*").order("created_at", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useQuote(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["quote", id],
    enabled: enabled && !!id,
    queryFn: async () => {
      const { data, error } = await db.from<Quote[]>("quotes").select("*").eq("id", id).limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
}

export function useQuoteSections(quoteId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["quote_sections", quoteId],
    enabled: enabled && !!quoteId,
    queryFn: async () => {
      const { data, error } = await db
        .from<QuoteSection[]>("quote_sections")
        .select("*")
        .eq("quote_id", quoteId)
        .order("sort_order", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useQuoteItems(quoteId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["quote_items", quoteId],
    enabled: enabled && !!quoteId,
    queryFn: async () => {
      const { data, error } = await db
        .from<QuoteItem[]>("quote_items")
        .select("*")
        .eq("quote_id", quoteId)
        .order("sort_order", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useQuoteVersions(quoteId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["quote_versions", quoteId],
    enabled: enabled && !!quoteId,
    queryFn: async () => {
      const { data, error } = await db
        .from<QuoteVersion[]>("quote_versions")
        .select("*")
        .eq("quote_id", quoteId)
        .order("version_number", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useAllQuoteItems(enabled = true) {
  return useQuery({
    queryKey: ["quote_items_all"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from<QuoteItem[]>("quote_items").select("*");
      return rows(data, error);
    },
  });
}

export function usePriceCatalog(enabled = true) {
  return useQuery({
    queryKey: ["price_catalog"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<PriceCatalogItem[]>("price_catalog")
        .select("*")
        .eq("is_active", true)
        .order("section", { ascending: true })
        .order("name", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useCompanySettings(enabled = true) {
  return useQuery({
    queryKey: ["company_settings"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from<CompanySettings[]>("company_settings").select("id, company_name, logo_url, tax_id, address, phone, email, default_vat_rate, default_terms, default_terms_text, default_notes, quote_number_prefix, paperless_environment, paperless_base_url, paperless_auth_style, paperless_document_path, backup_drive_enabled, backup_drive_url, backup_drive_folder, updated_at").eq("id", 1).limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
}

export function usePaperlessDocuments(enabled = true) {
  return useQuery({
    queryKey: ["paperless_documents"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<PaperlessDocument[]>("paperless_documents")
        .select("*")
        .order("created_at", { ascending: false });
      return rows(data, error);
    },
  });
}

export function useQuoteImages(quoteId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["quote_images", quoteId],
    enabled: enabled && !!quoteId,
    queryFn: async () => {
      const { data, error } = await db
        .from<QuoteImage[]>("quote_images")
        .select("*")
        .eq("quote_id", quoteId)
        .order("position", { ascending: true });
      return rows(data, error);
    },
  });
}

export function useEventDays(eventId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ["event_days", eventId ?? "all"],
    enabled,
    queryFn: async () => {
      let query = db
        .from<EventDay[]>("event_days")
        .select("*")
        .order("day_date", { ascending: true });
      if (eventId) query = query.eq("event_id", eventId);
      const { data, error } = await query;
      return rows(data, error);
    },
  });
}

export function useEventDayCrew(enabled = true) {
  return useQuery({
    queryKey: ["event_day_crew"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db
        .from<EventDayCrew[]>("event_day_crew")
        .select("*")
        .order("created_at", { ascending: true });
      return rows(data, error);
    },
  });
}

export type EventDayCrewName = { name: string; role: string | null };

export function useEventDayCrewNames(eventId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["event_day_crew_names", eventId],
    enabled: enabled && Boolean(eventId),
    retry: 0,
    queryFn: async () => {
      const { data, error } = await db.rpc<Record<string, EventDayCrewName[]>>("event_day_crew_names", {
        p_event: eventId,
      });
      // A permission denial must not break the event page — show no names.
      if (error) return {};
      return data ?? {};
    },
  });
}

export type PasswordResetRow = {
  id: string;
  admin_id: string | null;
  target_user_id: string | null;
  target_email: string | null;
  method: string;
  created_at: string;
};

export function usePasswordResets(enabled = true) {
  return useQuery({
    queryKey: ["password_resets"],
    enabled,
    retry: 0,
    queryFn: async () => {
      const { data, error } = await db
        .from<PasswordResetRow[]>("password_resets")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}
