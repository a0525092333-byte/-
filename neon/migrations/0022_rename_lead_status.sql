-- 0022: rename the stored event status value ליד → ממתין לסגירה.
-- Idempotent: the drop is IF EXISTS, the update affects 0 rows on re-run,
-- and the constraint is only added when it is missing.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'ליד';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status IN ('הצעה','בוטל');
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
