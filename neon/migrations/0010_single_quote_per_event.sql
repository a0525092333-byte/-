-- ============================================================================
-- 0010 — One quote per event + automatic version history.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.quote_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  event_id       uuid,
  version_number integer NOT NULL,
  snapshot       jsonb NOT NULL,
  total          numeric,
  label          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_number)
);

CREATE INDEX IF NOT EXISTS quote_versions_quote_version_idx
  ON public.quote_versions (quote_id, version_number DESC);

ALTER TABLE public.quote_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.quote_versions TO authenticated;

DROP POLICY IF EXISTS quote_versions_read ON public.quote_versions;
CREATE POLICY quote_versions_read ON public.quote_versions FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.is_admin()
    OR public.has_permission('quotes','view')
    OR public.has_permission('quotes','edit')
    OR (public.is_approved() AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_versions.quote_id AND q.created_by::text = auth.user_id()
    ))
  )
);

DROP POLICY IF EXISTS quote_versions_insert ON public.quote_versions;
CREATE POLICY quote_versions_insert ON public.quote_versions FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    public.is_admin()
    OR public.has_permission('quotes','edit')
    OR (public.is_approved() AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_versions.quote_id AND q.created_by::text = auth.user_id()
    ))
  )
);

-- Deduplicate existing quotes before adding the unique index. The oldest quote
-- for each event is preserved as a full snapshot on the surviving (newest) quote.
DO $dedupe$
DECLARE
  dup record;
  survivor uuid;
  old_quote record;
  snapshot jsonb;
  next_version integer;
  merged integer := 0;
BEGIN
  FOR dup IN
    SELECT event_id FROM public.quotes
    WHERE event_id IS NOT NULL
    GROUP BY event_id HAVING count(*) > 1
  LOOP
    SELECT id INTO survivor FROM public.quotes
    WHERE event_id = dup.event_id
    ORDER BY created_at DESC, updated_at DESC, id DESC
    LIMIT 1;
    SELECT COALESCE(max(version_number), 0) + 1 INTO next_version
    FROM public.quote_versions WHERE quote_id = survivor;
    FOR old_quote IN
      SELECT * FROM public.quotes
      WHERE event_id = dup.event_id AND id <> survivor
      ORDER BY created_at ASC, updated_at ASC
    LOOP
      SELECT jsonb_build_object(
        'quote', to_jsonb(old_quote),
        'sections', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sort_order) FROM public.quote_sections s WHERE s.quote_id = old_quote.id), '[]'::jsonb),
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order) FROM public.quote_items i WHERE i.quote_id = old_quote.id), '[]'::jsonb)
      ) INTO snapshot;
      INSERT INTO public.quote_versions (quote_id, event_id, version_number, snapshot, total, label, created_by)
      VALUES (survivor, dup.event_id, next_version, snapshot, old_quote.grand_total, 'הצעה קודמת — נשמרה לפני איחוד לכפילות', old_quote.created_by)
      ON CONFLICT (quote_id, version_number) DO NOTHING;
      DELETE FROM public.quotes WHERE id = old_quote.id;
      next_version := next_version + 1;
      merged := merged + 1;
    END LOOP;
  END LOOP;
  IF merged > 0 THEN
    RAISE NOTICE 'אוחדו % הצעות מחיר כפולות', merged;
  END IF;
END $dedupe$;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_per_event
  ON public.quotes (event_id) WHERE event_id IS NOT NULL;
