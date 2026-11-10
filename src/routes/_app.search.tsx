import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BookOpen,
  Briefcase,
  CalendarDays,
  Clock,
  FileText,
  HardHat,
  Package,
  Receipt,
  Search,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { db } from "@/integrations/neon/client";
import { NoAccess } from "@/components/shared";
import { Input } from "@/components/ui/input";
import { dateShort, money } from "@/lib/format";
import {
  dateMatches,
  highlightParts,
  matchesAllTerms,
  parseDateQuery,
  scoreText,
  searchTerms,
} from "@/lib/search";
import { crewRolesLabel } from "@/lib/crew-roles";
import type {
  Client,
  CrewMember,
  DocumentRow,
  EquipmentItem,
  EventRow,
  FinanceEntry,
  Meeting,
  PriceCatalogItem,
  Profile,
  Quote,
  TimeEntry,
} from "@/lib/types";

export const Route = createFileRoute("/_app/search")({ component: SearchPage });

type SearchRow = {
  id: string;
  primary: string;
  secondary: string;
  href: string;
  params?: Record<string, string>;
  score: number;
  date?: string | null;
};

type SearchGroup = {
  type: string;
  label: string;
  icon: LucideIcon;
  rows: SearchRow[];
};

const RECENT_KEY = "vincen:search:recent";
const MAX_RECENT = 6;
const TYPE_ORDER = [
  "events",
  "clients",
  "quotes",
  "crew",
  "equipment",
  "users",
  "attendance",
  "finance",
  "meetings",
  "price_catalog",
  "documents",
];

