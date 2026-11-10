-- 0029: lock the owner email on profiles. is_super_admin() falls back to
-- public.profiles.email, so nobody but the real owner (per neon_auth."user")
-- may set a profile email to the owner address. Server/admin connections
-- (auth.user_id() empty) are unaffected. Idempotent; no data is changed.
CREATE OR REPLACE FUNCTION public.profiles_lock_owner_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE uid text; real_owner boolean := false;
BEGIN
  IF lower(coalesce(NEW.email, '')) <> 'a0525092333@gmail.com' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND lower(coalesce(OLD.email, '')) = 'a0525092333@gmail.com' THEN RETURN NEW; END IF;
  BEGIN uid := auth.user_id(); EXCEPTION WHEN OTHERS THEN uid := NULL; END;
  IF uid IS NULL OR uid = '' THEN RETURN NEW; END IF;
  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM neon_auth."user" u
      WHERE u.id::text = $1 AND lower(u.email) = ''a0525092333@gmail.com'')'
      INTO real_owner USING uid;
  EXCEPTION WHEN OTHERS THEN real_owner := false;
  END;
  IF real_owner THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'כתובת המייל של בעל החשבון שמורה' USING ERRCODE = '42501';
END $fn$;

DROP TRIGGER IF EXISTS profiles_lock_owner_email ON public.profiles;
CREATE TRIGGER profiles_lock_owner_email
BEFORE INSERT OR UPDATE OF email ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.profiles_lock_owner_email();
