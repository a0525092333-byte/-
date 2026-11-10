-- ============================================================================
-- 0012 — Event report fixes.
-- 1) is_assigned_to_event also matches event_day_crew assignments.
-- 2) event_crew_sheet authorizes warehouse + assigned crew and returns the item
--    name and description as SEPARATE fields (never collapses one into the other).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_assigned_to_event(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event AND e.sales_rep_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE d.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    public.is_admin()
    OR public.app_role() = 'warehouse'
    OR public.is_assigned_to_event(p_event)
    OR (
      public.is_full_scope()
      AND (
        public.has_permission('calendar','view')
        OR public.has_permission('crew','view')
        OR public.has_permission('clients','view')
      )
    )
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT q.id INTO v_quote
  FROM public.quotes q
  WHERE q.event_id = p_event
  ORDER BY (q.status = 'approved') DESC, q.created_at DESC
  LIMIT 1;

  IF v_quote IS NULL THEN
    v_items := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_name', s.name,
      'name', i.name,
      'description', NULLIF(i.description, ''),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'unit', i.unit,
      'is_optional', COALESCE(i.is_optional, false),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM (
    SELECT sh.crew_member_id FROM public.shifts sh WHERE sh.event_id = p_event
    UNION
    SELECT dc.crew_member_id
    FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    WHERE d.event_id = p_event
  ) x
  JOIN public.crew_members c ON c.id = x.crew_member_id;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;
GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