function readRecent(): string[] {
  try {
    const raw = sessionStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function writeRecent(values: string[]) {
  try {
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(values.slice(0, MAX_RECENT)));
  } catch {
    /* sessionStorage may be unavailable */
  }
}

function topRows(rows: SearchRow[]): SearchRow[] {
  return rows
    .sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, 8);
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded bg-accent px-0.5 text-accent-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function SearchPage() {
  const { can, isAdmin } = useSession();
  const canSearch = can("search");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const requestRef = useRef(0);

  const canEvents = can("calendar") || can("clients");
  const canClients = can("clients");
  const canQuotes = can("quotes");
  const canCrew = can("crew");
  const canEquipment = can("equipment");
  const canUsers = can("users");
  const canAttendance = can("attendance");
  const canFinance = can("finance");
  const canMeetings = can("calendar");
  const canDocuments = can("clients") || can("calendar") || can("finance") || can("crew") || can("equipment");

  const availableTypes = useMemo(() => {
    const types: { type: string; label: string }[] = [];
    if (canEvents) types.push({ type: "events", label: "אירועים" });
    if (canClients) types.push({ type: "clients", label: "לקוחות" });
    if (canQuotes) types.push({ type: "quotes", label: "הצעות מחיר" });
    if (canCrew) types.push({ type: "crew", label: "צוות" });
    if (canEquipment) types.push({ type: "equipment", label: "ציוד" });
    if (canUsers) types.push({ type: "users", label: "משתמשים" });
    if (canAttendance) types.push({ type: "attendance", label: "נוכחות" });
    if (canFinance) types.push({ type: "finance", label: "כספים" });
    if (canMeetings) types.push({ type: "meetings", label: "פגישות" });
    if (canQuotes) types.push({ type: "price_catalog", label: "מחירון" });
    if (canDocuments) types.push({ type: "documents", label: "מסמכים" });
    return types;
  }, [canEvents, canClients, canQuotes, canCrew, canEquipment, canUsers, canAttendance, canFinance, canMeetings, canDocuments]);

  const runSearch = useCallback(
    async (rawQuery: string, signal: AbortSignal): Promise<SearchGroup[]> => {
      const terms = searchTerms(rawQuery);
      if (!terms.length) return [];
      const isoDate = parseDateQuery(rawQuery);
      const groups: SearchGroup[] = [];
      const jobs: Promise<void>[] = [];

      if (canEvents) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<EventRow[]>("events")
              .select("id,title,event_type,venue,address,notes,sales_rep_name,status,event_date,start_date,end_date,client_id")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((event) => {
                const hay = [event.title, event.event_type, event.venue, event.address, event.notes, event.sales_rep_name, event.status].join(" ");
                const dateHit = isoDate ? [event.event_date, event.start_date, event.end_date].some((value) => dateMatches(value, isoDate)) : false;
                if (!matchesAllTerms(hay, terms) && !dateHit) return null;
                return {
                  id: event.id,
                  primary: event.title,
                  secondary: [event.event_type, event.venue, event.event_date ? dateShort(event.event_date) : ""].filter(Boolean).join(" · "),
                  href: "/events/$id",
                  params: { id: event.id },
                  score: scoreText(event.title, hay, terms) + (dateHit ? 30 : 0),
                  date: event.event_date,
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "events", label: "אירועים", icon: CalendarDays, rows: topRows(rows) });
          })(),
        );
      }

      if (canClients) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<Client[]>("clients")
              .select("id,name,company,contact_name,phone,email,address,notes")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((client) => {
                const hay = [client.name, client.company, client.contact_name, client.phone, client.email, client.address, client.notes].join(" ");
                if (!matchesAllTerms(hay, terms)) return null;
                return {
                  id: client.id,
                  primary: client.name,
                  secondary: [client.company, client.phone, client.email].filter(Boolean).join(" · "),
                  href: "/clients",
                  score: scoreText(client.name, hay, terms),
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "clients", label: "לקוחות", icon: Users, rows: topRows(rows) });
          })(),
        );
      }

      if (canQuotes) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<Quote[]>("quotes")
              .select("id,quote_number,client_name,venue,notes,quote_date,status,event_id,client_id")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((quote) => {
                const hay = [quote.quote_number, quote.client_name, quote.venue, quote.notes, quote.status].join(" ");
                const dateHit = isoDate ? dateMatches(quote.quote_date, isoDate) : false;
                if (!matchesAllTerms(hay, terms) && !dateHit) return null;
                return {
                  id: quote.id,
                  primary: `הצעה ${quote.quote_number}`,
                  secondary: [quote.client_name, quote.venue, quote.quote_date ? dateShort(quote.quote_date) : ""].filter(Boolean).join(" · "),
                  href: "/quotes/$id",
                  params: { id: quote.id },
                  score: scoreText(quote.quote_number, hay, terms) + (dateHit ? 30 : 0),
                  date: quote.quote_date,
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "quotes", label: "הצעות מחיר", icon: FileText, rows: topRows(rows) });
          })(),
        );
      }

      if (canCrew) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<CrewMember[]>("crew_members")
              .select("id,full_name,phone,email,role_title,crew_roles,is_active,user_id")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((member) => {
                const hay = [member.full_name, member.phone, member.email, crewRolesLabel(member)].join(" ");
                if (!matchesAllTerms(hay, terms)) return null;
                return {
                  id: member.id,
                  primary: member.full_name,
                  secondary: [crewRolesLabel(member), member.phone].filter(Boolean).join(" · "),
                  href: "/crew",
                  score: scoreText(member.full_name, hay, terms),
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "crew", label: "צוות", icon: HardHat, rows: topRows(rows) });
          })(),
        );
      }

      if (canEquipment) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<EquipmentItem[]>("equipment_items")
              .select("id,name,category,notes,status")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((item) => {
                const hay = [item.name, item.category, item.notes, item.status].join(" ");
                if (!matchesAllTerms(hay, terms)) return null;
                return {
                  id: item.id,
                  primary: item.name,
                  secondary: [item.category, item.status].filter(Boolean).join(" · "),
                  href: "/equipment",
                  score: scoreText(item.name, hay, terms),
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "equipment", label: "ציוד", icon: Package, rows: topRows(rows) });
          })(),
        );
      }

      if (canUsers) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<Profile[]>("profiles")
              .select("id,full_name,email,phone,role,approval_status")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((profile) => {
                const hay = [profile.full_name, profile.email, profile.phone, profile.role].join(" ");
                if (!matchesAllTerms(hay, terms)) return null;
                return {
                  id: profile.id,
                  primary: profile.full_name,
                  secondary: [profile.email, profile.phone].filter(Boolean).join(" · "),
                  href: "/users",
                  score: scoreText(profile.full_name, hay, terms),
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "users", label: "משתמשים", icon: Users, rows: topRows(rows) });
          })(),
        );
      }

      if (canAttendance) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<TimeEntry[]>("time_entries")
              .select("id,work_date,note,event_id,user_id,day_type")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((entry) => {
                const hay = [entry.note, entry.day_type, entry.work_date].join(" ");
                const dateHit = isoDate ? dateMatches(entry.work_date, isoDate) : false;
                if (!matchesAllTerms(hay, terms) && !dateHit) return null;
                return {
                  id: entry.id,
                  primary: entry.note || `דיווח ${entry.work_date}`,
                  secondary: [entry.day_type, entry.work_date ? dateShort(entry.work_date) : ""].filter(Boolean).join(" · "),
                  href: "/attendance",
                  score: scoreText(entry.note ?? "", hay, terms) + (dateHit ? 30 : 0),
                  date: entry.work_date,
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "attendance", label: "נוכחות", icon: Clock, rows: topRows(rows) });
          })(),
        );
      }

      if (canFinance) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<FinanceEntry[]>("finance_entries")
              .select("id,kind,doc_number,notes,amount,status,issued_at")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((entry) => {
                const hay = [entry.kind, entry.doc_number, entry.notes, entry.status].join(" ");
                const dateHit = isoDate ? dateMatches(entry.issued_at, isoDate) : false;
                if (!matchesAllTerms(hay, terms) && !dateHit) return null;
                return {
                  id: entry.id,
                  primary: [entry.kind, entry.doc_number].filter(Boolean).join(" "),
                  secondary: [entry.status, entry.amount != null ? money(entry.amount) : "", entry.issued_at ? dateShort(entry.issued_at) : ""]
                    .filter(Boolean)
                    .join(" · "),
                  href: "/finance",
                  score: scoreText(entry.doc_number ?? entry.kind, hay, terms) + (dateHit ? 30 : 0),
                  date: entry.issued_at,
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "finance", label: "כספים", icon: Wallet, rows: topRows(rows) });
          })(),
        );
      }

      if (canMeetings) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<Meeting[]>("meetings")
              .select("id,title,location,notes,kind,starts_at")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((meeting) => {
                const hay = [meeting.title, meeting.location, meeting.notes, meeting.kind].join(" ");
                const dateHit = isoDate ? dateMatches(meeting.starts_at, isoDate) : false;
                if (!matchesAllTerms(hay, terms) && !dateHit) return null;
                return {
                  id: meeting.id,
                  primary: meeting.title,
                  secondary: [meeting.kind, meeting.location, meeting.starts_at ? dateShort(meeting.starts_at) : ""].filter(Boolean).join(" · "),
                  href: "/calendar",
                  score: scoreText(meeting.title, hay, terms) + (dateHit ? 30 : 0),
                  date: meeting.starts_at,
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "meetings", label: "פגישות", icon: Briefcase, rows: topRows(rows) });
          })(),
        );
      }

      if (canQuotes) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<PriceCatalogItem[]>("price_catalog")
              .select("id,code,name,description,section,unit,default_price")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((item) => {
                const hay = [item.code, item.name, item.description, item.section, item.unit].join(" ");
                if (!matchesAllTerms(hay, terms)) return null;
                return {
                  id: item.id,
                  primary: item.name,
                  secondary: [item.code, item.section, item.unit].filter(Boolean).join(" · "),
                  href: "/quotes/new",
                  score: scoreText(item.name, hay, terms),
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "price_catalog", label: "מחירון", icon: BookOpen, rows: topRows(rows) });
          })(),
        );
      }

      if (canDocuments) {
        jobs.push(
          (async () => {
            const { data } = await db
              .from<DocumentRow[]>("documents")
              .select("id,event_id,name,url,created_at")
              .limit(500)
              .signal(signal);
            const rows = (data ?? [])
              .map((doc) => {
                if (!matchesAllTerms(doc.name, terms)) return null;
                return {
                  id: doc.id,
                  primary: doc.name,
                  secondary: doc.created_at ? dateShort(doc.created_at) : "",
                  href: doc.event_id ? "/events/$id" : "/clients",
                  params: doc.event_id ? { id: doc.event_id } : undefined,
                  score: scoreText(doc.name, doc.name, terms),
                  date: doc.created_at,
                } as SearchRow;
              })
              .filter(Boolean) as SearchRow[];
            if (rows.length) groups.push({ type: "documents", label: "מסמכים", icon: Receipt, rows: topRows(rows) });
          })(),
        );
      }

      await Promise.all(jobs);
      return groups.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
    },
    [canEvents, canClients, canQuotes, canCrew, canEquipment, canUsers, canAttendance, canFinance, canMeetings, canDocuments],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!canSearch) return;
    if (debounced.length < 2) {
      setGroups([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestId = ++requestRef.current;
    setLoading(true);
    void runSearch(debounced, controller.signal)
      .then((next) => {
        if (requestId !== requestRef.current) return;
        setGroups(next);
        setLoading(false);
      })
      .catch(() => {
        if (requestId !== requestRef.current) return;
        setGroups([]);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debounced, canSearch, runSearch]);

  if (!canSearch) {
    return <NoAccess moduleLabel="חיפוש חכם" />;
  }

  const terms = searchTerms(debounced);
  const visibleGroups = groups.filter((group) => activeTypes.size === 0 || activeTypes.has(group.type));
  const total = visibleGroups.reduce((sum, group) => sum + group.rows.length, 0);

  function toggleType(type: string) {
    setActiveTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function remember(value: string) {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    setRecent((current) => {
      const next = [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, MAX_RECENT);
      writeRecent(next);
      return next;
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="sticky top-[var(--mobile-header-height)] z-10 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:top-0">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") remember(query);
            }}
            placeholder="חיפוש בכל המערכת…"
            aria-label="חיפוש בכל המערכת"
            className="h-12 ps-10 pe-10 text-base"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="ניקוי החיפוש"
              className="absolute end-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        {availableTypes.length ? (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setActiveTypes(new Set())}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                activeTypes.size === 0 ? "border-primary bg-accent text-accent-foreground" : "border-border text-muted-foreground"
              }`}
            >
              הכל
            </button>
            {availableTypes.map((type) => (
              <button
                key={type.type}
                type="button"
                onClick={() => toggleType(type.type)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
                  activeTypes.has(type.type) ? "border-primary bg-accent text-accent-foreground" : "border-border text-muted-foreground"
                }`}
              >
                {type.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="pt-4">
        {!query.trim() ? (
          <div>
            {recent.length ? (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">חיפושים אחרונים</p>
                <ul className="space-y-1">
                  {recent.map((value) => (
                    <li key={value} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                      <button type="button" onClick={() => setQuery(value)} className="min-w-0 flex-1 truncate text-start text-sm text-foreground">
                        {value}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const next = recent.filter((item) => item !== value);
                          setRecent(next);
                          writeRecent(next);
                        }}
                        aria-label={`הסרת ${value} מהחיפושים האחרונים`}
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">הקלידו לפחות שתי אותיות כדי לחפש בכל המערכת.</p>
            )}
          </div>
        ) : debounced.length < 2 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">הקלידו לפחות שתי אותיות כדי לחפש בכל המערכת.</p>
        ) : loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-16 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : total === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">לא נמצאו תוצאות עבור "{debounced}".</p>
        ) : (
          <div className="space-y-5">
            {visibleGroups.map((group) => {
              const Icon = group.icon;
              return (
                <section key={group.type}>
                  <div className="mb-2 flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">{group.label}</h2>
                    <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">{group.rows.length}</span>
                  </div>
                  <ul className="space-y-1.5">
                    {group.rows.map((row) => (
                      <li key={`${group.type}-${row.id}`}>
                        <Link
                          to={row.href as any}
                          params={row.params as any}
                          onClick={() => remember(debounced)}
                          className="block rounded-xl border border-border bg-card px-3 py-2.5 transition-colors hover:bg-muted"
                        >
                          <p className="truncate text-sm font-semibold text-foreground">
                            <Highlight text={row.primary} terms={terms} />
                          </p>
                          {row.secondary ? (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              <Highlight text={row.secondary} terms={terms} />
                            </p>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
