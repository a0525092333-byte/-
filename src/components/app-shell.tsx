import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Boxes,
  Briefcase,
  DatabaseBackup,
  CalendarDays,
  Clock,
  FileText,
  HardHat,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  PartyPopper,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { site } from "@/content/site";
import { useProfiles } from "@/hooks/use-data";
import { ROLE_LABELS } from "@/lib/permissions";
import { homeRouteFor } from "@/lib/roles";
import { isFullScope } from "@/lib/scope";
import type { Module, Profile } from "@/lib/types";
import { Avatar } from "@/components/shared";
import { Sheet } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { OfficeWindow } from "@/components/office/office-window";

const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  calendar: CalendarDays,
  office: Briefcase,
  backup: DatabaseBackup,
  clock: Clock,
  report: FileText,
  events: PartyPopper,
  clients: Users,
  finance: Wallet,
  crew: HardHat,
  equipment: Boxes,
  users: ShieldCheck,
  settings: Settings,
};

type NavEntry = (typeof site.nav)[number];

const RESTRICTED_LABELS: Record<string, string> = {
  "/": "הסיכום שלי",
  "/calendar": "היומן שלי",
  "/events": "האירועים שלי",
  "/office": "המשמרות שלי",
  "/attendance": "הנוכחות שלי",
  "/attendance-report": "הדוח החודשי שלי",
  "/my-documents": "המסמכים שלי",
  "/crew": "הכרטיס שלי",
};

function useVisibleNav(
  can: (m: Module, a?: "view" | "edit") => boolean,
  isSuperAdmin: boolean,
  fullScope: boolean,
) {
  return React.useMemo(() => {
    // Only the owner account bypasses the matrix.
    if (isSuperAdmin) return [...site.nav];
    if (!fullScope) {
      const allowed = new Set([
        "/",
        "/calendar",
        "/events",
        "/office",
        "/attendance",
        "/attendance-report",
        "/my-documents",
        "/crew",
        "/settings",
      ]);
      return site.nav
        .filter((item) => allowed.has(item.to) || (item.to === "/equipment" && can("equipment", "view")))
        .map((item) => ({ ...item, label: RESTRICTED_LABELS[item.to] ?? item.label })) as unknown as NavEntry[];
    }
    return site.nav.filter((item) => {
      if (item.module === "dashboard" || item.module === "settings") return true;
      if (item.module === "users") return can("users", "view");
      if (item.to === "/events") {
        return (
          can("clients", "view") ||
          can("calendar", "view") ||
          can("crew", "view") ||
          can("finance", "view") ||
          can("equipment", "view")
        );
      }
      return can(item.module as Module, "view");
    });
  }, [can, isSuperAdmin, fullScope]);
}

