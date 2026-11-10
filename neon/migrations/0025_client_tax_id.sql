-- 0025: optional company registration number / personal ID on clients.
-- Free text, nullable, no default, no backfill. Existing rows stay NULL.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS tax_id text;

NOTIFY pgrst, 'reload schema';
