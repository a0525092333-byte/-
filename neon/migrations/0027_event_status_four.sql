-- 0027: event status set → exactly 4 values:
--   ממתין לסגירה, נסגר, ממתין לתשלום, שולם
-- Maps old values (never deletes events): הצעה→ממתין לסגירה, בוצע→ממתין לתשלום,
-- בוטל→ממתין לסגירה. Idempotent: drop IF EXISTS, updates hit 0 rows on re-run,
-- constraint re-added only when missing.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'הצעה';
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'בוטל';
UPDATE public.events SET status = 'ממתין לסגירה'
  WHERE status IS NULL OR status NOT IN ('ממתין לסגירה','נסגר','ממתין לתשלום','שולם');

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
