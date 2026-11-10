-- 0024: the per-user permissions matrix is the only module gate.
-- Admin role no longer bypasses the matrix; the owner account keeps full access.

CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF auth.user_id() IS NULL OR auth.user_id() = '' THEN RETURN false; END IF;

  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM neon_auth."user" u
      WHERE u.id::text = auth.user_id()
      AND lower(u.email) = ''a0525092333@gmail.com'')' INTO ok;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  IF ok THEN RETURN true; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id::text = auth.user_id()
        AND lower(p.email) = 'a0525092333@gmail.com'
    ) INTO ok;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_permission(p_module text, p_action text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_approved() THEN RETURN false; END IF;
  IF public.is_super_admin() THEN RETURN true; END IF;
  IF p_action = 'edit' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_edit
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND (up.can_view OR up.can_edit)
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text) TO authenticated;

DROP POLICY IF EXISTS user_permissions_admin_write ON public.user_permissions;
CREATE POLICY user_permissions_admin_write ON public.user_permissions FOR ALL TO authenticated
USING (public.is_super_admin() OR public.has_permission('users','edit'))
WITH CHECK (public.is_super_admin() OR public.has_permission('users','edit'));

DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR (
    public.is_full_scope()
    AND (
      public.is_super_admin()
      OR public.has_permission('users','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('clients','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
      OR public.has_permission('attendance','view')
      OR public.has_permission('attendance','edit')
    )
  )
);

DROP POLICY IF EXISTS profiles_update_self_or_admin ON public.profiles;
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated
USING (
  id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','edit')
  OR public.has_permission('attendance','edit')
)
WITH CHECK (
  id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','edit')
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (
  (public.is_full_scope() AND (public.has_permission('crew','edit') OR public.has_permission('office','edit')))
  OR (public.has_permission('crew','edit') AND public.is_assigned_to_event(event_id))
)
WITH CHECK (
  (public.is_full_scope() AND (public.has_permission('crew','edit') OR public.has_permission('office','edit')))
  OR (public.has_permission('crew','edit') AND public.is_assigned_to_event(event_id))
);

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
