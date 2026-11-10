-- 0035: event accounting access fix (no data changes).
-- * The owner account always has accounting access (same owner check as the
--   rest of the app, public.is_super_admin()), even when the Neon Auth lookup
--   inside can_event_accounting fails.
-- * event_accounting_summary no longer raises 42501 for callers without access
--   (it returned HTTP 403 to the browser); it now returns an empty result.
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

  BEGIN
    IF public.is_super_admin() THEN RETURN true; END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    EXECUTE 'SELECT true, lower(u.email) = ''a0525092333@gmail.com''
      FROM neon_auth."user" u
      WHERE u.id::text = $1 AND coalesce(u.banned, false) = false'
      INTO auth_exists, owner_account USING caller_id;
  EXCEPTION WHEN OTHERS THEN
    auth_exists := false;
  END;
  IF owner_account IS TRUE THEN RETURN true; END IF;
  IF auth_exists IS DISTINCT FROM true THEN RETURN false; END IF;

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

CREATE OR REPLACE FUNCTION public.event_accounting_summary(p_event_ids uuid[])
RETURNS TABLE(event_id uuid, doc_type text, doc_number text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- No access → empty result (never an HTTP 403 in the browser).
  IF NOT public.can_event_accounting('view') THEN RETURN; END IF;
  IF p_event_ids IS NULL OR cardinality(p_event_ids) = 0 THEN RETURN; END IF;
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
