-- 0034: scoped caller identity and private accounting originals. No auth schema grants.
CREATE OR REPLACE FUNCTION public.accounting_user_id()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT auth.user_id()::text;
$fn$;
REVOKE ALL ON FUNCTION public.accounting_user_id() FROM PUBLIC, anonymous, authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_user_id() TO authenticated;

ALTER TABLE public.event_accounting_references
  ALTER COLUMN created_by SET DEFAULT public.accounting_user_id();
ALTER TABLE public.event_accounting_references
  DROP CONSTRAINT IF EXISTS event_accounting_references_doc_type_check;
ALTER TABLE public.event_accounting_references
  ADD CONSTRAINT event_accounting_references_doc_type_check CHECK
  (doc_type IN ('transaction_account', 'invoice', 'receipt', 'invoice_receipt', 'credit_note', 'other'));

CREATE OR REPLACE FUNCTION public.protect_event_accounting_reference()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Browser callers cannot supply a creator; trusted server inserts carry verified provenance.
    NEW.created_by := coalesce(public.accounting_user_id(), NEW.created_by);
    NEW.created_at := now();
  ELSIF ROW(NEW.id, NEW.event_id, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.event_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Event accounting reference identity is immutable' USING ERRCODE = '22023';
  END IF;
  NEW.doc_number := btrim(NEW.doc_number);
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.protect_event_accounting_reference() FROM PUBLIC, anonymous, authenticated;

-- Leave the trusted site_server_all policy untouched; browser CRUD is explicitly gated.
DROP POLICY IF EXISTS event_accounting_authenticated ON public.event_accounting_references;
DROP POLICY IF EXISTS event_accounting_select_allowed ON public.event_accounting_references;
CREATE POLICY event_accounting_select_allowed ON public.event_accounting_references
FOR SELECT TO authenticated USING (public.can_event_accounting('view'));
DROP POLICY IF EXISTS event_accounting_insert_allowed ON public.event_accounting_references;
CREATE POLICY event_accounting_insert_allowed ON public.event_accounting_references
FOR INSERT TO authenticated WITH CHECK
  (public.can_event_accounting('edit') AND created_by = public.accounting_user_id());
DROP POLICY IF EXISTS event_accounting_update_allowed ON public.event_accounting_references;
CREATE POLICY event_accounting_update_allowed ON public.event_accounting_references
FOR UPDATE TO authenticated USING (public.can_event_accounting('edit'))
WITH CHECK (public.can_event_accounting('edit'));
DROP POLICY IF EXISTS event_accounting_delete_allowed ON public.event_accounting_references;
CREATE POLICY event_accounting_delete_allowed ON public.event_accounting_references
FOR DELETE TO authenticated USING (public.can_event_accounting('edit'));
DROP POLICY IF EXISTS event_accounting_insert ON public.event_accounting_references;
CREATE POLICY event_accounting_insert ON public.event_accounting_references AS RESTRICTIVE
FOR INSERT TO PUBLIC WITH CHECK
  (public.can_event_accounting('edit') AND created_by = public.accounting_user_id());

CREATE TABLE IF NOT EXISTS public.event_accounting_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original bytea NOT NULL CHECK (octet_length(original) = size_bytes),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL,
  scan_status text NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending', 'scanned', 'failed', 'unavailable')),
  scan_result jsonb,
  doc_type text NOT NULL DEFAULT 'other'
    CHECK (doc_type IN ('transaction_account', 'invoice', 'receipt', 'invoice_receipt', 'credit_note', 'other')),
  doc_number text CHECK (char_length(doc_number) <= 120),
  document_date date,
  supplier text CHECK (char_length(supplier) <= 250),
  customer text CHECK (char_length(customer) <= 250),
  amount numeric,
  vat numeric,
  notes text CHECK (char_length(notes) <= 2000),
  confirmed_at timestamptz,
  reference_id uuid REFERENCES public.event_accounting_references(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS event_accounting_files_event_hash
  ON public.event_accounting_files(event_id, sha256);
ALTER TABLE public.event_accounting_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_accounting_files FROM PUBLIC, anonymous, authenticated;
-- No browser policies or grants. Runtime uses its trusted RLS-bypassing connection.
-- Removing a file never removes its reference: document numbers remain in the records.
NOTIFY pgrst, 'reload schema';
