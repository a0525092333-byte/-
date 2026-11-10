-- ============================================================================
-- 0008 — Remove the `viewer` role.
--
-- Live DB: profiles has admin 2, crew 2, sales 1, warehouse 1, accounting 0 —
-- ZERO rows use role='viewer', so narrowing the CHECK cannot orphan a user.
-- ============================================================================
DO $block$
BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin','sales','accounting','crew','warehouse'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

DO $block$
BEGIN
  ALTER TABLE public.invites DROP CONSTRAINT IF EXISTS invites_role_check;
  ALTER TABLE public.invites ADD CONSTRAINT invites_role_check
    CHECK (role IN ('admin','sales','accounting','crew','warehouse'));
  ALTER TABLE public.invites ALTER COLUMN role SET DEFAULT 'sales';
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

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