function NavLink({ item, onNavigate, badge }: { item: NavEntry; onNavigate?: () => void; badge?: number }) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      activeOptions={{ exact: item.to === "/" }}
      className="group flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      activeProps={{ className: "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground" }}
    >
      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
      {badge ? (
        <span className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function NavButton({ item, onActivate, badge }: { item: NavEntry; onActivate: () => void; badge?: number }) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;
  return (
    <button
      type="button"
      onClick={onActivate}
      className="group flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
    >
      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
      {badge ? (
        <span className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function AppShell({
  profile,
  isAdmin,
  isSuperAdmin,
  can,
  onLogout,
  children,
}: {
  profile: Profile;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  can: (m: Module, a?: "view" | "edit") => boolean;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [officeOpen, setOfficeOpen] = React.useState(false);
  const navigate = useNavigate();
  const fullScope = isFullScope(profile, isAdmin);
  const canSearch = can("search");
  const visibleNav = useVisibleNav(can, isSuperAdmin, fullScope);
  const home = homeRouteFor(profile.role);
  const safeHome = can(home === "/attendance" ? "attendance" : "calendar", "view")
    ? home
    : can("calendar", "view")
      ? "/calendar"
      : can("attendance", "view")
        ? "/attendance"
        : "/";
  const nav = React.useMemo(() => {
    const hasRealHome = visibleNav.some((item) => item.module !== "dashboard" && item.to === safeHome);
    return visibleNav
      .filter((item) => item.module !== "dashboard" || !hasRealHome)
      .map((item) => {
        if (item.module !== "dashboard") return item;
        return {
          ...item,
          to: safeHome,
          label: fullScope ? item.label : (RESTRICTED_LABELS[safeHome] ?? item.label),
        } as unknown as NavEntry;
      });
  }, [visibleNav, safeHome, fullScope]);
  const canUsers = can("users", "view");
  const profilesQ = useProfiles(canUsers);
  const pendingCount = canUsers
    ? (profilesQ.data ?? []).filter((profile) => profile.approval_status === "pending").length
    : 0;

  const primaryModule: Module = !fullScope
    ? "calendar"
    : (["finance", "clients", "calendar", "quotes", "crew", "equipment", "office", "attendance", "search", "users", "backup"] as Module[])
        .find((m) => can(m, "view")) ?? "calendar";

  const mobileNav = React.useMemo(() => {
    const priority = [
      safeHome,
      "/calendar",
      "/attendance",
      "/events",
      "/office",
      "/my-documents",
      `/${primaryModule === "clients" ? "clients" : primaryModule}`,
      "/clients",
      "/finance",
      "/crew",
      "/equipment",
      "/users",
    ];
    const picked: NavEntry[] = [];
    for (const path of priority) {
      const found = nav.find((n) => n.to === path);
      if (found && !picked.some((p) => p.to === found.to)) picked.push(found);
      if (picked.length === 4) break;
    }
    return picked;
  }, [nav, primaryModule, safeHome]);

  const logout = () => {
    onLogout();
            navigate({ to: "/login", search: { invite: undefined } });
  };

  return (
    <div className="min-h-dvh bg-background">
      {/* Desktop sidebar — right side in RTL */}
      <aside className="fixed inset-y-0 right-0 z-30 hidden w-64 flex-col border-l border-border bg-card lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <img src="/brand/logo.jpeg" alt="" className="h-8 w-auto shrink-0 rounded object-contain" />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-foreground">{site.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{site.tagline}</p>
          </div>
        </div>
        {canSearch ? (
          <div className="px-3 pb-2">
            <Link
              to="/search"
              className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Search className="size-4" />
              <span className="truncate">חיפוש בכל המערכת…</span>
            </Link>
          </div>
        ) : null}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="ניווט ראשי">
          {nav.map((item) =>
            item.to === "/office" ? (
              <NavButton key={item.to} item={item} onActivate={() => setOfficeOpen(true)} />
            ) : (
              <NavLink key={item.to} item={item} badge={item.to === "/users" ? pendingCount : undefined} />
            ),
          )}
        </nav>
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-muted/60 p-2.5">
            <Avatar name={profile.full_name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{profile.full_name}</p>
              <p className="truncate text-xs text-muted-foreground">{ROLE_LABELS[isAdmin ? "admin" : profile.role] ?? profile.role}</p>
            </div>
            <button
              type="button"
              onClick={logout}
              aria-label="התנתקות"
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-destructive focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              <LogOut className="size-4" />
            </button>
          </div>
          <Link
            to="/set-password"
            className="mt-2 flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <KeyRound className="size-4" />
            שינוי סיסמה
          </Link>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur lg:hidden">
        <div className="flex items-center gap-2">
          <img src="/brand/logo.jpeg" alt="" className="h-8 w-auto shrink-0 rounded object-contain" />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight text-foreground">{site.name}</p>
            <p className="truncate text-[10px] leading-tight text-muted-foreground">{profile.full_name}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {canSearch ? (
            <Link
              to="/search"
              aria-label="חיפוש בכל המערכת"
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              <Search className="size-5" />
            </Link>
          ) : null}
          <button
            type="button"
            onClick={logout}
            aria-label="התנתקות"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <LogOut className="size-5" />
          </button>
        </div>
      </header>

      <main className="pb-[calc(var(--bottom-nav-height)+1rem)] lg:pr-64 lg:pb-8">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>

      {/* Mobile bottom navigation */}
      <nav
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        aria-label="ניווט תחתון"
      >
        <div className="flex w-full">
          {mobileNav.map((item) => {
            const Icon = ICONS[item.icon] ?? LayoutDashboard;
            if (item.to === "/office") {
              return (
                <button
                  key={item.to}
                  type="button"
                  onClick={() => setOfficeOpen(true)}
                  className="flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-medium leading-tight text-muted-foreground"
                >
                  <Icon className="size-5 shrink-0" aria-hidden="true" />
                  <span className="w-full truncate text-center leading-tight">{item.label}</span>
                </button>
              );
            }
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className="flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-medium leading-tight text-muted-foreground"
                activeProps={{ className: "text-primary" }}
              >
                <Icon className="size-5 shrink-0" aria-hidden="true" />
                <span className="w-full truncate text-center leading-tight">{item.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-medium leading-tight text-muted-foreground"
          >
            <MoreHorizontal className="size-5 shrink-0" aria-hidden="true" />
            <span className="w-full truncate text-center leading-tight">עוד</span>
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title="כל המודולים" description={site.tagline}>
        <div className="space-y-1">
          {nav.map((item) =>
            item.to === "/office" ? (
              <NavButton
                key={item.to}
                item={item}
                onActivate={() => {
                  setMoreOpen(false);
                  setOfficeOpen(true);
                }}
              />
            ) : (
              <NavLink
                key={item.to}
                item={item}
                badge={item.to === "/users" ? pendingCount : undefined}
                onNavigate={() => setMoreOpen(false)}
              />
            ),
          )}
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <Link
            to="/set-password"
            onClick={() => setMoreOpen(false)}
            className="mb-2 flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <KeyRound className="size-4" />
            שינוי סיסמה
          </Link>
          <Button type="button" variant="outline" className="w-full" onClick={logout}>
            <LogOut className="size-4" />
            התנתקות
          </Button>
        </div>
      </Sheet>

      {officeOpen ? <OfficeWindow open onClose={() => setOfficeOpen(false)} /> : null}
    </div>
  );
}
