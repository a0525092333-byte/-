-- 0028: only the account owner (a0525092333@gmail.com, via is_super_admin())
-- may DELETE events. A RESTRICTIVE policy is AND-ed with every permissive policy
-- (events_edit FOR ALL), so admins / the permissions matrix can no longer delete.
-- INSERT/UPDATE/SELECT are untouched. Idempotent: drop-then-create. No data changes.
DROP POLICY IF EXISTS events_delete_owner_only ON public.events;
CREATE POLICY events_delete_owner_only ON public.events
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_super_admin());

NOTIFY pgrst, 'reload schema';
