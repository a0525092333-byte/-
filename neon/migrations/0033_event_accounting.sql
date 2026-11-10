-- 0033: event accounting references and an independent, fail-closed finance gate.
CREATE OR REPLACE FUNCTION public.can_event_accounting(p_action text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  caller_id text;
  auth_exists boolean := false;
  owner_account boolean := false;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('view', 'edit') THEN RETURN false; END IF;
  caller_id := auth.user_id();
  IF caller_id IS NULL OR caller_id = '' THEN RETURN false; END IF;

  -- Dynamic resolution keeps installation independent of Neon Auth provisioning.
  EXECUTE 'SELECT true, lower(u.email) = ''a0525092333@gmail.com''
    FROM neon_auth."user" u
    WHERE u.id::text = $1 AND coalesce(u.banned, false) = false'
    INTO auth_exists, owner_account USING caller_id;
  IF auth_exists IS DISTINCT FROM true THEN RETURN false; END IF;
  IF owner_account IS TRUE THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.user_permissions up ON up.user_id = p.id AND up.module = 'finance'
    WHERE p.id::text = caller_id AND p.role = 'accounting'
      AND p.approval_status = 'approved' AND p.is_active IS TRUE
      AND CASE WHEN p_action = 'edit' THEN up.can_edit ELSE up.can_view OR up.can_edit END
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.can_event_accounting(text) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.can_event_accounting(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_accounting_access()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'canView', public.can_event_accounting('view'),
    'canEdit', public.can_event_accounting('edit')
  );
$fn$;
REVOKE ALL ON FUNCTION public.event_accounting_access() FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.event_accounting_access() TO authenticated;

CREATE TABLE IF NOT EXISTS public.event_accounting_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  doc_type text NOT NULL CHECK (doc_type IN ('transaction_account', 'invoice_receipt')),
  doc_number text NOT NULL CHECK (
    doc_number = btrim(doc_number) AND char_length(doc_number) BETWEEN 1 AND 120
    AND doc_number ~ '[^[:space:]]'
  ),
  document_date date,
  notes text CHECK (char_length(notes) <= 2000),
  doc_url text CHECK (char_length(doc_url) <= 2048 AND doc_url ~* '^https?://[^[:space:]/?#]+[^[:space:]]*$'),
  created_by text NOT NULL DEFAULT auth.user_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, doc_type, doc_number)
);

CREATE OR REPLACE FUNCTION public.protect_event_accounting_reference()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.user_id();
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
DROP TRIGGER IF EXISTS protect_event_accounting_reference ON public.event_accounting_references;
CREATE TRIGGER protect_event_accounting_reference
BEFORE INSERT OR UPDATE ON public.event_accounting_references
FOR EACH ROW EXECUTE FUNCTION public.protect_event_accounting_reference();

ALTER TABLE public.event_accounting_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_accounting_references FROM PUBLIC, anonymous, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_accounting_references TO authenticated;

-- Every operation needs its restrictive gate, even if a permissive admin policy is added.
DROP POLICY IF EXISTS event_accounting_authenticated ON public.event_accounting_references;
CREATE POLICY event_accounting_authenticated ON public.event_accounting_references
FOR ALL TO authenticated USING (public.can_event_accounting('view'))
WITH CHECK (public.can_event_accounting('edit'));
DROP POLICY IF EXISTS event_accounting_view ON public.event_accounting_references;
CREATE POLICY event_accounting_view ON public.event_accounting_references AS RESTRICTIVE
FOR SELECT TO PUBLIC USING (public.can_event_accounting('view'));
DROP POLICY IF EXISTS event_accounting_insert ON public.event_accounting_references;
CREATE POLICY event_accounting_insert ON public.event_accounting_references AS RESTRICTIVE
FOR INSERT TO PUBLIC WITH CHECK (public.can_event_accounting('edit') AND created_by = auth.user_id());
DROP POLICY IF EXISTS event_accounting_update ON public.event_accounting_references;
CREATE POLICY event_accounting_update ON public.event_accounting_references AS RESTRICTIVE
FOR UPDATE TO PUBLIC USING (public.can_event_accounting('edit'))
WITH CHECK (public.can_event_accounting('edit'));
DROP POLICY IF EXISTS event_accounting_delete ON public.event_accounting_references;
CREATE POLICY event_accounting_delete ON public.event_accounting_references AS RESTRICTIVE
FOR DELETE TO PUBLIC USING (public.can_event_accounting('edit'));

CREATE OR REPLACE FUNCTION public.event_accounting_summary(p_event_ids uuid[])
RETURNS TABLE(event_id uuid, doc_type text, doc_number text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF NOT public.can_event_accounting('view') THEN
    RAISE EXCEPTION 'Event accounting access denied' USING ERRCODE = '42501';
  END IF;
  IF cardinality(p_event_ids) > 500 THEN
    RAISE EXCEPTION 'At most 500 event ids are allowed' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT r.event_id, r.doc_type, r.doc_number
    FROM public.event_accounting_references r
    WHERE r.event_id = ANY(p_event_ids)
    UNION
    SELECT d.event_id,
      CASE WHEN d.doc_type = 'payment_request' THEN 'transaction_account' ELSE d.doc_type END,
      d.doc_number
    FROM public.paperless_documents d
    -- An issued, nonempty document number is itself issuance evidence.
    WHERE d.event_id = ANY(p_event_ids) AND d.status = 'issued'
      AND d.doc_type IN ('payment_request', 'invoice_receipt', 'invoice', 'receipt')
      AND d.doc_number ~ '[^[:space:]]'
    UNION
    SELECT f.event_id, 'invoice'::text, f.doc_number
    FROM public.finance_entries f
    WHERE f.event_id = ANY(p_event_ids) AND f.kind = 'חשבונית'
      AND f.doc_number ~ '[^[:space:]]';
END $fn$;
REVOKE ALL ON FUNCTION public.event_accounting_summary(uuid[]) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.event_accounting_summary(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
