import { useSession } from "@/hooks/use-session";
import type { Profile, Role } from "./types";

export const PRIVILEGED_ROLES: Role[] = ["admin", "sales", "accounting"];

export function isFullScope(profile: Profile | null | undefined, isAdmin = false): boolean {
  if (isAdmin) return true;
  const role = profile?.role;
  return role === "admin" || role === "sales" || role === "accounting";
}

export function useScope() {
  const { profile, isAdmin } = useSession();
  return { profile, isAdmin, isFullScope: isFullScope(profile, isAdmin) };
}
