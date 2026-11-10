-- 0032: quote images (uploaded from the device, stored as compressed data URIs).
CREATE TABLE IF NOT EXISTS public.quote_images (
  id serial PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  mime text NOT NULL DEFAULT 'image/jpeg',
  data_url text NOT NULL,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_images_quote_position_idx ON public.quote_images (quote_id, position);

ALTER TABLE public.quote_images ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_images TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.quote_images_id_seq TO authenticated;

DROP POLICY IF EXISTS quote_images_read ON public.quote_images;
CREATE POLICY quote_images_read ON public.quote_images FOR SELECT TO authenticated
USING (public.owns_quote(quote_id, false));

DROP POLICY IF EXISTS quote_images_write ON public.quote_images;
CREATE POLICY quote_images_write ON public.quote_images FOR ALL TO authenticated
USING (public.owns_quote(quote_id, true))
WITH CHECK (public.owns_quote(quote_id, true));

NOTIFY pgrst, 'reload schema';
