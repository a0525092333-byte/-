/**
 * UI CONFIG ONLY — brand name + navigation labels.
 * Business content lives in Neon and is fetched at runtime.
 */
export const site = {
  name: "נס מולטימדיה",
  tagline: "מערכת ניהול הפקות אירועים",
  nav: [
    { label: "סקירה", to: "/", module: "dashboard", icon: "dashboard" },
    { label: "יומן", to: "/calendar", module: "calendar", icon: "calendar" },
    { label: "מצב משרד", to: "/office", module: "office", icon: "office" },
    { label: "אירועים", to: "/events", module: "clients", icon: "events" },
    { label: "לקוחות", to: "/clients", module: "clients", icon: "clients" },
    { label: "כספים", to: "/finance", module: "finance", icon: "finance" },
    { label: "צוות בשטח", to: "/crew", module: "crew", icon: "crew" },
    { label: "שעון נוכחות", to: "/attendance", module: "attendance", icon: "clock" },
    { label: "דוח חודשי", to: "/attendance-report", module: "attendance", icon: "report" },
    { label: "המסמכים שלי", to: "/my-documents", module: "attendance", icon: "report" },
    { label: "ציוד ומחסן", to: "/equipment", module: "equipment", icon: "equipment" },
    { label: "ניהול משתמשים", to: "/users", module: "users", icon: "users" },
    { label: "גיבוי", to: "/backup", module: "backup", icon: "backup" },
    { label: "הפרופיל שלי", to: "/settings", module: "settings", icon: "settings" },
  ],
} as const;

export type NavItem = (typeof site.nav)[number];
