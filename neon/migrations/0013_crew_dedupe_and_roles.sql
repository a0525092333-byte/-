-- ============================================================================
-- 0013 — Crew dedupe + role exclusion.
-- Keeps the OLDEST row per normalized name, re-points every shift and
-- event_day_crew assignment to the survivor, deletes the redundant rows, then
-- removes crew rows linked to admin/accounting profiles. Finally adds a unique
-- index on lower(btrim(full_name)) and keeps the profile→crew trigger in sync.
-- Safe to run twice.
-- ============================================================================

DO $dedupe$
DECLARE
  v_before int;
  v_after int;
  v_dupes int := 0;
  v_roles int := 0;
BEGIN
  SELECT count(*) INTO v_before FROM public.crew_members;

  -- 1) Re-point shifts from duplicate rows to the oldest row per normalized name.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  UPDATE public.shifts s
     SET crew_member_id = r.survivor
    FROM ranked r
   WHERE s.crew_member_id = r.id
     AND r.id <> r.survivor;

  -- 1b) Collapse shifts that became duplicates after the re-point.
  DELETE FROM public.shifts s
   USING public.shifts keep
   WHERE s.event_id = keep.event_id
     AND s.crew_member_id = keep.crew_member_id
     AND s.starts_at = keep.starts_at
     AND s.id <> keep.id
     AND (keep.created_at, keep.id) < (s.created_at, s.id);

  -- 2) Drop event_day_crew rows that would collide with the survivor.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  ),
  dupes AS (
    SELECT dc.id
      FROM public.event_day_crew dc
      JOIN ranked r ON r.id = dc.crew_member_id
     WHERE r.id <> r.survivor
       AND EXISTS (
         SELECT 1 FROM public.event_day_crew existing
          WHERE existing.event_day_id = dc.event_day_id
            AND existing.crew_member_id = r.survivor
       )
  )
  DELETE FROM public.event_day_crew dc
   USING dupes d
   WHERE dc.id = d.id;

  -- 2b) Re-point the remaining event_day_crew rows.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  UPDATE public.event_day_crew dc
     SET crew_member_id = r.survivor
    FROM ranked r
   WHERE dc.crew_member_id = r.id
     AND r.id <> r.survivor;

  -- 3) Delete duplicate crew rows (keep the oldest).
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  DELETE FROM public.crew_members c
   USING ranked r
   WHERE c.id = r.id
     AND r.id <> r.survivor;
  GET DIAGNOSTICS v_dupes = ROW_COUNT;

  -- 4) Re-point assignments away from admin/accounting rows to a non-excluded
  --    row with the same normalized name, when one exists.
  WITH excluded AS (
    SELECT c.id, lower(btrim(c.full_name)) AS norm
      FROM public.crew_members c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE p.role IN ('admin','accounting')
  ),
  replacement AS (
    SELECT e.id AS old_id,
           (SELECT c2.id
              FROM public.crew_members c2
              LEFT JOIN public.profiles p2 ON p2.id = c2.user_id
             WHERE lower(btrim(c2.full_name)) = e.norm
               AND (p2.role IS NULL OR p2.role NOT IN ('admin','accounting'))
             ORDER BY c2.created_at ASC, c2.id ASC
             LIMIT 1) AS new_id
      FROM excluded e
  )
  UPDATE public.shifts s
     SET crew_member_id = r.new_id
    FROM replacement r
   WHERE s.crew_member_id = r.old_id
     AND r.new_id IS NOT NULL;

  WITH excluded AS (
    SELECT c.id, lower(btrim(c.full_name)) AS norm
      FROM public.crew_members c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE p.role IN ('admin','accounting')
  ),
  replacement AS (
    SELECT e.id AS old_id,
           (SELECT c2.id
              FROM public.crew_members c2
              LEFT JOIN public.profiles p2 ON p2.id = c2.user_id
             WHERE lower(btrim(c2.full_name)) = e.norm
               AND (p2.role IS NULL OR p2.role NOT IN ('admin','accounting'))
             ORDER BY c2.created_at ASC, c2.id ASC
             LIMIT 1) AS new_id
      FROM excluded e
  )
  UPDATE public.event_day_crew dc
     SET crew_member_id = r.new_id
    FROM replacement r
   WHERE dc.crew_member_id = r.old_id
     AND r.new_id IS NOT NULL;

  -- 5) Remove any assignments still owned by admin/accounting rows (no
  --    same-name replacement existed). These roles must not appear at all.
  DELETE FROM public.shifts s
   USING public.crew_members c, public.profiles p
   WHERE s.crew_member_id = c.id
     AND c.user_id = p.id
     AND p.role IN ('admin','accounting');

  DELETE FROM public.event_day_crew dc
   USING public.crew_members c, public.profiles p
   WHERE dc.crew_member_id = c.id
     AND c.user_id = p.id
     AND p.role IN ('admin','accounting');

  -- 6) Delete the admin/accounting crew rows.
  DELETE FROM public.crew_members c
   USING public.profiles p
   WHERE c.user_id = p.id
     AND p.role IN ('admin','accounting');
  GET DIAGNOSTICS v_roles = ROW_COUNT;

  SELECT count(*) INTO v_after FROM public.crew_members;
  RAISE NOTICE 'crew dedupe: before=%, after=%, duplicates_removed=%, admin_accounting_removed=%',
    v_before, v_after, v_dupes, v_roles;
END $dedupe$;

CREATE UNIQUE INDEX IF NOT EXISTS crew_members_name_unique
  ON public.crew_members (lower(btrim(full_name)));

-- 7) Keep the profile→crew trigger idempotent and role-aware.
CREATE OR REPLACE FUNCTION public.link_profile_to_crew() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  matched_id uuid;
BEGIN
  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;
  IF NEW.role IN ('admin','accounting') THEN RETURN NEW; END IF;

  SELECT id INTO matched_id
  FROM public.crew_members
  WHERE lower(btrim(full_name)) = lower(btrim(NEW.full_name))
     OR (email IS NOT NULL AND lower(email) = lower(NEW.email))
     OR (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone)
  ORDER BY
    (lower(btrim(full_name)) = lower(btrim(NEW.full_name))) DESC,
    (email IS NOT NULL AND lower(email) = lower(NEW.email)) DESC,
    (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone) DESC
  LIMIT 1;

  IF matched_id IS NOT NULL THEN
    UPDATE public.crew_members
    SET user_id = NEW.id,
        email = COALESCE(email, NEW.email),
        phone = COALESCE(phone, NEW.phone)
    WHERE id = matched_id;
  ELSE
    INSERT INTO public.crew_members (full_name, phone, role_title, hourly_rate, is_active, user_id, email)
    VALUES (
      NEW.full_name, NEW.phone,
      CASE NEW.role
        WHEN 'admin' THEN 'מנהל'
        WHEN 'sales' THEN 'מכירות'
        WHEN 'accounting' THEN 'הנהלת חשבונות'
        WHEN 'warehouse' THEN 'מחסן'
        ELSE 'טכנאי'
      END,
      NEW.hourly_rate, COALESCE(NEW.is_active, true), NEW.id, NEW.email
    )
    ON CONFLICT (lower(btrim(full_name))) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          email = COALESCE(crew_members.email, EXCLUDED.email),
          phone = COALESCE(crew_members.phone, EXCLUDED.phone);
  END IF;
  RETURN NEW;
END $fn$;
