-- ============================================================================
-- Time-entry audit flags: manual entry vs clock, and manual hour edits.
-- Additive only; does not touch RLS or the ownership trigger.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'manual'
    CHECK (entry_source IN ('clock','manual'));
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS manually_edited boolean NOT NULL DEFAULT false;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

-- Existing rows have no proof they came from the clock: keep entry_source='manual'
-- and record the owner as the best available creator.
UPDATE public.time_entries SET created_by = user_id WHERE created_by IS NULL;

CREATE OR REPLACE FUNCTION public.track_time_entry_manual_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- Closing an open clock shift is part of the clock flow, not a manual edit.
  IF OLD.entry_source = 'clock'
     AND OLD.manually_edited = false
     AND OLD.end_time IS NULL
     AND NEW.end_time IS NOT NULL
     AND NEW.work_date IS NOT DISTINCT FROM OLD.work_date
     AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
     AND NEW.day_type IS NOT DISTINCT FROM OLD.day_type
     AND NEW.shift_type IS NOT DISTINCT FROM OLD.shift_type
     AND NEW.travel_km IS NOT DISTINCT FROM OLD.travel_km
     AND NEW.travel_amount IS NOT DISTINCT FROM OLD.travel_amount
     AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
  THEN
    RETURN NEW;
  END IF;

  IF NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time
     OR NEW.end_time IS DISTINCT FROM OLD.end_time
     OR NEW.break_minutes IS DISTINCT FROM OLD.break_minutes
     OR NEW.day_type IS DISTINCT FROM OLD.day_type
     OR NEW.shift_type IS DISTINCT FROM OLD.shift_type
     OR NEW.travel_km IS DISTINCT FROM OLD.travel_km
     OR NEW.travel_amount IS DISTINCT FROM OLD.travel_amount
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
  THEN
    NEW.manually_edited := true;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = NULLIF(auth.user_id(), '')::uuid
      ) THEN
        NEW.edited_by := NULLIF(auth.user_id(), '')::uuid;
      ELSE
        NEW.edited_by := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NEW.edited_by := NULL;
    END;
    NEW.edited_at := now();
    NEW.edit_count := COALESCE(OLD.edit_count, 0) + 1;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS time_entries_manual_changes ON public.time_entries;
CREATE TRIGGER time_entries_manual_changes
BEFORE UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.track_time_entry_manual_changes();

NOTIFY pgrst, 'reload schema';
