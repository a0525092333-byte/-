-- 0030: Paperless → production. One-time fix of the stored settings
-- (environment 'sandbox' → 'production', path '/api/invoices/wordpress/' → no
-- trailing slash, base URL → https://api.paperless.tax). Guarded by a marker row
-- so a later owner choice is never overwritten on re-runs. Idempotent.
CREATE TABLE IF NOT EXISTS public.one_time_fixes (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.one_time_fixes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.company_settings ALTER COLUMN paperless_environment SET DEFAULT 'production';
ALTER TABLE public.company_settings ALTER COLUMN paperless_document_path SET DEFAULT '/api/invoices/wordpress';

WITH marker AS (
  INSERT INTO public.one_time_fixes (key) VALUES ('0030_paperless_production')
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
UPDATE public.company_settings
SET paperless_environment = 'production',
    paperless_document_path = '/api/invoices/wordpress',
    paperless_base_url = 'https://api.paperless.tax'
WHERE id = 1 AND EXISTS (SELECT 1 FROM marker);

NOTIFY pgrst, 'reload schema';
