import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./use-auth";
import { db } from "@/integrations/neon/client";
import type { Module, Profile, UserPermission } from "@/lib/types";
import { can as canFn, isSuperAdmin as isSuperAdminEmail } from "@/lib/permissions";

export function useSession() {
  const { user, loading: authLoading } = useAuth();

  // Claiming runs before profile loading so a newly registered invitee receives
  // the invited role instead of being offered the generic profile wizard.
  const inviteClaimQuery = useQuery({
    queryKey: ["claim_invite", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await db.rpc<boolean>("claim_invite");
      return data === true;
    },
    staleTime: Infinity,
    retry: 0,
  });

  const profileQuery = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user?.id && !inviteClaimQuery.isLoading,
    queryFn: async () => {
      const { data, error } = await db
        .from<Profile[]>("profiles")
        .select("*")
        .eq("id", user!.id);
      if (error) throw new Error(error.message);
      return (data ?? [])[0] ?? null;
    },
    staleTime: 20_000,
  });

  const permsQuery = useQuery({
    queryKey: ["permissions", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await db
        .from<UserPermission[]>("user_permissions")
        .select("*")
        .eq("user_id", user!.id);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    staleTime: 20_000,
  });

  // The authoritative admin flag is the DB function auth.is_admin(), which reads
  // the Neon Auth role. profiles.role is only a fallback (it may lag behind the
  // platform grant). A failed call must never block the app or log the user out.
  const adminQuery = useQuery({
    queryKey: ["is_admin", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await db.rpc<boolean>("is_admin");
      if (error) return false;
      return data === true;
    },
    staleTime: 20_000,
    retry: 0,
  });

  const superAdminQuery = useQuery({
    queryKey: ["is_super_admin", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await db.rpc<boolean>("is_super_admin");
      if (error) return false;
      return data === true;
    },
    staleTime: 20_000,
    retry: 0,
  });

  const profile = profileQuery.data ?? null;
  const isAdmin =
    adminQuery.data === true ||
    (profile?.role === "admin" && profile?.is_active !== false) ||
    user?.role === "admin";
  const isSuperAdmin = superAdminQuery.data === true || isSuperAdminEmail(user?.email);
  const effectiveRole = isAdmin ? "admin" : profile?.role ?? "sales";
  const perms = permsQuery.data ?? [];

  // Self-heal: the Neon Auth role is authoritative. If the auth role is admin but
  // the profile row still says sales, update the caller's own profile. The existing
  // self-update policy allows this, and the protect trigger permits it because
  // is_admin() is true for this user. Never blocks the app or logs the user out.
  useEffect(() => {
    if (adminQuery.data !== true) return;
    if (!profile || profile.role === "admin") return;
    let cancelled = false;
    db.from("profiles")
      .update({ role: "admin" })
      .eq("id", profile.id)
      .then(({ error }) => {
        if (!cancelled && !error) profileQuery.refetch();
      });
    return () => {
      cancelled = true;
    };
  }, [adminQuery.data, profile?.id, profile?.role]);

  const can = (module: Module, action: "view" | "edit" = "view") =>
    canFn(perms, isSuperAdmin, module, action);
  const canView = (module: Module) => canFn(perms, isSuperAdmin, module, "view");
  const canEdit = (module: Module) => canFn(perms, isSuperAdmin, module, "edit");

  return {
    user,
    authLoading,
    profile,
    profileLoading: profileQuery.isLoading,
    profileError: profileQuery.error as Error | null,
    perms,
    permsLoading: permsQuery.isLoading,
    adminLoading: adminQuery.isLoading,
    superAdminLoading: superAdminQuery.isLoading,
    isAdmin,
    isSuperAdmin,
    effectiveRole,
    can,
    canView,
    canEdit,
    refetchProfile: profileQuery.refetch,
    refetchPerms: permsQuery.refetch,
  };
}
