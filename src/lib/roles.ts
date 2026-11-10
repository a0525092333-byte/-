import type { Role } from "./types";

/**
 * Single source of truth for where each role lands after sign-in and for the
 * home entry in the navigation. Admin / sales / accounting go to the calendar;
 * crew / warehouse go to the attendance clock.
 */
const ROLE_HOME: Record<Role, "/calendar" | "/attendance"> = {
  admin: "/calendar",
  sales: "/calendar",
  accounting: "/calendar",
  crew: "/attendance",
  warehouse: "/attendance",
};

export type HomeRoute = "/calendar" | "/attendance";

export function homeRouteFor(role: Role | null | undefined): HomeRoute {
  if (!role) return "/calendar";
  return ROLE_HOME[role] ?? "/calendar";
}
