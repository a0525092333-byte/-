/**
 * Single source of truth for crew roles.
 *
 * The canonical list is what every picker offers. A crew member may hold
 * several roles at once (stored in `crew_members.crew_roles`); `role_title`
 * stays as a compatibility column mirroring the first role.
 *
 * Stored values that are not in the canonical list (e.g. a role that was
 * removed from the picker) are still returned by `crewRoles()` and offered
 * by `crewRoleOptions()` so they remain displayable and editable.
 */

export const CREW_ROLES = [
  "טכנאי",
  "מכירות",
  "הגברה",
  "תאורה",
  "אחר",
  "מחסנאי",
  "סאונדמן",
] as const;

export type CrewRole = (typeof CREW_ROLES)[number];

type RoleSource = {
  crew_roles?: string[] | null;
  role_title?: string | null;
} | null | undefined;

/** All roles for a crew member, falling back to `role_title` when the array is empty. */
export function crewRoles(member: RoleSource): string[] {
  if (!member) return [];
  const stored = (member.crew_roles ?? [])
    .map((role) => (role ?? "").trim())
    .filter(Boolean);
  if (stored.length) return stored;
  const single = (member.role_title ?? "").trim();
  return single ? [single] : [];
}

/** Comma-joined roles for compact display; empty string when none. */
export function crewRolesLabel(member: RoleSource): string {
  return crewRoles(member).join(", ");
}

/** Canonical roles plus any custom stored values, for the picker. */
export function crewRoleOptions(member?: RoleSource): string[] {
  const stored = crewRoles(member);
  const extras = stored.filter((role) => !(CREW_ROLES as readonly string[]).includes(role));
  return [...CREW_ROLES, ...extras];
}

/** True when the member holds the given role. */
export function hasCrewRole(member: RoleSource, role: string): boolean {
  return crewRoles(member).includes(role);
}
