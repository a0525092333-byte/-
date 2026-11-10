-- ============================================================================
-- Self-scope data isolation for non-privileged roles.
-- Privileged = admin / sales / accounting (behaviour unchanged).
-- Restricted (crew, warehouse, future roles) see only their own assignments.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_full_scope() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN public.is_admin() OR public.app_role() IN ('admin','sales','accounting');
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_full_scope() TO authenticated;

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

CREATE OR REPLACE FUNCTION public.can_see_client(p_client uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF public.is_full_scope() THEN RETURN TRUE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.client_id = p_client AND public.is_assigned_to_event(e.id)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.can_see_client(uuid) TO authenticated;

-- ── events ─────────────────────────────────────────────────────────────────
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
);

DROP POLICY IF EXISTS events_edit ON public.events;
CREATE POLICY events_edit ON public.events FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
)
WITH CHECK (
  public.is_full_scope()
  AND public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
);

-- ── clients ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.can_see_client(id)
);

DROP POLICY IF EXISTS clients_edit ON public.clients;
CREATE POLICY clients_edit ON public.clients FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('clients','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('clients','edit'));

-- ── crew members ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS crew_members_read ON public.crew_members;
CREATE POLICY crew_members_read ON public.crew_members FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (public.has_permission('crew','view') OR public.has_permission('office','view'))
  )
  OR user_id::text = auth.user_id()
);

DROP POLICY IF EXISTS crew_members_edit ON public.crew_members;
CREATE POLICY crew_members_edit ON public.crew_members FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('crew','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('crew','edit'));

-- ── shifts ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS shifts_read ON public.shifts;
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (public.has_permission('office','view') OR public.has_permission('crew','view'))
  )
  OR crew_member_id IN (
    SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id()
  )
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
)
WITH CHECK (
  public.is_full_scope()
  AND (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
);

-- ── event days / day crew ──────────────────────────────────────────────────
DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event(event_id))
  OR public.is_assigned_to_event(event_id)
);

DROP POLICY IF EXISTS event_days_write ON public.event_days;
CREATE POLICY event_days_write ON public.event_days FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
  )
)
WITH CHECK (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
  )
);

DROP POLICY IF EXISTS event_day_crew_read ON public.event_day_crew;
CREATE POLICY event_day_crew_read ON public.event_day_crew FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event_day(event_day_id))
  OR EXISTS (
    SELECT 1 FROM public.event_days d
    WHERE d.id = event_day_id AND public.is_assigned_to_event(d.event_id)
  )
);

DROP POLICY IF EXISTS event_day_crew_write ON public.event_day_crew;
CREATE POLICY event_day_crew_write ON public.event_day_crew FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
  )
)
WITH CHECK (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
  )
);

-- ── quotes / proposals (privileged only) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.owns_quote(p_quote uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_full_scope() THEN RETURN FALSE; END IF;
  IF NOT public.is_approved() AND NOT public.is_admin() THEN RETURN FALSE; END IF;
  IF public.is_admin() OR public.has_permission('quotes','edit') THEN RETURN TRUE; END IF;
  IF NOT p_write AND public.has_permission('quotes','view') THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.id = p_quote AND q.created_by::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.owns_quote(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS quotes_read ON public.quotes;
CREATE POLICY quotes_read ON public.quotes FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','view')
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_insert ON public.quotes;
CREATE POLICY quotes_insert ON public.quotes FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_update ON public.quotes;
CREATE POLICY quotes_update ON public.quotes FOR UPDATE TO authenticated
USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
)
WITH CHECK (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_delete ON public.quotes;
CREATE POLICY quotes_delete ON public.quotes FOR DELETE TO authenticated USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
  )
);

-- ── finance / invoices / payments (privileged only) ────────────────────────
DROP POLICY IF EXISTS finance_read ON public.finance_entries;
CREATE POLICY finance_read ON public.finance_entries FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.has_permission('finance','view')
    OR public.has_permission('finance','edit')
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS finance_insert ON public.finance_entries;
CREATE POLICY finance_insert ON public.finance_entries FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    (public.has_permission('finance','edit') AND created_by::text = auth.user_id())
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS finance_update ON public.finance_entries;
CREATE POLICY finance_update ON public.finance_entries FOR UPDATE TO authenticated
USING (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()))
WITH CHECK (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()));

