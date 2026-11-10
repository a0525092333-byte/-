-- 0036: explicit owner-only reset and append-only, sanitized security audit.
-- No reset, permission backfill, role change, or auth-schema grant runs here.
BEGIN;

CREATE OR REPLACE FUNCTION public._security_modules() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['calendar','clients','finance','crew','equipment','users','attendance','quotes','office','backup','search']::text[]
$$;
REVOKE ALL ON FUNCTION public._security_modules() FROM PUBLIC, anonymous, authenticated;

CREATE OR REPLACE FUNCTION public.security_actor(p_module text, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE uid text; mail text; verified boolean; owner_account boolean := false;
  stored_role text; permitted boolean := false;
BEGIN
  uid := nullif(auth.user_id()::text, '');
  IF uid IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT u.email, coalesce((to_jsonb(u)->>''emailVerified'')::boolean, false)
        FROM neon_auth."user" u WHERE u.id::text = $1 AND coalesce(u.banned, false) = false'
        INTO mail, verified USING uid;
    EXCEPTION WHEN OTHERS THEN mail := NULL; verified := false;
    END;
    IF mail IS NOT NULL THEN
      owner_account := verified IS TRUE AND lower(mail) = 'a0525092333@gmail.com';
      SELECT p.role INTO stored_role FROM public.profiles p WHERE p.id::text = uid;
      IF p_action IN ('view','edit') AND p_module = ANY(public._security_modules()) THEN
        permitted := owner_account OR EXISTS (
          SELECT 1 FROM public.profiles p JOIN public.user_permissions up ON up.user_id = p.id
          WHERE p.id::text = uid AND p.is_active IS TRUE AND p.approval_status = 'approved'
            AND up.module = p_module
            AND CASE WHEN p_action = 'edit' THEN up.can_edit ELSE up.can_view OR up.can_edit END
        );
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('user_id', uid, 'email', mail, 'role', stored_role,
    'is_owner', owner_account, 'allowed', coalesce(permitted, false));
END $$;
REVOKE ALL ON FUNCTION public.security_actor(text,text) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.security_actor(text,text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('event.delete','quote.delete','permissions.change','permissions.reset','backup.create','backup.restore')),
  module text NOT NULL CHECK (module IN ('calendar','clients','finance','crew','equipment','users','attendance','quotes','office','backup','search')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_id_idx ON public.audit_logs (created_at DESC, id DESC);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_logs FROM PUBLIC, anonymous, authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;

CREATE OR REPLACE FUNCTION public._security_can_audit() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor jsonb := public.security_actor('users','view');
BEGIN
  RETURN (actor->>'is_owner')::boolean OR
    ((actor->>'allowed')::boolean AND actor->>'role' = 'admin');
END $$;
REVOKE ALL ON FUNCTION public._security_can_audit() FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public._security_can_audit() TO authenticated;
DROP POLICY IF EXISTS security_audit_read ON public.audit_logs;
CREATE POLICY security_audit_read ON public.audit_logs FOR SELECT TO authenticated
  USING (public._security_can_audit());
DROP POLICY IF EXISTS security_audit_read_guard ON public.audit_logs;
CREATE POLICY security_audit_read_guard ON public.audit_logs AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public._security_can_audit());
DROP POLICY IF EXISTS security_audit_no_insert ON public.audit_logs;
CREATE POLICY security_audit_no_insert ON public.audit_logs AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (false);
DROP POLICY IF EXISTS security_audit_no_update ON public.audit_logs;
CREATE POLICY security_audit_no_update ON public.audit_logs AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS security_audit_no_delete ON public.audit_logs;
CREATE POLICY security_audit_no_delete ON public.audit_logs AS RESTRICTIVE FOR DELETE TO PUBLIC USING (false);

CREATE OR REPLACE FUNCTION public._security_audit_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN RAISE EXCEPTION 'Security audit is append-only' USING ERRCODE = '42501'; END $$;
REVOKE ALL ON FUNCTION public._security_audit_immutable() FROM PUBLIC, anonymous, authenticated;
DROP TRIGGER IF EXISTS security_audit_immutable ON public.audit_logs;
CREATE TRIGGER security_audit_immutable BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public._security_audit_immutable();
DROP TRIGGER IF EXISTS security_audit_no_truncate ON public.audit_logs;
CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public._security_audit_immutable();

CREATE OR REPLACE FUNCTION public._security_clean_details(p_details jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb := '{}'::jsonb; k text; v jsonb; s text;
  uuid_pattern text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  table_names text[] := ARRAY['profiles','user_permissions','clients','client_contacts','events','event_days','event_day_crew','meetings','finance_entries','crew_members','crew_documents','shifts','equipment_items','equipment_assignments','documents','time_entries','time_entry_additions','quotes','quote_sections','quote_items','quote_versions','price_catalog','company_settings','paperless_documents','quote_images','backups','event_accounting_references','event_accounting_files'];
BEGIN
  IF jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN RETURN result; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_details) LOOP
    s := v #>> '{}';
    IF (k IN ('target_id','user_id','event_id','quote_id','backup_id') AND jsonb_typeof(v) = 'string' AND s ~ uuid_pattern)
      OR (k IN ('count','changed','rows') AND jsonb_typeof(v) = 'number' AND s ~ '^[0-9]{1,12}$')
      OR (k IN ('view','edit','old_view','old_edit') AND jsonb_typeof(v) = 'boolean')
      OR (k = 'module' AND jsonb_typeof(v) = 'string' AND s = ANY(public._security_modules()))
      OR (k = 'role' AND jsonb_typeof(v) = 'string' AND s IN ('admin','warehouse','accounting','crew','sales'))
      OR (k = 'mode' AND jsonb_typeof(v) = 'string' AND s IN ('manual','auto','automatic','full','selected','merge','replace','role_presets'))
      OR (k = 'outcome' AND jsonb_typeof(v) = 'string' AND s IN ('success','failure','failed','denied','ok','error'))
      OR (k = 'operation' AND jsonb_typeof(v) = 'string' AND s IN ('INSERT','UPDATE','DELETE','insert','update','delete','reset','role','create','restore')) THEN
      result := result || jsonb_build_object(k, v);
    ELSIF k IN ('target_ids','tables') AND jsonb_typeof(v) = 'array' THEN
      IF jsonb_array_length(v) <= 10000 AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string'
          OR CASE WHEN k = 'target_ids' THEN (e #>> '{}') !~ uuid_pattern ELSE NOT ((e #>> '{}') = ANY(table_names)) END
      ) THEN result := result || jsonb_build_object(k,v); END IF;
    ELSIF k = 'rows' AND jsonb_typeof(v) = 'object' THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE NOT (e.key = ANY(table_names))
        OR jsonb_typeof(e.value) <> 'number' OR (e.value #>> '{}') !~ '^[0-9]{1,12}$') THEN
        result := result || jsonb_build_object(k,v);
      END IF;
    END IF;
  END LOOP;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public._security_clean_details(jsonb) FROM PUBLIC, anonymous, authenticated;

CREATE OR REPLACE FUNCTION public.record_security_audit(p_actor text, p_action text, p_module text, p_details jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR p_action IS NULL OR p_action NOT IN ('event.delete','quote.delete','permissions.change','permissions.reset','backup.create','backup.restore')
    OR p_module IS NULL OR NOT (p_module = ANY(public._security_modules())) THEN
    RAISE EXCEPTION 'Invalid audit metadata' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_logs(user_id,action,module,details)
    VALUES (p_actor,p_action,p_module,public._security_clean_details(p_details));
END $$;
REVOKE ALL ON FUNCTION public.record_security_audit(text,text,text,jsonb) FROM PUBLIC, anonymous, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_security_audit(text,text,text,jsonb) TO site_server';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._security_capture_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE uid text := nullif(auth.user_id()::text, ''); details jsonb; item jsonb;
BEGIN
  -- Server operations without a JWT append their own trusted summary.
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'quotes' THEN
    PERFORM public.record_security_audit(uid,'quote.delete','quotes',jsonb_build_object('target_id',OLD.id));
  ELSIF TG_TABLE_NAME = 'profiles' THEN
    IF NEW.role IS NOT DISTINCT FROM OLD.role THEN RETURN NULL; END IF;
    PERFORM public.record_security_audit(uid,'permissions.change','users',
      jsonb_build_object('user_id',NEW.id,'role',NEW.role,'operation','role'));
  ELSE
    item := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_OP = 'UPDATE' AND NEW.can_view IS NOT DISTINCT FROM OLD.can_view
      AND NEW.can_edit IS NOT DISTINCT FROM OLD.can_edit AND NEW.user_id = OLD.user_id AND NEW.module = OLD.module THEN RETURN NULL; END IF;
    details := jsonb_build_object('user_id',item->'user_id','module',item->'module','operation',TG_OP,
      'view',item->'can_view','edit',item->'can_edit');
    IF TG_OP <> 'INSERT' THEN details := details || jsonb_build_object('old_view',OLD.can_view,'old_edit',OLD.can_edit); END IF;
    PERFORM public.record_security_audit(uid,'permissions.change','users',details);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._security_capture_change() FROM PUBLIC, anonymous, authenticated;
DROP TRIGGER IF EXISTS security_permission_change ON public.user_permissions;
CREATE TRIGGER security_permission_change AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public._security_capture_change();
DROP TRIGGER IF EXISTS security_profile_role_change ON public.profiles;
CREATE TRIGGER security_profile_role_change AFTER UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._security_capture_change();
DROP TRIGGER IF EXISTS security_quote_delete ON public.quotes;
CREATE TRIGGER security_quote_delete AFTER DELETE ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public._security_capture_change();

CREATE OR REPLACE FUNCTION public._security_reset_presets() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_object_agg(r.role, r.modules) FROM (
    SELECT role, jsonb_object_agg(module, jsonb_build_object('view',can_view,'edit',can_edit)) AS modules
    FROM (
      SELECT role, module,
        (role = 'admin' OR (role = 'warehouse' AND module IN ('equipment','attendance','calendar'))
          OR (role = 'accounting' AND module IN ('finance','quotes','clients','calendar','equipment','crew'))
          OR (role = 'crew' AND module IN ('calendar','equipment','attendance'))) AS can_view,
        (role = 'admin' OR (role = 'warehouse' AND module IN ('equipment','attendance'))
          OR (role = 'accounting' AND module IN ('finance','quotes','clients'))
          OR (role = 'crew' AND module = 'attendance')) AS can_edit
      FROM unnest(ARRAY['admin','warehouse','accounting','crew']) role
      CROSS JOIN unnest(public._security_modules()) module
    ) flags GROUP BY role
  ) r
$$;
REVOKE ALL ON FUNCTION public._security_reset_presets() FROM PUBLIC, anonymous, authenticated;

CREATE OR REPLACE FUNCTION public._security_owner_ids() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ids text[];
BEGIN
  -- Failure deliberately aborts a preview/reset rather than targeting an unverified owner.
  EXECUTE 'SELECT coalesce(array_agg(u.id::text), ARRAY[]::text[]) FROM neon_auth."user" u
    WHERE lower(u.email) = ''a0525092333@gmail.com''
      AND coalesce((to_jsonb(u)->>''emailVerified'')::boolean, false)' INTO ids;
  RETURN ids;
END $$;
REVOKE ALL ON FUNCTION public._security_owner_ids() FROM PUBLIC, anonymous, authenticated;

CREATE OR REPLACE FUNCTION public.role_permission_reset_preview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor jsonb := public.security_actor('users','edit'); presets jsonb := public._security_reset_presets();
  result jsonb; owner_ids text[];
BEGIN
  IF NOT ((actor->>'is_owner')::boolean AND (actor->>'allowed')::boolean) THEN
    RAISE EXCEPTION 'Owner only' USING ERRCODE = '42501';
  END IF;
  owner_ids := public._security_owner_ids();
  WITH targets AS (
    SELECT p.* FROM public.profiles p WHERE p.role IN ('admin','warehouse','accounting','crew')
      AND NOT (p.id::text = ANY(owner_ids))
  ), accounts AS (
    SELECT p.id, p.full_name, p.role, count(*) FILTER (WHERE up.user_id IS NULL
      OR up.can_view IS DISTINCT FROM (presets->p.role->m.module->>'view')::boolean
      OR up.can_edit IS DISTINCT FROM (presets->p.role->m.module->>'edit')::boolean) AS changed
    FROM targets p CROSS JOIN unnest(public._security_modules()) m(module)
    LEFT JOIN public.user_permissions up ON up.user_id = p.id AND up.module = m.module
    GROUP BY p.id,p.full_name,p.role
  ) SELECT jsonb_build_object(
    'fingerprint', md5(coalesce((SELECT jsonb_agg(jsonb_build_array(p.id,p.role,
      (SELECT jsonb_agg(jsonb_build_array(up.module,up.can_view,up.can_edit) ORDER BY up.module)
        FROM public.user_permissions up WHERE up.user_id = p.id)) ORDER BY p.id)::text FROM targets p),'[]')),
    'accounts', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM accounts a),'[]'::jsonb),
    'count', (SELECT count(*) FROM targets), 'presets', presets) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.role_permission_reset_preview() FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.role_permission_reset_preview() TO authenticated;

CREATE OR REPLACE FUNCTION public.reset_role_permissions(p_fingerprint text, p_confirm boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor jsonb := public.security_actor('users','edit'); preview jsonb; changed_count integer;
BEGIN
  IF NOT ((actor->>'is_owner')::boolean AND (actor->>'allowed')::boolean) THEN
    RAISE EXCEPTION 'Owner only' USING ERRCODE = '42501';
  END IF;
  IF p_confirm IS DISTINCT FROM true THEN RAISE EXCEPTION 'Explicit confirmation required' USING ERRCODE = '22023'; END IF;
  -- Block concurrent role/permission inserts, updates and deletes before recomputing.
  LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.user_permissions IN SHARE ROW EXCLUSIVE MODE;
  -- Serialize identity changes too: owner exclusions cannot change during the reset.
  EXECUTE 'LOCK TABLE neon_auth."user" IN SHARE MODE';
  preview := public.role_permission_reset_preview();
  IF p_fingerprint IS NULL OR p_fingerprint IS DISTINCT FROM preview->>'fingerprint' THEN
    RAISE EXCEPTION 'permission_reset_stale' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.user_permissions AS up(user_id,module,can_view,can_edit)
    SELECT (a->>'id')::uuid, m.module,
      (preview->'presets'->(a->>'role')->m.module->>'view')::boolean,
      (preview->'presets'->(a->>'role')->m.module->>'edit')::boolean
    FROM jsonb_array_elements(preview->'accounts') a CROSS JOIN unnest(public._security_modules()) m(module)
  ON CONFLICT (user_id,module) DO UPDATE SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit
    WHERE up.can_view IS DISTINCT FROM EXCLUDED.can_view OR up.can_edit IS DISTINCT FROM EXCLUDED.can_edit;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM public.record_security_audit(actor->>'user_id','permissions.reset','users',
    jsonb_build_object('count',preview->'count','changed',changed_count,'mode','role_presets','outcome','success'));
  RETURN jsonb_build_object('ok',true,'count',preview->'count','changed',changed_count);
END $$;
REVOKE ALL ON FUNCTION public.reset_role_permissions(text,boolean) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.reset_role_permissions(text,boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
