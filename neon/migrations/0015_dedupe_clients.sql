-- ============================================================================
-- 0015 — Deduplicate clients by normalized name.
-- Normalization matches the app helper: lowercase, trim, collapse inner
-- whitespace, strip Hebrew niqqud (U+0591–U+05C7).
-- Survivor per group = earliest created_at, tie-break smallest id::text.
-- Coalesces missing detail fields into the survivor, re-points every FK, then
-- deletes the redundant rows and adds a unique index so duplicates cannot
-- return. Idempotent: a second run finds no duplicate groups.
-- ============================================================================

DO $dedupe$
DECLARE
  v_before int;
  v_after int;
  v_groups int := 0;
  v_removed int := 0;
  v_deleted int;
  grp record;
  survivor uuid;
BEGIN
  SELECT count(*) INTO v_before FROM public.clients;

  FOR grp IN
    SELECT lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) AS norm
    FROM public.clients
    GROUP BY lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g'))
    HAVING count(*) > 1
  LOOP
    v_groups := v_groups + 1;

    SELECT id INTO survivor
    FROM public.clients
    WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
    ORDER BY created_at ASC, id::text ASC
    LIMIT 1;

    UPDATE public.clients s
    SET contact_name = COALESCE(NULLIF(btrim(s.contact_name), ''), (
          SELECT NULLIF(btrim(c.contact_name), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.contact_name), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        phone = COALESCE(NULLIF(btrim(s.phone), ''), (
          SELECT NULLIF(btrim(c.phone), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.phone), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        email = COALESCE(NULLIF(btrim(s.email), ''), (
          SELECT NULLIF(btrim(c.email), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.email), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        company = COALESCE(NULLIF(btrim(s.company), ''), (
          SELECT NULLIF(btrim(c.company), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.company), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        address = COALESCE(NULLIF(btrim(s.address), ''), (
          SELECT NULLIF(btrim(c.address), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.address), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        notes = COALESCE(NULLIF(btrim(s.notes), ''), (
          SELECT NULLIF(btrim(c.notes), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.notes), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1))
    WHERE s.id = survivor;

    UPDATE public.events SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    UPDATE public.quotes SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    UPDATE public.paperless_documents SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    DELETE FROM public.clients
    WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
      AND id <> survivor;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_removed := v_removed + v_deleted;
  END LOOP;

  DROP INDEX IF EXISTS public.clients_name_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS clients_name_unique
    ON public.clients (lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')));

  SELECT count(*) INTO v_after FROM public.clients;
  RAISE NOTICE 'clients dedupe: before=%, after=%, duplicate_groups=%, redundant_removed=%',
    v_before, v_after, v_groups, v_removed;
END $dedupe$;
