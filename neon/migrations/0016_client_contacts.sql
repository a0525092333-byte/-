-- ============================================================================
-- 0016 — Client extra email + additional contact persons.
-- Adds a second email on clients and a client_contacts table with RLS that
-- mirrors the clients read/edit policies. Idempotent.
-- ============================================================================

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS extra_email text;

CREATE TABLE IF NOT EXISTS public.client_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  role        text,
  email       text,
  phone       text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_contacts_client_idx
  ON public.client_contacts (client_id, sort_order);

ALTER TABLE public.client_contacts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_contacts TO authenticated;

DROP POLICY IF EXISTS client_contacts_read ON public.client_contacts;
CREATE POLICY client_contacts_read ON public.client_contacts FOR SELECT TO authenticated USING (
  public.can_see_client(client_id)
);

DROP POLICY IF EXISTS client_contacts_edit ON public.client_contacts;
CREATE POLICY client_contacts_edit ON public.client_contacts FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('clients','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('clients','edit'));

NOTIFY pgrst, 'reload schema';
