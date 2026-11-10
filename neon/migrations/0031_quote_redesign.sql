-- 0031: quote screen redesign — additive only, no data loss.
-- Event address + on-site client contact on quotes; internal crew/warehouse notes
-- in a separate SERVER-ONLY table (no browser grants) so they never reach the
-- quote print / PDF / email — only the employee event report reads them.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS event_address text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS event_contact_name text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS event_contact_phone text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS event_contact_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quotes_event_contact_id_fkey' AND conrelid = 'public.quotes'::regclass
  ) THEN
    ALTER TABLE public.quotes ADD CONSTRAINT quotes_event_contact_id_fkey
      FOREIGN KEY (event_contact_id) REFERENCES public.client_contacts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.quote_field_notes (
  quote_id   uuid PRIMARY KEY REFERENCES public.quotes(id) ON DELETE CASCADE,
  notes      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.quote_field_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_field_notes FROM anonymous, authenticated;

NOTIFY pgrst, 'reload schema';
