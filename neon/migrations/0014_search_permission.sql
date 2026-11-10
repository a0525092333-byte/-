-- ============================================================================
-- 0014 — Global smart search permission module.
-- Adds the `search` module to the permission matrix. Today only admins get it;
-- an admin can grant it per user from the user dialog. Idempotent.
-- ============================================================================

DO $block$
BEGIN
  ALTER TABLE public.user_permissions DROP CONSTRAINT IF EXISTS user_permissions_module_check;
  ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_module_check
    CHECK (module IN ('calendar','clients','finance','crew','equipment','users','attendance','quotes','office','backup','search'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

-- Every existing profile gets a search row: admin true, everyone else false.
INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
SELECT p.id, 'search', (p.role = 'admin'), (p.role = 'admin')
FROM public.profiles p
ON CONFLICT (user_id, module) DO NOTHING;

-- New profiles: add search to the default permission seed (admin true).
CREATE OR REPLACE FUNCTION public.seed_default_permissions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
  VALUES
    (NEW.id, 'calendar', true, true),
    (NEW.id, 'clients', true, true),
    (NEW.id, 'crew', true, false),
    (NEW.id, 'search', NEW.role = 'admin', NEW.role = 'admin')
  ON CONFLICT (user_id, module) DO NOTHING;
  RETURN NEW;
END $fn$;

-- New invites: ensure a search entry exists in the invite permissions payload.
CREATE OR REPLACE FUNCTION public.create_invite(
  p_email text,
  p_full_name text DEFAULT NULL,
  p_role text DEFAULT 'sales',
  p_permissions jsonb DEFAULT '[]'::jsonb
) RETURNS public.invites
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE result public.invites%ROWTYPE;
BEGIN
  IF auth.user_id() IS NULL THEN
    RAISE EXCEPTION 'נדרשת התחברות מחדש' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'אין הרשאה ליצור הזמנה' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_permissions, '[]'::jsonb)) AS entry(value)
    WHERE value->>'module' = 'search'
  ) THEN
    p_permissions := COALESCE(p_permissions, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('module', 'search', 'can_view', p_role = 'admin', 'can_edit', p_role = 'admin')
    );
  END IF;
  INSERT INTO public.invites (email, full_name, role, permissions, status, invited_by)
  VALUES (
    lower(trim(p_email)),
    NULLIF(trim(coalesce(p_full_name, '')), ''),
    p_role,
    COALESCE(p_permissions, '[]'::jsonb),
    'pending',
    auth.user_id()::uuid
  )
  RETURNING * INTO result;
  RETURN result;
END $fn$;

GRANT EXECUTE ON FUNCTION public.create_invite(text,text,text,jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
