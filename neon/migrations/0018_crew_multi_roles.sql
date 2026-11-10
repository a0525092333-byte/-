-- ============================================================================
-- 0018 — Crew multi-role support + role data repair.
--
-- Adds `crew_roles text[]` so one crew member can hold several roles at once.
-- `role_title` stays as a compatibility column, kept in sync with
-- `crew_roles[1]` by a BEFORE INSERT/UPDATE trigger. Existing rows are
-- backfilled from their current `role_title`. Two rows that were showing the
-- wrong role are repaired to 'טכנאי'. No CHECK constraints, no indexes.
-- ============================================================================

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS crew_roles text[] NOT NULL DEFAULT '{}';

-- Repair the two rows that were stored with the wrong role. The guard makes
-- this a one-shot: it only fires while the row is still un-migrated
-- (crew_roles empty) and still holds the bad value, so re-applying the
-- migration never overwrites a role the user sets later.
UPDATE public.crew_members
SET role_title = 'טכנאי',
    crew_roles = ARRAY['טכנאי']
WHERE full_name IN ('אברהם פנחס', 'אלי גולדשטיין')
  AND cardinality(crew_roles) = 0
  AND btrim(role_title) = 'מכירות';

DO $$
DECLARE
  v_before integer;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.crew_members
  WHERE cardinality(crew_roles) > 0;

  UPDATE public.crew_members
  SET crew_roles = ARRAY[role_title]
  WHERE cardinality(crew_roles) = 0
    AND role_title IS NOT NULL
    AND btrim(role_title) <> '';

  SELECT count(*) INTO v_after
  FROM public.crew_members
  WHERE cardinality(crew_roles) > 0;

  RAISE NOTICE '0018 crew_roles backfill: before=% after=%', v_before, v_after;
END $$;

-- Keep role_title = crew_roles[1] on every write. A legacy write that only
-- sets role_title backfills crew_roles from it, so the two never diverge.
CREATE OR REPLACE FUNCTION public.sync_crew_role_title() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.crew_roles IS NULL THEN
    NEW.crew_roles := '{}';
  END IF;
  IF cardinality(NEW.crew_roles) = 0
     AND NEW.role_title IS NOT NULL
     AND btrim(NEW.role_title) <> '' THEN
    NEW.crew_roles := ARRAY[NEW.role_title];
  END IF;
  IF cardinality(NEW.crew_roles) > 0 THEN
    NEW.role_title := NEW.crew_roles[1];
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS crew_roles_sync ON public.crew_members;
CREATE TRIGGER crew_roles_sync
BEFORE INSERT OR UPDATE ON public.crew_members
FOR EACH ROW EXECUTE FUNCTION public.sync_crew_role_title();

NOTIFY pgrst, 'reload schema';
