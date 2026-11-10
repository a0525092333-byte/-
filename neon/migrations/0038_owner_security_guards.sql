-- Keep these owner-only overrides last in the consolidated migration.
-- Complete existing audit storage without touching existing rows or permissions.
ALTER TABLE public.audit_logs ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.audit_logs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.audit_logs ALTER COLUMN details SET DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.security_actor(p_module text, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE uid text := nullif(auth.user_id()::text, ''); mail text; stored_role text;
  owner_account boolean := false; permitted boolean := false;
BEGIN
  IF uid IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT u.email FROM neon_auth."user" u
        WHERE u.id::text = $1 AND coalesce(u.banned, false) = false' INTO mail USING uid;
    EXCEPTION WHEN undefined_table OR undefined_column THEN mail := NULL;
    END;
    IF mail IS NOT NULL THEN
      owner_account := lower(mail) = 'a0525092333@gmail.com';
      SELECT p.role INTO stored_role FROM public.profiles p WHERE p.id::text = uid;
      IF p_action IN ('view','edit') AND p_module = ANY(public._security_modules()) THEN
        permitted := owner_account OR EXISTS (
          SELECT 1 FROM public.profiles p JOIN public.user_permissions up ON up.user_id = p.id
          WHERE p.id::text = uid AND p.is_active IS TRUE AND p.approval_status = 'approved'
            AND up.module = p_module AND CASE WHEN p_action = 'edit' THEN up.can_edit ELSE up.can_view OR up.can_edit END
        );
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('user_id',uid,'email',mail,'role',stored_role,
    'is_owner',owner_account,'allowed',coalesce(permitted,false));
END $fn$;

CREATE OR REPLACE FUNCTION public._security_owner_ids() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE ids text[];
BEGIN
  EXECUTE 'SELECT coalesce(array_agg(u.id::text), ARRAY[]::text[]) FROM neon_auth."user" u
    WHERE lower(u.email) = ''a0525092333@gmail.com''' INTO ids;
  RETURN ids;
END $fn$;

CREATE OR REPLACE FUNCTION public._security_can_audit() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT coalesce((public.security_actor('users','view')->>'is_owner')::boolean,false);
$fn$;

-- Restrict browser permission administration even if an admin has users.edit.
DROP POLICY IF EXISTS security_permissions_owner_insert ON public.user_permissions;
CREATE POLICY security_permissions_owner_insert ON public.user_permissions AS RESTRICTIVE
  FOR INSERT TO authenticated, anonymous WITH CHECK (public._security_can_audit());
DROP POLICY IF EXISTS security_permissions_owner_update ON public.user_permissions;
CREATE POLICY security_permissions_owner_update ON public.user_permissions AS RESTRICTIVE
  FOR UPDATE TO authenticated, anonymous USING (public._security_can_audit()) WITH CHECK (public._security_can_audit());
DROP POLICY IF EXISTS security_permissions_owner_delete ON public.user_permissions;
CREATE POLICY security_permissions_owner_delete ON public.user_permissions AS RESTRICTIVE
  FOR DELETE TO authenticated, anonymous USING (public._security_can_audit());

CREATE OR REPLACE FUNCTION public._security_guard_access_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- Nested auth/invite synchronization remains a trusted database operation.
  IF pg_trigger_depth() = 1 AND nullif(auth.user_id()::text,'') IS NOT NULL
    AND NOT public._security_can_audit() THEN
    RAISE EXCEPTION 'Owner-only permission administration' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public._security_guard_access_fields() FROM PUBLIC, anonymous, authenticated;
DROP TRIGGER IF EXISTS security_owner_profile_access ON public.profiles;
CREATE TRIGGER security_owner_profile_access BEFORE UPDATE OF role, is_active, approval_status ON public.profiles
  FOR EACH ROW WHEN (ROW(OLD.role,OLD.is_active,OLD.approval_status) IS DISTINCT FROM ROW(NEW.role,NEW.is_active,NEW.approval_status))
  EXECUTE FUNCTION public._security_guard_access_fields();
DO $fn$ BEGIN
  IF to_regclass('public.invites') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS security_owner_invites ON public.invites;
    CREATE TRIGGER security_owner_invites BEFORE INSERT OR UPDATE OR DELETE ON public.invites
      FOR EACH ROW EXECUTE FUNCTION public._security_guard_access_fields();
  END IF;
END $fn$;

DO $fn$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_permissions'::regclass AND conname = 'security_edit_requires_view') THEN
    ALTER TABLE public.user_permissions ADD CONSTRAINT security_edit_requires_view
      CHECK (can_edit IS NOT TRUE OR can_view IS TRUE) NOT VALID;
  END IF;
END $fn$;

ALTER FUNCTION public._security_clean_details(jsonb) SECURITY DEFINER;
DO $fn$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    GRANT EXECUTE ON FUNCTION public._security_clean_details(jsonb) TO site_server;
  END IF;
END $fn$;
NOTIFY pgrst, 'reload schema';
