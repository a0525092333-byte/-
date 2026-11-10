import type { CrewMember, Profile } from "./types";

const EXCLUDED_ROLES = new Set(["admin", "accounting"]);

export function normalizeCrewName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * One shared source for the people who may be assigned to events.
 * Dedupes by normalized name and drops anyone whose linked profile is an
 * admin or accounting user. Sales, warehouse, crew and unlinked rows stay.
 */
export function assignableCrew(rows: CrewMember[], profiles: Profile[] = []): CrewMember[] {
  const roleById = new Map(profiles.map((profile) => [profile.id, profile.role]));
  const seen = new Set<string>();
  const out: CrewMember[] = [];
  for (const row of rows) {
    const role = row.user_id ? roleById.get(row.user_id) : undefined;
    if (role && EXCLUDED_ROLES.has(role)) continue;
    const key = normalizeCrewName(row.full_name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function findCrewByName(rows: CrewMember[], name: string): CrewMember | undefined {
  const key = normalizeCrewName(name);
  if (!key) return undefined;
  return rows.find((row) => normalizeCrewName(row.full_name) === key);
}