DROP POLICY IF EXISTS finance_delete ON public.finance_entries;
CREATE POLICY finance_delete ON public.finance_entries FOR DELETE TO authenticated
USING (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()));

-- ── price catalog / paperless (privileged only) ────────────────────────────
DROP POLICY IF EXISTS price_catalog_read ON public.price_catalog;
CREATE POLICY price_catalog_read ON public.price_catalog FOR SELECT TO authenticated
USING (public.is_full_scope() AND public.is_approved());

DROP POLICY IF EXISTS paperless_documents_read ON public.paperless_documents;
CREATE POLICY paperless_documents_read ON public.paperless_documents FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.has_permission('quotes','view')
    OR public.has_permission('finance','view')
    OR public.is_admin()
  )
);

-- ── event documents: privileged, or assigned to the event ──────────────────
DROP POLICY IF EXISTS documents_read ON public.documents;
CREATE POLICY documents_read ON public.documents FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR public.has_permission('clients','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
    )
  )
  OR (event_id IS NOT NULL AND public.is_assigned_to_event(event_id))
);

NOTIFY pgrst, 'reload schema';

-- ── equipment: restricted users are read-only ──────────────────────────────
DROP POLICY IF EXISTS equipment_items_edit ON public.equipment_items;
CREATE POLICY equipment_items_edit ON public.equipment_items FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('equipment','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('equipment','edit'));

DROP POLICY IF EXISTS equipment_assignments_edit ON public.equipment_assignments;
CREATE POLICY equipment_assignments_edit ON public.equipment_assignments FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('equipment','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('equipment','edit'));

NOTIFY pgrst, 'reload schema';

-- ── profiles: restricted users see only their own profile ──────────────────
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR (
    public.is_full_scope()
    AND (
      public.is_admin()
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

NOTIFY pgrst, 'reload schema';


-- ── RPC guards for self-scope ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_event_with_days(
  p_event jsonb,
  p_days jsonb,
  p_remove_day_ids uuid[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_event_id uuid;
  v_day jsonb;
  v_day_id uuid;
  v_crew jsonb;
BEGIN
  IF NOT (public.is_full_scope() AND (public.is_admin() OR public.has_permission('calendar','edit'))) THEN
    RAISE EXCEPTION 'אין הרשאה לשמור אירוע' USING ERRCODE = '42501';
  END IF;

  v_event_id := NULLIF(p_event->>'id','')::uuid;
  IF v_event_id IS NULL THEN
    INSERT INTO public.events (
      title, client_id, event_type, event_date, start_date, end_date, start_time, end_time,
      warehouse_time, ready_time, venue, address, guest_count, status,
      sales_rep_id, sales_rep_name, total_amount, notes
    ) VALUES (
      p_event->>'title',
      NULLIF(p_event->>'client_id','')::uuid,
      COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      (p_event->>'event_date')::date,
      COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      NULLIF(p_event->>'start_time','')::time,
      NULLIF(p_event->>'end_time','')::time,
      NULLIF(p_event->>'warehouse_time','')::time,
      NULLIF(p_event->>'ready_time','')::time,
      NULLIF(p_event->>'venue',''),
      NULLIF(p_event->>'address',''),
      NULLIF(p_event->>'guest_count','')::int,
      COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      NULLIF(p_event->>'sales_rep_id','')::uuid,
      NULLIF(p_event->>'sales_rep_name',''),
      COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      NULLIF(p_event->>'notes','')
    ) RETURNING id INTO v_event_id;
  ELSE
    UPDATE public.events SET
      title = p_event->>'title',
      client_id = NULLIF(p_event->>'client_id','')::uuid,
      event_type = COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      event_date = (p_event->>'event_date')::date,
      start_date = COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      end_date = COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      start_time = NULLIF(p_event->>'start_time','')::time,
      end_time = NULLIF(p_event->>'end_time','')::time,
      warehouse_time = NULLIF(p_event->>'warehouse_time','')::time,
      ready_time = NULLIF(p_event->>'ready_time','')::time,
      venue = NULLIF(p_event->>'venue',''),
      address = NULLIF(p_event->>'address',''),
      guest_count = NULLIF(p_event->>'guest_count','')::int,
      status = COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      sales_rep_id = NULLIF(p_event->>'sales_rep_id','')::uuid,
      sales_rep_name = NULLIF(p_event->>'sales_rep_name',''),
      total_amount = COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      notes = NULLIF(p_event->>'notes','')
    WHERE id = v_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'האירוע לא נמצא' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_remove_day_ids IS NOT NULL AND array_length(p_remove_day_ids, 1) > 0 THEN
    DELETE FROM public.event_days
    WHERE id = ANY(p_remove_day_ids) AND event_id = v_event_id;
  END IF;

  FOR v_day IN SELECT * FROM jsonb_array_elements(COALESCE(p_days, '[]'::jsonb))
  LOOP
    INSERT INTO public.event_days (
      event_id, day_date, warehouse_time, ready_time, start_time, end_time, notes, sort_order
    ) VALUES (
      v_event_id,
      (v_day->>'day_date')::date,
      NULLIF(v_day->>'warehouse_time','')::time,
      NULLIF(v_day->>'ready_time','')::time,
      NULLIF(v_day->>'start_time','')::time,
      NULLIF(v_day->>'end_time','')::time,
      NULLIF(v_day->>'notes',''),
      COALESCE(NULLIF(v_day->>'sort_order','')::int, 0)
    )
    ON CONFLICT (event_id, day_date) DO UPDATE SET
      warehouse_time = EXCLUDED.warehouse_time,
      ready_time = EXCLUDED.ready_time,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      notes = EXCLUDED.notes,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING id INTO v_day_id;

    DELETE FROM public.event_day_crew WHERE event_day_id = v_day_id;
    FOR v_crew IN SELECT * FROM jsonb_array_elements(COALESCE(v_day->'crew', '[]'::jsonb))
    LOOP
      INSERT INTO public.event_day_crew (event_day_id, crew_member_id, role_text, notes)
      VALUES (
        v_day_id,
        (v_crew->>'crew_member_id')::uuid,
        NULLIF(v_crew->>'role_text',''),
        NULLIF(v_crew->>'notes','')
      )
      ON CONFLICT (event_day_id, crew_member_id) DO UPDATE SET
        role_text = EXCLUDED.role_text,
        notes = EXCLUDED.notes;
    END LOOP;
  END LOOP;

  RETURN v_event_id;
END $fn$;
GRANT EXECUTE ON FUNCTION public.save_event_with_days(jsonb, jsonb, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    (
      public.is_full_scope()
      AND (
        public.is_admin()
        OR public.has_permission('calendar','view')
        OR public.has_permission('crew','view')
        OR public.has_permission('clients','view')
      )
    )
    OR public.is_assigned_to_event(p_event)
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
      'description', COALESCE(NULLIF(i.description, ''), i.name),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM public.shifts sh
  JOIN public.crew_members c ON c.id = sh.crew_member_id
  WHERE sh.event_id = p_event;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;

GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Per-day crew NAMES for an assigned event (no hourly_rate exposed).
CREATE OR REPLACE FUNCTION public.event_day_crew_names(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v jsonb;
BEGIN
  IF NOT public.can_access_event(p_event) THEN
    RETURN '{}'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_object_agg(d.id::text, x.names), '{}'::jsonb) INTO v
  FROM public.event_days d
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('name', cm.full_name, 'role', dc.role_text)
        ORDER BY cm.full_name
      ),
      '[]'::jsonb
    ) AS names
    FROM public.event_day_crew dc
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE dc.event_day_id = d.id
  ) x ON true
  WHERE d.event_id = p_event;
  RETURN COALESCE(v, '{}'::jsonb);
END $fn$;
GRANT EXECUTE ON FUNCTION public.event_day_crew_names(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
