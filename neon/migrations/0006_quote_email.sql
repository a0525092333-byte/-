-- ============================================================================
-- Quote email delivery state (additive only).
-- ============================================================================

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS last_sent_to text;

NOTIFY pgrst, 'reload schema';
