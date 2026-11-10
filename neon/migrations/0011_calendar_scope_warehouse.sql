-- ============================================================================
-- 0011 — Calendar scope by role.
-- warehouse: read ALL events + event_days (no status/assignment filter).
-- crew:      read the events they are assigned to (shifts OR event_day_crew),
--            plus those events' event_days and their own shift rows.
-- admin / accounting / sales: unchanged.
-- ============================================================================

DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
      OR (public.has_permission('calendar','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('clients','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
      OR public.has_permission('quotes','view')
      OR public.has_permission('quotes','edit')
      OR public.has_permission('office','view')
    )
  )
  OR public.is_assigned_to_event(id)
  OR public.app_role() = 'warehouse'
);

DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event(event_id))
  OR public.is_assigned_to_event(event_id)
  OR public.app_role() = 'warehouse'
);
