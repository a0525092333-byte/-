import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSession } from "@/hooks/use-session";
import { can as canFn, firstAllowedPath } from "@/lib/permissions";
import { PageSkeleton } from "@/components/shared";

export const Route = createFileRoute("/_app/")({ component: HomeRedirect });

function HomeRedirect() {
  const { profile, perms, isSuperAdmin } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!profile) return;
    const target = firstAllowedPath((module, action) => canFn(perms, isSuperAdmin, module, action));
    navigate({ to: target, replace: true });
  }, [profile, perms, isSuperAdmin, navigate]);

  return <PageSkeleton />;
}
