-- ============================================================================
-- הפקות בקליק — internal event-production operations app
-- Neon Postgres schema + RLS. Seed content lives in neon/seed.json.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

GRANT USAGE ON SCHEMA public TO authenticated;

-- ── 1. Profiles (one row per Neon Auth user; id = auth user id) ─────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid PRIMARY KEY,
  email       text NOT NULL,
  full_name   text NOT NULL,
  phone       text,
  role        text NOT NULL DEFAULT 'sales'
              CHECK (role IN ('admin','sales','accounting','crew','warehouse')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Approval gate columns (declared early so policies below can reference them).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_by uuid;

-- ── 2. Per-user module permissions (admin-controlled matrix) ────────────────
CREATE TABLE IF NOT EXISTS public.user_permissions (
  user_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module    text NOT NULL
            CHECK (module IN ('calendar','clients','finance','crew','equipment','users')),
  can_view  boolean NOT NULL DEFAULT false,
  can_edit  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, module)
);

-- Viewer is intentionally permission-driven: admins can invite a user with no
-- access, then grant only the modules they need.
DO $block$
BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin','sales','accounting','crew','warehouse'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

-- ── 2b. Admin-created invitations ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  full_name     text,
  role          text NOT NULL DEFAULT 'sales'
                CHECK (role IN ('admin','sales','accounting','crew','warehouse')),
  permissions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','cancelled')),
  invited_by    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS invites_one_pending_email
  ON public.invites (lower(email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS invites_pending_created_idx
  ON public.invites (status, created_at DESC);

-- The auth schema is provisioned separately, so resolve the caller email
-- dynamically. The function remains installable before Neon Auth is present.
CREATE OR REPLACE FUNCTION public.claim_invite()
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  caller_email text;
  caller_id uuid;
  invitation public.invites%ROWTYPE;
  permission_row jsonb;
BEGIN
  IF auth.user_id() IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.claim_invite', 'on', true);
  caller_id := auth.user_id()::uuid;

  BEGIN
    EXECUTE 'SELECT email FROM neon_auth."user" WHERE id::text = auth.user_id()'
      INTO caller_email;
  EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN
    caller_email := NULL;
  END;
  IF caller_email IS NULL THEN
    BEGIN
      EXECUTE 'SELECT email FROM neon_auth.users_sync WHERE id::text = auth.user_id()'
        INTO caller_email;
    EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN
      caller_email := NULL;
    END;
  END IF;
  IF caller_email IS NULL THEN RETURN false; END IF;

  SELECT * INTO invitation
  FROM public.invites
  WHERE lower(email) = lower(caller_email) AND status = 'pending'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (caller_id, lower(caller_email), COALESCE(NULLIF(invitation.full_name, ''), split_part(caller_email, '@', 1)), invitation.role, true)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(NULLIF(invitation.full_name, ''), public.profiles.full_name),
    role = CASE WHEN public.profiles.role = 'admin' THEN public.profiles.role ELSE EXCLUDED.role END,
    is_active = true;

  DELETE FROM public.user_permissions WHERE user_id = caller_id;
  FOR permission_row IN SELECT value FROM jsonb_array_elements(invitation.permissions)
  LOOP
    INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
    VALUES (
      caller_id,
      permission_row->>'module',
      COALESCE((permission_row->>'can_view')::boolean, false),
      COALESCE((permission_row->>'can_edit')::boolean, false)
    )
    ON CONFLICT (user_id, module) DO UPDATE SET
      can_view = EXCLUDED.can_view,
      can_edit = EXCLUDED.can_edit;
  END LOOP;

  UPDATE public.invites
  SET status = 'accepted', accepted_at = now()
  WHERE id = invitation.id;
  RETURN true;
END $fn$;

GRANT EXECUTE ON FUNCTION public.claim_invite() TO authenticated;

-- ── 3. Helper functions (SECURITY DEFINER; read the caller's own row) ───────
-- is_admin(): true when the caller's profile role is admin, OR when the
-- platform granted the Neon Auth admin role. The neon_auth tables may not
-- exist yet at migration time, so both lookups use dynamic EXECUTE + EXCEPTION.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id::text = auth.user_id() AND p.role = 'admin' AND p.is_active
  ) INTO ok;
  IF ok THEN RETURN true; END IF;

  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM neon_auth."user" u
      WHERE u.id::text = auth.user_id() AND u.role = ''admin''
      AND coalesce(u.banned, false) = false)' INTO ok;
  EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN
    ok := false;
  END;
  IF ok THEN RETURN true; END IF;

  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM neon_auth.users_sync u
      WHERE u.id::text = auth.user_id() AND u.role = ''admin'')' INTO ok;
  EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN
    ok := false;
  END;
  RETURN COALESCE(ok, false);
END $fn$;

CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF auth.user_id() IS NULL OR auth.user_id() = '' THEN RETURN false; END IF;

  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM neon_auth."user" u
      WHERE u.id::text = auth.user_id()
      AND lower(u.email) = ''a0525092333@gmail.com'')' INTO ok;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  IF ok THEN RETURN true; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id::text = auth.user_id()
        AND lower(p.email) = 'a0525092333@gmail.com'
    ) INTO ok;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- is_approved(): true when the caller is an admin or an approved, active profile.
CREATE OR REPLACE FUNCTION public.is_approved() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id::text = auth.user_id()
      AND p.approval_status = 'approved'
      AND coalesce(p.is_active, true) = true
  );
END $fn$;

GRANT EXECUTE ON FUNCTION public.is_approved() TO authenticated;

CREATE OR REPLACE FUNCTION public.app_role() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE r text;
BEGIN
  IF public.is_admin() THEN RETURN 'admin'; END IF;
  SELECT p.role INTO r FROM public.profiles p WHERE p.id::text = auth.user_id();
  RETURN COALESCE(r, 'none');
END $fn$;

CREATE OR REPLACE FUNCTION public.has_permission(p_module text, p_action text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  IF p_action = 'edit' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_edit
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_view
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;

-- New profiles get a minimal, safe default: calendar view/edit only.
CREATE OR REPLACE FUNCTION public.seed_default_permissions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
  VALUES
    (NEW.id, 'calendar', true, true),
    (NEW.id, 'clients', true, true),
    (NEW.id, 'crew', true, false)
  ON CONFLICT (user_id, module) DO NOTHING;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS profiles_default_perms ON public.profiles;
CREATE TRIGGER profiles_default_perms
AFTER INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.seed_default_permissions();

-- A user may edit their own name/phone, but never their own role or active flag.
CREATE OR REPLACE FUNCTION public.protect_profile_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    NEW.role := OLD.role;
    NEW.is_active := OLD.is_active;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS profiles_protect_fields ON public.profiles;
CREATE TRIGGER profiles_protect_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_fields();

-- ── 4. Business tables ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  contact_name  text,
  phone         text,
  email         text,
  tax_id        text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Optional fields used by the spreadsheet importer. Idempotent, no data change.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS company text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS tax_id text;

CREATE TABLE IF NOT EXISTS public.events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  client_id      uuid REFERENCES public.clients(id) ON DELETE RESTRICT,
  event_type     text NOT NULL DEFAULT 'אחר',
  event_date     date NOT NULL,
  start_time     time,
  end_time       time,
  venue          text,
  address        text,
  guest_count    int,
  status         text NOT NULL DEFAULT 'ממתין לסגירה'
                 CHECK (status IN ('ממתין לסגירה','נסגר','ממתין לתשלום','שולם')),
  sales_rep_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  sales_rep_name text,
  notes          text,
  total_amount   numeric NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.meetings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  user_id     uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  location    text,
  kind        text NOT NULL DEFAULT 'פגישה'
              CHECK (kind IN ('פגישה','שיחה','מעקב','אירוע')),
  event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
  notes       text,
  done        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind        text NOT NULL
              CHECK (kind IN ('הצעת מחיר','חוזה','חשבונית','תשלום','הוצאה')),
  amount      numeric NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'ממתין'
              CHECK (status IN ('ממתין','שולם','באיחור')),
  doc_number  text,
  issued_at   date,
  due_at      date,
  paid_at     date,
  notes       text,
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crew_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    text NOT NULL,
  phone        text,
  role_title   text NOT NULL DEFAULT 'טכנאי',
  hourly_rate  numeric,
  is_active    boolean NOT NULL DEFAULT true,
  user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  crew_member_id  uuid NOT NULL REFERENCES public.crew_members(id) ON DELETE CASCADE,
  role_title      text NOT NULL DEFAULT 'טכנאי',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz,
  status          text NOT NULL DEFAULT 'משובץ'
                  CHECK (status IN ('משובץ','אושר','הגיע','לא הגיע')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.equipment_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  category       text NOT NULL DEFAULT 'אחר',
  quantity_total int NOT NULL DEFAULT 1,
  quantity_out   int NOT NULL DEFAULT 0,
  min_quantity   int NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'במחסן'
                 CHECK (status IN ('במחסן','בשטח','בתיקון')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.equipment_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_item_id  uuid NOT NULL REFERENCES public.equipment_items(id) ON DELETE CASCADE,
  event_id           uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  quantity           int NOT NULL CHECK (quantity > 0),
  out_at             date NOT NULL DEFAULT current_date,
  returned_at        timestamptz,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name         text NOT NULL,
  url          text NOT NULL,
  uploaded_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── 5. Equipment availability trigger (never negative) ─────────────────────
CREATE OR REPLACE FUNCTION public.recalc_equipment_out(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE total int; outq int;
BEGIN
  SELECT quantity_total INTO total FROM public.equipment_items WHERE id = p_id;
  SELECT COALESCE(SUM(quantity), 0) INTO outq
  FROM public.equipment_assignments
  WHERE equipment_item_id = p_id AND returned_at IS NULL;
  IF outq > COALESCE(total, 0) THEN
    RAISE EXCEPTION 'כמות הציוד הזמינה אינה מספיקה';
  END IF;
  UPDATE public.equipment_items
  SET quantity_out = outq,
      status = CASE
        WHEN outq > 0 THEN 'בשטח'
        WHEN status = 'בשטח' THEN 'במחסן'
        ELSE status
      END
  WHERE id = p_id;
END $fn$;

CREATE OR REPLACE FUNCTION public.sync_equipment_out() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalc_equipment_out(OLD.equipment_item_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.equipment_item_id IS DISTINCT FROM NEW.equipment_item_id THEN
    PERFORM public.recalc_equipment_out(OLD.equipment_item_id);
  END IF;
  PERFORM public.recalc_equipment_out(NEW.equipment_item_id);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS equipment_assignments_sync ON public.equipment_assignments;
CREATE TRIGGER equipment_assignments_sync
AFTER INSERT OR UPDATE OR DELETE ON public.equipment_assignments
FOR EACH ROW EXECUTE FUNCTION public.sync_equipment_out();

-- ── 5b. De-recursion helpers ────────────────────────────────────────────────
-- These SECURITY DEFINER functions read the cross-table relationship WITHOUT
-- re-entering RLS, so events / shifts / equipment_assignments policies cannot
-- recurse into each other. The ::text casts are required (uuid vs auth text id).
CREATE OR REPLACE FUNCTION public.is_crew_on_event(p_event_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event_id AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
END $fn$;

CREATE OR REPLACE FUNCTION public.sales_owns_event(p_event_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event_id AND e.sales_rep_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
END $fn$;

-- ── 6. RLS: profiles + permissions ─────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.invites TO authenticated;

DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR public.is_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('calendar','view')
  OR public.has_permission('clients','view')
  OR public.has_permission('finance','view')
  OR public.has_permission('crew','view')
  OR public.has_permission('equipment','view')
);

DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
CREATE POLICY profiles_insert_self ON public.profiles FOR INSERT TO authenticated WITH CHECK (
  id::text = auth.user_id() AND role = 'sales'
);

DROP POLICY IF EXISTS profiles_update_self_or_admin ON public.profiles;
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated
  USING (id::text = auth.user_id() OR public.is_admin())
  WITH CHECK (id::text = auth.user_id() OR public.is_admin());

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invites_admin_read ON public.invites;
CREATE POLICY invites_admin_read ON public.invites FOR SELECT TO authenticated
  USING (public.is_admin());
DROP POLICY IF EXISTS invites_admin_write ON public.invites;
CREATE POLICY invites_admin_write ON public.invites FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_permissions TO authenticated;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id() OR public.is_admin()
);

DROP POLICY IF EXISTS user_permissions_admin_write ON public.user_permissions;
CREATE POLICY user_permissions_admin_write ON public.user_permissions FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── 7. RLS: clients ────────────────────────────────────────────────────────
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;

DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.has_permission('clients','view')
  OR public.has_permission('calendar','view')
  OR public.has_permission('finance','view')
  OR public.has_permission('crew','view')
  OR public.has_permission('equipment','view')
);

DROP POLICY IF EXISTS clients_edit ON public.clients;
CREATE POLICY clients_edit ON public.clients FOR ALL TO authenticated
USING (public.has_permission('clients','edit'))
WITH CHECK (public.has_permission('clients','edit'));

-- ── 8. RLS: events ─────────────────────────────────────────────────────────
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events TO authenticated;

DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  public.is_admin()
  OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
  OR (public.has_permission('equipment','view') AND public.app_role() = 'warehouse')
  OR (public.has_permission('calendar','view')
      AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
  OR (public.has_permission('clients','view')
      AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
  OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
);

DROP POLICY IF EXISTS events_edit ON public.events;
CREATE POLICY events_edit ON public.events FOR ALL TO authenticated
USING (
  public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
)
WITH CHECK (
  public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
);

-- ── 9. RLS: meetings ───────────────────────────────────────────────────────
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meetings TO authenticated;

DROP POLICY IF EXISTS meetings_read ON public.meetings;
CREATE POLICY meetings_read ON public.meetings FOR SELECT TO authenticated USING (
  public.is_admin() OR user_id::text = auth.user_id()
);

DROP POLICY IF EXISTS meetings_edit ON public.meetings;
CREATE POLICY meetings_edit ON public.meetings FOR ALL TO authenticated
USING (
  public.is_admin()
  OR (public.has_permission('calendar','edit') AND user_id::text = auth.user_id())
)
WITH CHECK (
  public.is_admin()
  OR (public.has_permission('calendar','edit') AND user_id::text = auth.user_id())
);

-- ── 10. RLS: finance ───────────────────────────────────────────────────────
ALTER TABLE public.finance_entries ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance_entries TO authenticated;

DROP POLICY IF EXISTS finance_read ON public.finance_entries;
CREATE POLICY finance_read ON public.finance_entries FOR SELECT TO authenticated USING (
  public.has_permission('finance','view')
);

DROP POLICY IF EXISTS finance_edit ON public.finance_entries;
CREATE POLICY finance_edit ON public.finance_entries FOR ALL TO authenticated
USING (public.has_permission('finance','edit'))
WITH CHECK (public.has_permission('finance','edit'));

-- ── 11. RLS: crew + shifts ─────────────────────────────────────────────────
ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crew_members TO authenticated;

DROP POLICY IF EXISTS crew_members_read ON public.crew_members;
CREATE POLICY crew_members_read ON public.crew_members FOR SELECT TO authenticated USING (
  public.has_permission('crew','view')
);

DROP POLICY IF EXISTS crew_members_edit ON public.crew_members;
CREATE POLICY crew_members_edit ON public.crew_members FOR ALL TO authenticated
USING (public.has_permission('crew','edit'))
WITH CHECK (public.has_permission('crew','edit'));

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shifts TO authenticated;

DROP POLICY IF EXISTS shifts_read ON public.shifts;
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated USING (
  public.has_permission('crew','view') AND (
    public.app_role() = ANY (ARRAY['admin','accounting','warehouse'])
    OR (public.app_role() = 'sales' AND public.sales_owns_event(event_id))
    OR (public.app_role() = 'crew' AND crew_member_id IN (
      SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id()
    ))
  )
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (public.has_permission('crew','edit'))
WITH CHECK (public.has_permission('crew','edit'));

DROP POLICY IF EXISTS shifts_crew_self_update ON public.shifts;
CREATE POLICY shifts_crew_self_update ON public.shifts FOR UPDATE TO authenticated
USING (
  public.app_role() = 'crew'
  AND crew_member_id IN (SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id())
)
WITH CHECK (
  public.app_role() = 'crew'
  AND crew_member_id IN (SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id())
);

-- ── 12. RLS: equipment ─────────────────────────────────────────────────────
ALTER TABLE public.equipment_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.equipment_items TO authenticated;

DROP POLICY IF EXISTS equipment_items_read ON public.equipment_items;
CREATE POLICY equipment_items_read ON public.equipment_items FOR SELECT TO authenticated USING (
  public.has_permission('equipment','view')
);

DROP POLICY IF EXISTS equipment_items_edit ON public.equipment_items;
CREATE POLICY equipment_items_edit ON public.equipment_items FOR ALL TO authenticated
USING (public.has_permission('equipment','edit'))
WITH CHECK (public.has_permission('equipment','edit'));

ALTER TABLE public.equipment_assignments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.equipment_assignments TO authenticated;

DROP POLICY IF EXISTS equipment_assignments_read ON public.equipment_assignments;
CREATE POLICY equipment_assignments_read ON public.equipment_assignments FOR SELECT TO authenticated USING (
  public.has_permission('equipment','view') AND (
    public.app_role() <> 'crew'
    OR public.is_crew_on_event(event_id)
  )
);

DROP POLICY IF EXISTS equipment_assignments_edit ON public.equipment_assignments;
CREATE POLICY equipment_assignments_edit ON public.equipment_assignments FOR ALL TO authenticated
USING (public.has_permission('equipment','edit'))
WITH CHECK (public.has_permission('equipment','edit'));

-- ── 13. RLS: event documents ───────────────────────────────────────────────
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;

DROP POLICY IF EXISTS documents_read ON public.documents;
CREATE POLICY documents_read ON public.documents FOR SELECT TO authenticated USING (
  public.is_admin()
  OR public.has_permission('clients','view')
  OR public.has_permission('calendar','view')
  OR public.has_permission('finance','view')
  OR public.has_permission('crew','view')
  OR public.has_permission('equipment','view')
);

DROP POLICY IF EXISTS documents_edit ON public.documents;
CREATE POLICY documents_edit ON public.documents FOR ALL TO authenticated
USING (public.has_permission('clients','edit'))
WITH CHECK (public.has_permission('clients','edit'));

-- ── 14. Owner admin bootstrap ───────────────────────────────────────────────
-- The platform grants the Neon Auth admin role; keep the app's own profiles.role
-- in sync for the owner so the UI shows מנהל immediately. Idempotent, single row,
-- no other columns touched. The protect trigger is disabled for this statement
-- because the migration connection has no auth.user_id() and would otherwise
-- revert the role change.
ALTER TABLE public.profiles DISABLE TRIGGER profiles_protect_fields;
UPDATE public.profiles
SET role = 'admin'
WHERE email = 'a0525092333@gmail.com';
ALTER TABLE public.profiles ENABLE TRIGGER profiles_protect_fields;

-- ── 15. Employee attendance (time clock) ───────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS hourly_rate numeric(10,2);

DO $block$
BEGIN
  ALTER TABLE public.user_permissions DROP CONSTRAINT IF EXISTS user_permissions_module_check;
  ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_module_check
    CHECK (module IN ('calendar','clients','finance','crew','equipment','users','attendance'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

CREATE TABLE IF NOT EXISTS public.time_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  work_date      date NOT NULL,
  start_time     time,
  end_time       time,
  break_minutes  integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  day_type       text NOT NULL DEFAULT 'work'
                 CHECK (day_type IN ('work','vacation','sick','reserve','holiday','absence')),
  shift_type     text NOT NULL DEFAULT 'day'
                 CHECK (shift_type IN ('day','evening','night')),
  travel_km      numeric(10,2) NOT NULL DEFAULT 0 CHECK (travel_km >= 0),
  travel_amount  numeric(12,2) NOT NULL DEFAULT 0 CHECK (travel_amount >= 0),
  event_id       uuid REFERENCES public.events(id) ON DELETE SET NULL,
  note           text,
  status         text NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('draft','submitted','approved')),
  approved_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS time_entries_user_date_idx ON public.time_entries (user_id, work_date);
CREATE INDEX IF NOT EXISTS time_entries_date_idx ON public.time_entries (work_date);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open_per_user
  ON public.time_entries (user_id) WHERE end_time IS NULL AND start_time IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.time_entry_additions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES public.time_entries(id) ON DELETE CASCADE,
  add_type    text NOT NULL
              CHECK (add_type IN ('overtime_125','overtime_150','night','shabbat','holiday','oncall','meal','travel','other')),
  hours       numeric(6,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  rate        numeric(10,2) NOT NULL DEFAULT 1 CHECK (rate >= 0),
  amount      numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS time_entry_additions_entry_idx ON public.time_entry_additions (entry_id);

CREATE OR REPLACE FUNCTION public.touch_time_entry() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS time_entries_touch ON public.time_entries;
CREATE TRIGGER time_entries_touch
BEFORE UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.touch_time_entry();

-- One SECURITY DEFINER helper for additions. p_write=true also requires the
-- entry to be editable (owner and not approved, or admin/attendance-edit).
CREATE OR REPLACE FUNCTION public.owns_time_entry(p_entry uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF public.is_admin() OR public.has_permission('attendance','edit') THEN RETURN true; END IF;
  IF NOT p_write AND public.has_permission('attendance','view') THEN RETURN true; END IF;
  IF p_write THEN
    SELECT EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = p_entry AND te.user_id::text = auth.user_id() AND te.status <> 'approved'
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = p_entry AND te.user_id::text = auth.user_id()
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;

GRANT EXECUTE ON FUNCTION public.owns_time_entry(uuid, boolean) TO authenticated;

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_entries TO authenticated;

DROP POLICY IF EXISTS time_entries_read ON public.time_entries;
CREATE POLICY time_entries_read ON public.time_entries FOR SELECT TO authenticated
USING (
  user_id::text = auth.user_id()
  OR public.is_admin()
  OR public.has_permission('attendance','view')
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS time_entries_insert ON public.time_entries;
CREATE POLICY time_entries_insert ON public.time_entries FOR INSERT TO authenticated
WITH CHECK (
  (user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS time_entries_update ON public.time_entries;
CREATE POLICY time_entries_update ON public.time_entries FOR UPDATE TO authenticated
USING (
  (user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
)
WITH CHECK (
  (user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS time_entries_delete ON public.time_entries;
CREATE POLICY time_entries_delete ON public.time_entries FOR DELETE TO authenticated
USING (
  (user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
);

ALTER TABLE public.time_entry_additions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_entry_additions TO authenticated;

DROP POLICY IF EXISTS time_entry_additions_read ON public.time_entry_additions;
CREATE POLICY time_entry_additions_read ON public.time_entry_additions FOR SELECT TO authenticated
USING (public.owns_time_entry(entry_id, false));

DROP POLICY IF EXISTS time_entry_additions_insert ON public.time_entry_additions;
CREATE POLICY time_entry_additions_insert ON public.time_entry_additions FOR INSERT TO authenticated
WITH CHECK (public.owns_time_entry(entry_id, true));

DROP POLICY IF EXISTS time_entry_additions_update ON public.time_entry_additions;
CREATE POLICY time_entry_additions_update ON public.time_entry_additions FOR UPDATE TO authenticated
USING (public.owns_time_entry(entry_id, true))
WITH CHECK (public.owns_time_entry(entry_id, true));

DROP POLICY IF EXISTS time_entry_additions_delete ON public.time_entry_additions;
CREATE POLICY time_entry_additions_delete ON public.time_entry_additions FOR DELETE TO authenticated
USING (public.owns_time_entry(entry_id, true));

-- PostgREST schema-cache refresh: harmless idempotent DDL touch so the Data API
-- notices the attendance tables after a migration re-apply. No column or data change.
COMMENT ON TABLE public.time_entries IS 'employee time clock entries';
COMMENT ON TABLE public.time_entry_additions IS 'employee time clock additions';
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- hourly_rate is admin/attendance-edit only; employees cannot set their own.
CREATE OR REPLACE FUNCTION public.protect_profile_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NOT (public.is_super_admin() OR public.has_permission('users','edit')) THEN
    -- claim_invite() sets this transaction-local flag so the invited role can land.
    IF current_setting('app.claim_invite', true) IS DISTINCT FROM 'on' THEN
      NEW.role := OLD.role;
      NEW.is_active := OLD.is_active;
    END IF;
    IF NOT public.has_permission('attendance','edit') THEN
      NEW.hourly_rate := OLD.hourly_rate;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR public.is_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('attendance','view')
  OR public.has_permission('attendance','edit')
  OR public.has_permission('calendar','view')
  OR public.has_permission('clients','view')
  OR public.has_permission('finance','view')
  OR public.has_permission('crew','view')
  OR public.has_permission('equipment','view')
);

DROP POLICY IF EXISTS profiles_update_self_or_admin ON public.profiles;
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated
USING (
  id::text = auth.user_id()
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
)
WITH CHECK (
  id::text = auth.user_id()
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
);

-- ── 16. Invite creation hardening ──────────────────────────────────────────
ALTER TABLE public.invites ALTER COLUMN invited_by SET DEFAULT auth.user_id()::uuid;

DROP POLICY IF EXISTS invites_admin_insert ON public.invites;
CREATE POLICY invites_admin_insert ON public.invites FOR INSERT TO authenticated
WITH CHECK ((public.is_super_admin() OR public.has_permission('users','edit')) AND invited_by::text = auth.user_id());

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
  IF NOT (public.is_super_admin() OR public.has_permission('users','edit')) THEN
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

-- ── 17. Quotes (הצעות מחיר) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number    text NOT NULL UNIQUE,
  client_id       uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  client_name     text NOT NULL,
  client_address  text,
  venue           text,
  event_id        uuid REFERENCES public.events(id) ON DELETE SET NULL,
  event_date      date,
  quote_date      date NOT NULL DEFAULT CURRENT_DATE,
  print_date      date,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','approved','rejected')),
  discount_type   text NOT NULL DEFAULT 'percent'
                  CHECK (discount_type IN ('percent','fixed')),
  discount_value  numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate        numeric(5,2) NOT NULL DEFAULT 18,
  notes           text,
  terms           jsonb NOT NULL DEFAULT '["חתימה על מסמך זה מהווה אישור על ביצוע העבודה","הצעה זאת אינה כוללת בדיקה ואישור מהנדס חשמל וקונסטרוקציה","המזמין מתחייב לדאוג לגישה נוחה למקום האירוע","קיום אירוע או מופע מותנה בקבלת אישור מהגורמים הנדרשים","באחריות הלקוח לדאוג לשמירה על הציוד אשר יוקם מספר ימים לפני האירוע","הלקוח ישא בעלות בגין נזק אובדן אשר יגרם לציוד במהלך זמן שהות הציוד בשטח"]'::jsonb,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFAULT auth.user_id()::uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_sections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  name                text NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  show_section_totals boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  section_id  uuid REFERENCES public.quote_sections(id) ON DELETE SET NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  name        text NOT NULL,
  description text,
  qty         numeric(10,2) NOT NULL DEFAULT 1,
  unit        text,
  unit_price  numeric(12,2) NOT NULL DEFAULT 0,
  is_optional boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.price_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text UNIQUE,
  name          text NOT NULL,
  description   text,
  section       text,
  unit          text,
  default_price numeric(12,2) NOT NULL DEFAULT 0,
  vat_included  boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.company_settings (
  id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name       text NOT NULL DEFAULT 'נס סגא לדים ומולטימדיה בע״מ',
  logo_url           text,
  tax_id             text,
  address            text,
  phone              text,
  email              text,
  default_vat_rate   numeric(5,2) NOT NULL DEFAULT 18,
  default_terms      jsonb NOT NULL DEFAULT '["חתימה על מסמך זה מהווה אישור על ביצוע העבודה","הצעה זאת אינה כוללת בדיקה ואישור מהנדס חשמל וקונסטרוקציה","המזמין מתחייב לדאוג לגישה נוחה למקום האירוע","קיום אירוע או מופע מותנה בקבלת אישור מהגורמים הנדרשים","באחריות הלקוח לדאוג לשמירה על הציוד אשר יוקם מספר ימים לפני האירוע","הלקוח ישא בעלות בגין נזק אובדן אשר יגרם לציוד במהלך זמן שהות הציוד בשטח"]'::jsonb,
  default_notes      text,
  quote_number_prefix text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotes_created_idx ON public.quotes (created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_status_idx ON public.quotes (status);
CREATE INDEX IF NOT EXISTS quotes_client_idx ON public.quotes (client_id);
CREATE INDEX IF NOT EXISTS quote_sections_quote_idx ON public.quote_sections (quote_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_items_quote_idx ON public.quote_items (quote_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_items_section_idx ON public.quote_items (section_id);
CREATE INDEX IF NOT EXISTS price_catalog_active_idx ON public.price_catalog (is_active, section);

CREATE OR REPLACE FUNCTION public.owns_quote(p_quote uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_approved() AND NOT public.is_admin() THEN RETURN false; END IF;
  IF public.is_admin() OR public.has_permission('quotes','edit') THEN RETURN true; END IF;
  IF NOT p_write AND public.has_permission('quotes','view') THEN RETURN true; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.id = p_quote AND q.created_by::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
END $fn$;

GRANT EXECUTE ON FUNCTION public.owns_quote(uuid, boolean) TO authenticated;

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quotes TO authenticated;

DROP POLICY IF EXISTS quotes_read ON public.quotes;
CREATE POLICY quotes_read ON public.quotes FOR SELECT TO authenticated USING (
  (public.is_approved() AND created_by::text = auth.user_id())
  OR public.is_admin()
  OR public.has_permission('quotes','view')
  OR public.has_permission('quotes','edit')
);

DROP POLICY IF EXISTS quotes_insert ON public.quotes;
CREATE POLICY quotes_insert ON public.quotes FOR INSERT TO authenticated WITH CHECK (
  (public.is_approved() AND created_by::text = auth.user_id())
  OR public.is_admin()
  OR public.has_permission('quotes','edit')
);

DROP POLICY IF EXISTS quotes_update ON public.quotes;
CREATE POLICY quotes_update ON public.quotes FOR UPDATE TO authenticated
USING (
  (public.is_approved() AND created_by::text = auth.user_id())
  OR public.is_admin()
  OR public.has_permission('quotes','edit')
)
WITH CHECK (
  (public.is_approved() AND created_by::text = auth.user_id())
  OR public.is_admin()
  OR public.has_permission('quotes','edit')
);

DROP POLICY IF EXISTS quotes_delete ON public.quotes;
CREATE POLICY quotes_delete ON public.quotes FOR DELETE TO authenticated USING (
  (public.is_approved() AND created_by::text = auth.user_id())
  OR public.is_admin()
);

ALTER TABLE public.quote_sections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_sections TO authenticated;

DROP POLICY IF EXISTS quote_sections_read ON public.quote_sections;
CREATE POLICY quote_sections_read ON public.quote_sections FOR SELECT TO authenticated
USING (public.owns_quote(quote_id, false));

DROP POLICY IF EXISTS quote_sections_write ON public.quote_sections;
CREATE POLICY quote_sections_write ON public.quote_sections FOR ALL TO authenticated
USING (public.owns_quote(quote_id, true))
WITH CHECK (public.owns_quote(quote_id, true));

ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_items TO authenticated;

DROP POLICY IF EXISTS quote_items_read ON public.quote_items;
CREATE POLICY quote_items_read ON public.quote_items FOR SELECT TO authenticated
USING (public.owns_quote(quote_id, false));

DROP POLICY IF EXISTS quote_items_write ON public.quote_items;
CREATE POLICY quote_items_write ON public.quote_items FOR ALL TO authenticated
USING (public.owns_quote(quote_id, true))
WITH CHECK (public.owns_quote(quote_id, true));

ALTER TABLE public.price_catalog ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_catalog TO authenticated;

DROP POLICY IF EXISTS price_catalog_read ON public.price_catalog;
CREATE POLICY price_catalog_read ON public.price_catalog FOR SELECT TO authenticated USING (public.is_approved());

DROP POLICY IF EXISTS price_catalog_write ON public.price_catalog;
CREATE POLICY price_catalog_write ON public.price_catalog FOR ALL TO authenticated
USING (public.is_admin() OR public.has_permission('quotes','edit'))
WITH CHECK (public.is_admin() OR public.has_permission('quotes','edit'));

ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.company_settings TO authenticated;

DROP POLICY IF EXISTS company_settings_read ON public.company_settings;
CREATE POLICY company_settings_read ON public.company_settings FOR SELECT TO authenticated USING (public.is_approved());

DROP POLICY IF EXISTS company_settings_write ON public.company_settings;
CREATE POLICY company_settings_write ON public.company_settings FOR ALL TO authenticated
USING (public.is_admin() OR public.has_permission('quotes','edit'))
WITH CHECK (public.is_admin() OR public.has_permission('quotes','edit'));

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS quotes_touch ON public.quotes;
CREATE TRIGGER quotes_touch BEFORE UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS company_settings_touch ON public.company_settings;
CREATE TRIGGER company_settings_touch BEFORE UPDATE ON public.company_settings
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Quotes permission module (idempotent constraint refresh).
DO $block$
BEGIN
  ALTER TABLE public.user_permissions DROP CONSTRAINT IF EXISTS user_permissions_module_check;
  ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_module_check
    CHECK (module IN ('calendar','clients','finance','crew','equipment','users','attendance','quotes'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

-- Quote users need to read clients and events for the pickers.
DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.has_permission('clients','view')
  OR public.has_permission('calendar','view')
  OR public.has_permission('finance','view')
  OR public.has_permission('crew','view')
  OR public.has_permission('equipment','view')
  OR public.has_permission('quotes','view')
  OR public.has_permission('quotes','edit')
);

DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  public.is_admin()
  OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
  OR (public.has_permission('equipment','view') AND public.app_role() = 'warehouse')
  OR (public.has_permission('calendar','view')
      AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
  OR (public.has_permission('clients','view')
      AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
  OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
  OR public.has_permission('quotes','view')
  OR public.has_permission('quotes','edit')
);

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 18. Quotes spec alignment + finance INSERT fix ─────────────────────────
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS issue_date date;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS valid_until date;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'ILS';
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS subtotal numeric(12,2);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS total_before_vat numeric(12,2);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS vat_amount numeric(12,2);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS grand_total numeric(12,2);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS terms_text text;

ALTER TABLE public.quote_items ADD COLUMN IF NOT EXISTS quantity numeric(10,2) NOT NULL DEFAULT 1;
ALTER TABLE public.quote_items ADD COLUMN IF NOT EXISTS line_total numeric(12,2);

ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS default_terms_text text;

DO $block$
BEGIN
  ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
  ALTER TABLE public.quotes ADD CONSTRAINT quotes_status_check
    CHECK (status IN ('draft','sent','approved','rejected','cancelled'));
  ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_discount_type_check;
  ALTER TABLE public.quotes ADD CONSTRAINT quotes_discount_type_check
    CHECK (discount_type IN ('percent','fixed','amount'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

-- finance_entries uses a uuid PK (gen_random_uuid()); no sequence grant is needed.
DROP POLICY IF EXISTS finance_read ON public.finance_entries;
CREATE POLICY finance_read ON public.finance_entries FOR SELECT TO authenticated USING (
  public.has_permission('finance','view')
  OR public.has_permission('finance','edit')
  OR public.is_admin()
);

DROP POLICY IF EXISTS finance_edit ON public.finance_entries;
DROP POLICY IF EXISTS finance_insert ON public.finance_entries;
CREATE POLICY finance_insert ON public.finance_entries FOR INSERT TO authenticated WITH CHECK (
  (public.has_permission('finance','edit') AND created_by::text = auth.user_id())
  OR public.is_admin()
);

DROP POLICY IF EXISTS finance_update ON public.finance_entries;
CREATE POLICY finance_update ON public.finance_entries FOR UPDATE TO authenticated
USING (public.has_permission('finance','edit') OR public.is_admin())
WITH CHECK (public.has_permission('finance','edit') OR public.is_admin());

DROP POLICY IF EXISTS finance_delete ON public.finance_entries;
CREATE POLICY finance_delete ON public.finance_entries FOR DELETE TO authenticated
USING (public.has_permission('finance','edit') OR public.is_admin());

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 19. Admin role sync (Neon Auth is authoritative) ───────────────────────
-- The platform grants the admin role in neon_auth."user"; profiles.role can lag
-- behind. Sync it idempotently. The protect trigger is disabled for this
-- statement because the migration connection has no auth.user_id().
ALTER TABLE public.profiles DISABLE TRIGGER profiles_protect_fields;
DO $block$
BEGIN
  UPDATE public.profiles p
  SET role = 'admin'
  FROM neon_auth."user" u
  WHERE u.id::text = p.id::text
    AND u.role = 'admin'
    AND p.role IS DISTINCT FROM 'admin';
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
END $block$;
ALTER TABLE public.profiles ENABLE TRIGGER profiles_protect_fields;

-- ── 20. Admin full-permission grant ────────────────────────────────────────
-- The admin role is authoritative, but the UI also reads user_permissions.
-- Grant every real permission module to admin profiles so the nav and module
-- gates work even if the admin RPC is temporarily unavailable. Idempotent.
INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
SELECT p.id, m.module, true, true
FROM public.profiles p
CROSS JOIN (
  VALUES
    ('calendar'), ('clients'), ('finance'), ('crew'),
    ('equipment'), ('users'), ('attendance'), ('quotes')
) AS m(module)
WHERE p.role = 'admin'
ON CONFLICT (user_id, module) DO UPDATE
SET can_view = true, can_edit = true;

-- ── 21. Paperless invoicing integration ────────────────────────────────────
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_document_id text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_document_number text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_document_type text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_url text;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_issued_at timestamptz;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_total numeric(12,2);
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS paperless_status text;

ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS paperless_environment text NOT NULL DEFAULT 'production';
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS paperless_base_url text NOT NULL DEFAULT 'https://api.paperless.tax';
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS paperless_auth_style text NOT NULL DEFAULT 'x-api-key';
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS paperless_document_path text NOT NULL DEFAULT '/invoices/api/wordpress';
ALTER TABLE public.company_settings ALTER COLUMN paperless_base_url SET DEFAULT 'https://api.paperless.tax';
UPDATE public.company_settings
SET paperless_base_url = 'https://api.paperless.tax'
WHERE paperless_base_url IN (
  'https://api.paperless.tax/invoices/api/wordpress',
  'https://api.paperless.tax/api/invoices/wordpress'
);
COMMENT ON COLUMN public.company_settings.paperless_document_path IS 'paperless endpoint path';
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

CREATE TABLE IF NOT EXISTS public.paperless_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id      uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES public.events(id) ON DELETE SET NULL,
  client_id     uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  doc_type      text NOT NULL,
  doc_number    text,
  doc_url       text,
  external_id   text,
  amount        numeric(12,2),
  status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','failed','check','unverified','pending')),
  raw_response  jsonb,
  error_message text,
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paperless_documents_created_idx ON public.paperless_documents (created_at DESC);
CREATE INDEX IF NOT EXISTS paperless_documents_quote_idx ON public.paperless_documents (quote_id);

ALTER TABLE public.paperless_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.paperless_documents TO authenticated;

DROP POLICY IF EXISTS paperless_documents_read ON public.paperless_documents;
CREATE POLICY paperless_documents_read ON public.paperless_documents FOR SELECT TO authenticated USING (
  public.has_permission('quotes','view')
  OR public.has_permission('finance','view')
  OR public.is_admin()
);

DROP POLICY IF EXISTS paperless_documents_insert ON public.paperless_documents;
CREATE POLICY paperless_documents_insert ON public.paperless_documents FOR INSERT TO authenticated WITH CHECK (
  (public.has_permission('quotes','edit') OR public.is_admin())
  AND created_by::text = auth.user_id()
);

DROP POLICY IF EXISTS paperless_documents_update ON public.paperless_documents;
CREATE POLICY paperless_documents_update ON public.paperless_documents FOR UPDATE TO authenticated
USING (public.has_permission('quotes','edit') OR public.is_admin())
WITH CHECK (public.has_permission('quotes','edit') OR public.is_admin());

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 22. Office mode (מצב משרד) ─────────────────────────────────────────────
-- New permission module: weekly split screen + crew assignment.
DO $block$
BEGIN
  ALTER TABLE public.user_permissions DROP CONSTRAINT IF EXISTS user_permissions_module_check;
  ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_module_check
    CHECK (module IN ('calendar','clients','finance','crew','equipment','users','attendance','quotes','office'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

-- Admins always have office mode.
INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
SELECT p.id, 'office', true, true
FROM public.profiles p
WHERE p.role = 'admin'
ON CONFLICT (user_id, module) DO UPDATE
SET can_view = true, can_edit = true;

-- Office mode needs read access to the week's events, clients, crew and shifts.
-- Re-created with the office clause added; all existing conditions preserved.
DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  public.is_admin()
  OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
  OR (public.has_permission('equipment','view') AND public.app_role() = 'warehouse')
  OR (public.has_permission('calendar','view')
      AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
  OR (public.has_permission('clients','view')
      AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
  OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
  OR public.has_permission('quotes','view')
  OR public.has_permission('quotes','edit')
  OR public.has_permission('office','view')
);

DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.has_permission('clients','view')
  OR public.has_permission('calendar','view')
  OR public.has_permission('finance','view')
  OR public.has_permission('crew','view')
  OR public.has_permission('equipment','view')
  OR public.has_permission('quotes','view')
  OR public.has_permission('quotes','edit')
  OR public.has_permission('office','view')
);

DROP POLICY IF EXISTS crew_members_read ON public.crew_members;
CREATE POLICY crew_members_read ON public.crew_members FOR SELECT TO authenticated USING (
  public.has_permission('crew','view')
  OR public.has_permission('office','view')
);

DROP POLICY IF EXISTS shifts_read ON public.shifts;
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated USING (
  public.has_permission('office','view')
  OR (
    public.has_permission('crew','view') AND (
      public.app_role() = ANY (ARRAY['admin','accounting','warehouse'])
      OR (public.app_role() = 'sales' AND public.sales_owns_event(event_id))
      OR (public.app_role() = 'crew' AND crew_member_id IN (
        SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id()
      ))
    )
  )
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
WITH CHECK (public.has_permission('crew','edit') OR public.has_permission('office','edit'));

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 23. Event crew sheet times ─────────────────────────────────────────────
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS warehouse_time time;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS ready_time time;
COMMENT ON COLUMN public.events.warehouse_time IS 'warehouse arrival time';
COMMENT ON COLUMN public.events.ready_time IS 'event ready time';
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- Crew sheet data for crew/calendar/clients viewers without quotes permission.
-- SECURITY DEFINER so it can read the linked quote items without widening the
-- quote_items RLS (which carries prices). Returns operational data only.
CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    public.is_admin()
    OR public.has_permission('calendar','view')
    OR public.has_permission('crew','view')
    OR public.has_permission('clients','view')
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT q.id INTO v_quote
  FROM public.quotes q
  WHERE q.event_id = p_event
  ORDER BY (q.status = 'approved') DESC, q.created_at DESC
  LIMIT 1;

  IF v_quote IS NULL THEN
    v_items := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_name', s.name,
      'description', COALESCE(NULLIF(i.description, ''), i.name),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM public.shifts sh
  JOIN public.crew_members c ON c.id = sh.crew_member_id
  WHERE sh.event_id = p_event;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;

GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 24. Backup module ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.backups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','auto')),
  created_by       uuid,
  created_by_email text,
  counts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows       integer NOT NULL DEFAULT 0,
  size_bytes       integer NOT NULL DEFAULT 0,
  payload          jsonb NOT NULL,
  note             text
);
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;
GRANT INSERT, DELETE ON public.backups TO authenticated;
REVOKE SELECT ON public.backups FROM authenticated;
GRANT SELECT (
  id, created_at, kind, created_by, created_by_email, counts, total_rows,
  size_bytes, note, drive_status, drive_url, drive_file_id, drive_error, drive_sent_at
) ON public.backups TO authenticated;

DROP POLICY IF EXISTS backups_read ON public.backups;
CREATE POLICY backups_read ON public.backups FOR SELECT TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS backups_insert ON public.backups;
CREATE POLICY backups_insert ON public.backups FOR INSERT TO authenticated
WITH CHECK (public.is_admin() OR public.has_permission('backup','edit'));

DROP POLICY IF EXISTS backups_delete ON public.backups;
CREATE POLICY backups_delete ON public.backups FOR DELETE TO authenticated
USING (public.is_admin());

CREATE INDEX IF NOT EXISTS backups_created_at_idx ON public.backups (created_at DESC);

DO $block$
BEGIN
  ALTER TABLE public.user_permissions DROP CONSTRAINT IF EXISTS user_permissions_module_check;
  ALTER TABLE public.user_permissions ADD CONSTRAINT user_permissions_module_check
    CHECK (module IN ('calendar','clients','finance','crew','equipment','users','attendance','quotes','office','backup'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;

INSERT INTO public.user_permissions (user_id, module, can_view, can_edit)
SELECT p.id, 'backup', true, true
FROM public.profiles p
WHERE p.role = 'admin'
ON CONFLICT (user_id, module) DO UPDATE
SET can_view = true, can_edit = true;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 25. Google Drive backup delivery ───────────────────────────────────────
ALTER TABLE public.backups ADD COLUMN IF NOT EXISTS drive_status text;
ALTER TABLE public.backups ADD COLUMN IF NOT EXISTS drive_url text;
ALTER TABLE public.backups ADD COLUMN IF NOT EXISTS drive_file_id text;
ALTER TABLE public.backups ADD COLUMN IF NOT EXISTS drive_error text;
ALTER TABLE public.backups ADD COLUMN IF NOT EXISTS drive_sent_at timestamptz;

ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS backup_drive_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS backup_drive_url text;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS backup_drive_token text;
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS backup_drive_folder text;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 26. Crew documents (ID card / driver license / heights license) ────────
CREATE TABLE IF NOT EXISTS public.crew_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_member_id uuid NOT NULL REFERENCES public.crew_members(id) ON DELETE CASCADE,
  doc_type       text NOT NULL CHECK (doc_type IN ('id_card','driver_license','height_license')),
  file_url       text NOT NULL,
  file_name      text,
  mime           text,
  size           bigint,
  expiry_date    date,
  uploaded_by    uuid,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (crew_member_id, doc_type)
);
CREATE INDEX IF NOT EXISTS crew_documents_member_idx ON public.crew_documents (crew_member_id);

ALTER TABLE public.crew_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crew_documents TO authenticated;
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.crew_documents TO site_server;
  END IF;
END $block$;

DROP POLICY IF EXISTS crew_documents_read ON public.crew_documents;
CREATE POLICY crew_documents_read ON public.crew_documents FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.crew_members cm
    WHERE cm.id = crew_documents.crew_member_id AND cm.user_id::text = auth.user_id()
  )
);

DROP POLICY IF EXISTS crew_documents_write ON public.crew_documents;
CREATE POLICY crew_documents_write ON public.crew_documents FOR ALL TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.crew_members cm
    WHERE cm.id = crew_documents.crew_member_id AND cm.user_id::text = auth.user_id()
  )
)
WITH CHECK (
  public.is_admin()
  OR EXISTS (
    SELECT 1 FROM public.crew_members cm
    WHERE cm.id = crew_documents.crew_member_id AND cm.user_id::text = auth.user_id()
  )
);

-- Additive: a crew member can read their own crew_members row (needed for the
-- self-service documents screen). Existing policies are untouched.
DROP POLICY IF EXISTS crew_members_self_read ON public.crew_members;
CREATE POLICY crew_members_self_read ON public.crew_members FOR SELECT TO authenticated
USING (user_id::text = auth.user_id());

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 27. Invite delivery + crew linking ─────────────────────────────────────
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS last_send_error text;
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.crew_members ADD COLUMN IF NOT EXISTS email text;
CREATE INDEX IF NOT EXISTS crew_members_email_idx ON public.crew_members (lower(email));

-- Link existing profiles to crew_members where they obviously match.
WITH matches AS (
  SELECT DISTINCT ON (p.id)
    cm.id AS crew_id,
    p.id AS profile_id
  FROM public.crew_members cm
  JOIN public.profiles p ON (
    (cm.email IS NOT NULL AND lower(cm.email) = lower(p.email))
    OR (cm.phone IS NOT NULL AND p.phone IS NOT NULL AND cm.phone = p.phone)
    OR (cm.full_name = p.full_name)
  )
  WHERE cm.user_id IS NULL
  ORDER BY p.id,
    (cm.email IS NOT NULL AND lower(cm.email) = lower(p.email)) DESC,
    (cm.phone IS NOT NULL AND p.phone IS NOT NULL AND cm.phone = p.phone) DESC
)
UPDATE public.crew_members cm
SET user_id = matches.profile_id
FROM matches
WHERE cm.id = matches.crew_id;

-- Every active profile not yet linked gets a crew_members row.
INSERT INTO public.crew_members (full_name, phone, role_title, hourly_rate, is_active, user_id, email)
SELECT p.full_name, p.phone,
  CASE p.role
    WHEN 'admin' THEN 'מנהל'
    WHEN 'sales' THEN 'מכירות'
    WHEN 'accounting' THEN 'הנהלת חשבונות'
    WHEN 'warehouse' THEN 'מחסן'
    ELSE 'טכנאי'
  END,
  p.hourly_rate, true, p.id, p.email
FROM public.profiles p
WHERE p.is_active
  AND NOT EXISTS (SELECT 1 FROM public.crew_members cm WHERE cm.user_id = p.id);

-- New profiles (signup / invite acceptance) are linked or added automatically.
CREATE OR REPLACE FUNCTION public.link_profile_to_crew() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  matched_id uuid;
BEGIN
  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;
  SELECT id INTO matched_id
  FROM public.crew_members
  WHERE user_id IS NULL
    AND (
      (email IS NOT NULL AND lower(email) = lower(NEW.email))
      OR (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone)
      OR (full_name = NEW.full_name)
    )
  ORDER BY
    (email IS NOT NULL AND lower(email) = lower(NEW.email)) DESC,
    (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone) DESC
  LIMIT 1;

  IF matched_id IS NOT NULL THEN
    UPDATE public.crew_members
    SET user_id = NEW.id,
        email = COALESCE(email, NEW.email),
        phone = COALESCE(phone, NEW.phone)
    WHERE id = matched_id;
  ELSE
    INSERT INTO public.crew_members (full_name, phone, role_title, hourly_rate, is_active, user_id, email)
    VALUES (
      NEW.full_name, NEW.phone,
      CASE NEW.role
        WHEN 'admin' THEN 'מנהל'
        WHEN 'sales' THEN 'מכירות'
        WHEN 'accounting' THEN 'הנהלת חשבונות'
        WHEN 'warehouse' THEN 'מחסן'
        ELSE 'טכנאי'
      END,
      NEW.hourly_rate, COALESCE(NEW.is_active, true), NEW.id, NEW.email
    );
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS profiles_link_crew ON public.profiles;
CREATE TRIGGER profiles_link_crew
AFTER INSERT OR UPDATE OF approval_status ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.link_profile_to_crew();

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 28. Admin approval gate for new registrations ──────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending';
DO $block$
BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_approval_status_chk
    CHECK (approval_status IN ('pending','approved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $block$;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_by uuid;

-- One-time backfill: every pre-existing profile becomes approved.
DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE approval_status = 'approved') THEN
    UPDATE public.profiles
    SET approval_status = 'approved', approved_at = now()
    WHERE approval_status = 'pending' AND created_at < now();
  END IF;
END $block$;

-- The owner is always approved.
UPDATE public.profiles
SET approval_status = 'approved', approved_at = COALESCE(approved_at, now())
WHERE lower(email) = 'a0525092333@gmail.com';

CREATE OR REPLACE FUNCTION public.is_approved() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id::text = auth.user_id()
      AND p.approval_status = 'approved'
      AND coalesce(p.is_active, true) = true
  );
END $fn$;

GRANT EXECUTE ON FUNCTION public.is_approved() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_permission(p_module text, p_action text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_approved() THEN RETURN false; END IF;
  IF public.is_admin() THEN RETURN true; END IF;
  IF p_action = 'edit' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_edit
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_view
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;

CREATE OR REPLACE FUNCTION public.app_role() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE r text;
BEGIN
  IF public.is_admin() THEN RETURN 'admin'; END IF;
  IF NOT public.is_approved() THEN RETURN 'pending'; END IF;
  SELECT p.role INTO r FROM public.profiles p WHERE p.id::text = auth.user_id();
  RETURN COALESCE(r, 'none');
END $fn$;

CREATE OR REPLACE FUNCTION public.profiles_guard_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  uid text := auth.user_id();
  invite_row public.invites%ROWTYPE;
BEGIN
  IF uid IS NULL THEN RETURN NEW; END IF;
  IF public.is_admin() THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    -- The business owner is always approved so they can never be locked out.
    IF lower(NEW.email) = 'a0525092333@gmail.com' THEN
      NEW.is_active := true;
      NEW.hourly_rate := NULL;
      NEW.approval_status := 'approved';
      NEW.approved_at := COALESCE(NEW.approved_at, now());
      RETURN NEW;
    END IF;

    SELECT * INTO invite_row
    FROM public.invites
    WHERE lower(email) = lower(NEW.email) AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN
      NEW.role := CASE WHEN invite_row.role IN ('admin','sales','accounting','crew','warehouse')
        THEN invite_row.role ELSE 'sales' END;
      NEW.is_active := true;
      NEW.hourly_rate := NULL;
      NEW.approval_status := 'approved';
      NEW.approved_at := now();
      NEW.approved_by := invite_row.invited_by;
    ELSE
      NEW.role := 'sales';
      NEW.is_active := true;
      NEW.hourly_rate := NULL;
      NEW.approval_status := 'pending';
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
  ELSE
    IF current_setting('app.claim_invite', true) = 'on' THEN
      RETURN NEW;
    END IF;
    NEW.role := OLD.role;
    NEW.is_active := OLD.is_active;
    NEW.hourly_rate := OLD.hourly_rate;
    NEW.approval_status := OLD.approval_status;
    NEW.approved_at := OLD.approved_at;
    NEW.approved_by := OLD.approved_by;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS profiles_guard_approval ON public.profiles;
CREATE TRIGGER profiles_guard_approval
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_approval();

GRANT EXECUTE ON FUNCTION public.profiles_guard_approval() TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_profile_to_crew() TO authenticated;

-- ── 28b. Approval gate: harden self-ownership policies ─────────────────────
DROP POLICY IF EXISTS meetings_read ON public.meetings;
CREATE POLICY meetings_read ON public.meetings FOR SELECT TO authenticated USING (
  public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id())
);

DROP POLICY IF EXISTS meetings_edit ON public.meetings;
CREATE POLICY meetings_edit ON public.meetings FOR ALL TO authenticated
USING (
  public.is_admin()
  OR (public.is_approved() AND public.has_permission('calendar','edit') AND user_id::text = auth.user_id())
)
WITH CHECK (
  public.is_admin()
  OR (public.is_approved() AND public.has_permission('calendar','edit') AND user_id::text = auth.user_id())
);

DROP POLICY IF EXISTS time_entries_read ON public.time_entries;
CREATE POLICY time_entries_read ON public.time_entries FOR SELECT TO authenticated
USING (
  (public.is_approved() AND user_id::text = auth.user_id())
  OR public.is_admin()
  OR public.has_permission('attendance','view')
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS time_entries_insert ON public.time_entries;
CREATE POLICY time_entries_insert ON public.time_entries FOR INSERT TO authenticated
WITH CHECK (
  (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS time_entries_update ON public.time_entries;
CREATE POLICY time_entries_update ON public.time_entries FOR UPDATE TO authenticated
USING (
  (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
)
WITH CHECK (
  (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS time_entries_delete ON public.time_entries;
CREATE POLICY time_entries_delete ON public.time_entries FOR DELETE TO authenticated
USING (
  (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved')
  OR public.is_admin()
);

REVOKE SELECT ON public.company_settings FROM authenticated;
GRANT SELECT (
  id, company_name, logo_url, tax_id, address, phone, email,
  default_vat_rate, default_terms, default_terms_text, default_notes,
  quote_number_prefix, paperless_environment, paperless_base_url,
  paperless_auth_style, paperless_document_path,
  backup_drive_enabled, backup_drive_url, backup_drive_folder, updated_at
) ON public.company_settings TO authenticated;

-- ── 29. Multi-day events: per-day schedule + per-day crew ──────────────────
CREATE TABLE IF NOT EXISTS public.event_days (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  day_date       date NOT NULL,
  warehouse_time time,
  ready_time     time,
  start_time     time,
  end_time       time,
  notes          text,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, day_date)
);
CREATE INDEX IF NOT EXISTS event_days_event_idx ON public.event_days (event_id, day_date);

CREATE TABLE IF NOT EXISTS public.event_day_crew (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_day_id   uuid NOT NULL REFERENCES public.event_days(id) ON DELETE CASCADE,
  crew_member_id uuid NOT NULL REFERENCES public.crew_members(id) ON DELETE CASCADE,
  role_text      text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_day_id, crew_member_id)
);
CREATE INDEX IF NOT EXISTS event_day_crew_day_idx ON public.event_day_crew (event_day_id);

ALTER TABLE public.event_days ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_days TO authenticated;
ALTER TABLE public.event_day_crew ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_day_crew TO authenticated;
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_days TO site_server;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_day_crew TO site_server;
  END IF;
END $block$;

DROP TRIGGER IF EXISTS event_days_touch ON public.event_days;
CREATE TRIGGER event_days_touch BEFORE UPDATE ON public.event_days
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.can_access_event(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_owns boolean := false;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event AND e.sales_rep_id::text = auth.user_id()
  ) INTO v_owns;
  IF public.has_permission('finance','view') AND public.app_role() = 'accounting' THEN RETURN true; END IF;
  IF public.has_permission('equipment','view') AND public.app_role() = 'warehouse' THEN RETURN true; END IF;
  IF public.has_permission('calendar','view') AND (public.app_role() <> 'sales' OR v_owns) THEN RETURN true; END IF;
  IF public.has_permission('clients','view') AND (public.app_role() <> 'sales' OR v_owns) THEN RETURN true; END IF;
  IF public.has_permission('crew','view') AND public.is_crew_on_event(p_event) THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) OR EXISTS (
    SELECT 1 FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE d.event_id = p_event AND cm.user_id::text = auth.user_id()
  );
END $fn$;
GRANT EXECUTE ON FUNCTION public.can_access_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_access_event_day(p_day uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_event uuid;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  SELECT event_id INTO v_event FROM public.event_days WHERE id = p_day;
  IF v_event IS NULL THEN RETURN false; END IF;
  RETURN public.can_access_event(v_event);
END $fn$;
GRANT EXECUTE ON FUNCTION public.can_access_event_day(uuid) TO authenticated;

DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated
USING (public.can_access_event(event_id));

DROP POLICY IF EXISTS event_days_write ON public.event_days;
CREATE POLICY event_days_write ON public.event_days FOR ALL TO authenticated
USING (
  public.is_admin()
  OR public.has_permission('calendar','edit')
  OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
)
WITH CHECK (
  public.is_admin()
  OR public.has_permission('calendar','edit')
  OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
);

DROP POLICY IF EXISTS event_day_crew_read ON public.event_day_crew;
CREATE POLICY event_day_crew_read ON public.event_day_crew FOR SELECT TO authenticated
USING (public.can_access_event_day(event_day_id));

DROP POLICY IF EXISTS event_day_crew_write ON public.event_day_crew;
CREATE POLICY event_day_crew_write ON public.event_day_crew FOR ALL TO authenticated
USING (
  public.is_admin()
  OR public.has_permission('calendar','edit')
  OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
)
WITH CHECK (
  public.is_admin()
  OR public.has_permission('calendar','edit')
  OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
);

CREATE OR REPLACE FUNCTION public.save_event_with_days(
  p_event jsonb,
  p_days jsonb,
  p_remove_day_ids uuid[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_event_id uuid;
  v_day jsonb;
  v_day_id uuid;
  v_crew jsonb;
BEGIN
  IF NOT (public.is_admin() OR public.has_permission('calendar','edit')) THEN
    RAISE EXCEPTION 'אין הרשאה לשמור אירוע' USING ERRCODE = '42501';
  END IF;

  v_event_id := NULLIF(p_event->>'id','')::uuid;
  IF v_event_id IS NULL THEN
    INSERT INTO public.events (
      title, client_id, event_type, event_date, start_date, end_date, start_time, end_time,
      warehouse_time, ready_time, venue, address, guest_count, status,
      sales_rep_id, sales_rep_name, total_amount, notes
    ) VALUES (
      p_event->>'title',
      NULLIF(p_event->>'client_id','')::uuid,
      COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      (p_event->>'event_date')::date,
      COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      NULLIF(p_event->>'start_time','')::time,
      NULLIF(p_event->>'end_time','')::time,
      NULLIF(p_event->>'warehouse_time','')::time,
      NULLIF(p_event->>'ready_time','')::time,
      NULLIF(p_event->>'venue',''),
      NULLIF(p_event->>'address',''),
      NULLIF(p_event->>'guest_count','')::int,
      COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      NULLIF(p_event->>'sales_rep_id','')::uuid,
      NULLIF(p_event->>'sales_rep_name',''),
      COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      NULLIF(p_event->>'notes','')
    ) RETURNING id INTO v_event_id;
  ELSE
    UPDATE public.events SET
      title = p_event->>'title',
      client_id = NULLIF(p_event->>'client_id','')::uuid,
      event_type = COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      event_date = (p_event->>'event_date')::date,
      start_date = COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      end_date = COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      start_time = NULLIF(p_event->>'start_time','')::time,
      end_time = NULLIF(p_event->>'end_time','')::time,
      warehouse_time = NULLIF(p_event->>'warehouse_time','')::time,
      ready_time = NULLIF(p_event->>'ready_time','')::time,
      venue = NULLIF(p_event->>'venue',''),
      address = NULLIF(p_event->>'address',''),
      guest_count = NULLIF(p_event->>'guest_count','')::int,
      status = COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      sales_rep_id = NULLIF(p_event->>'sales_rep_id','')::uuid,
      sales_rep_name = NULLIF(p_event->>'sales_rep_name',''),
      total_amount = COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      notes = NULLIF(p_event->>'notes','')
    WHERE id = v_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'האירוע לא נמצא' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_remove_day_ids IS NOT NULL AND array_length(p_remove_day_ids, 1) > 0 THEN
    DELETE FROM public.event_days
    WHERE id = ANY(p_remove_day_ids) AND event_id = v_event_id;
  END IF;

  FOR v_day IN SELECT * FROM jsonb_array_elements(COALESCE(p_days, '[]'::jsonb))
  LOOP
    INSERT INTO public.event_days (
      event_id, day_date, warehouse_time, ready_time, start_time, end_time, notes, sort_order
    ) VALUES (
      v_event_id,
      (v_day->>'day_date')::date,
      NULLIF(v_day->>'warehouse_time','')::time,
      NULLIF(v_day->>'ready_time','')::time,
      NULLIF(v_day->>'start_time','')::time,
      NULLIF(v_day->>'end_time','')::time,
      NULLIF(v_day->>'notes',''),
      COALESCE(NULLIF(v_day->>'sort_order','')::int, 0)
    )
    ON CONFLICT (event_id, day_date) DO UPDATE SET
      warehouse_time = EXCLUDED.warehouse_time,
      ready_time = EXCLUDED.ready_time,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      notes = EXCLUDED.notes,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING id INTO v_day_id;

    DELETE FROM public.event_day_crew WHERE event_day_id = v_day_id;
    FOR v_crew IN SELECT * FROM jsonb_array_elements(COALESCE(v_day->'crew', '[]'::jsonb))
    LOOP
      INSERT INTO public.event_day_crew (event_day_id, crew_member_id, role_text, notes)
      VALUES (
        v_day_id,
        (v_crew->>'crew_member_id')::uuid,
        NULLIF(v_crew->>'role_text',''),
        NULLIF(v_crew->>'notes','')
      )
      ON CONFLICT (event_day_id, crew_member_id) DO UPDATE SET
        role_text = EXCLUDED.role_text,
        notes = EXCLUDED.notes;
    END LOOP;
  END LOOP;

  RETURN v_event_id;
END $fn$;
GRANT EXECUTE ON FUNCTION public.save_event_with_days(jsonb, jsonb, uuid[]) TO authenticated;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── 30. Event date range (calendar visibility for multi-day events) ────────
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS end_date date;

-- Derive the span from event_days (min..max), falling back to event_date.
-- Only NULL columns are filled, so re-running never overwrites user data.
UPDATE public.events e
SET
  start_date = COALESCE(
    e.start_date,
    LEAST(COALESCE(d.min_day, e.event_date), e.event_date)
  ),
  end_date = COALESCE(
    e.end_date,
    GREATEST(
      COALESCE(d.max_day, e.event_date),
      e.event_date,
      COALESCE(e.start_date, LEAST(COALESCE(d.min_day, e.event_date), e.event_date))
    )
  )
FROM (
  SELECT event_id, MIN(day_date) AS min_day, MAX(day_date) AS max_day
  FROM public.event_days
  GROUP BY event_id
) d
WHERE d.event_id = e.id
  AND (e.start_date IS NULL OR e.end_date IS NULL);

-- Events without event_days rows: fall back to event_date.
UPDATE public.events
SET
  start_date = COALESCE(start_date, event_date),
  end_date = COALESCE(end_date, GREATEST(event_date, COALESCE(start_date, event_date)))
WHERE start_date IS NULL OR end_date IS NULL;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Hour reports are private per user.
-- Employees see and change ONLY their own time_entries / time_entry_additions.
-- Only the admin may read/approve other people's reports.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.owns_time_entry(p_entry uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  IF NOT public.is_approved() THEN RETURN false; END IF;
  IF p_write THEN
    SELECT EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = p_entry
        AND te.user_id::text = auth.user_id()
        AND te.status <> 'approved'
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = p_entry
        AND te.user_id::text = auth.user_id()
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.owns_time_entry(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS time_entries_read ON public.time_entries;
CREATE POLICY time_entries_read ON public.time_entries FOR SELECT TO authenticated
USING (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id()));

DROP POLICY IF EXISTS time_entries_insert ON public.time_entries;
CREATE POLICY time_entries_insert ON public.time_entries FOR INSERT TO authenticated
WITH CHECK (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'));

DROP POLICY IF EXISTS time_entries_update ON public.time_entries;
CREATE POLICY time_entries_update ON public.time_entries FOR UPDATE TO authenticated
USING (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'))
WITH CHECK (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'));

DROP POLICY IF EXISTS time_entries_delete ON public.time_entries;
CREATE POLICY time_entries_delete ON public.time_entries FOR DELETE TO authenticated
USING (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'));

-- Non-admins cannot move a report to another user or approve it.
CREATE OR REPLACE FUNCTION public.guard_time_entry_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- Server/service connections (backup restore) have no JWT; let them through.
  IF auth.user_id() IS NULL THEN RETURN NEW; END IF;
  IF public.is_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' THEN
      RAISE EXCEPTION 'אישור דיווח שעות מותר למנהל בלבד' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'אין הרשאה לשנות את בעל דיווח השעות' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    RAISE EXCEPTION 'אישור דיווח שעות מותר למנהל בלבד' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'approved' AND NEW.status <> 'approved' THEN
    RAISE EXCEPTION 'אין הרשאה לשנות דיווח שעות מאושר' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS time_entries_guard_ownership ON public.time_entries;
CREATE TRIGGER time_entries_guard_ownership
BEFORE INSERT OR UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_time_entry_ownership();

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Self-scope data isolation for non-privileged roles.
-- Privileged = admin / sales / accounting (behaviour unchanged).
-- Restricted (crew, warehouse, future roles) see only their own assignments.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_full_scope() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN public.is_admin() OR public.app_role() IN ('admin','sales','accounting');
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_full_scope() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_assigned_to_event(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event AND e.sales_rep_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE d.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_see_client(p_client uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF public.is_full_scope() THEN RETURN TRUE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.client_id = p_client AND public.is_assigned_to_event(e.id)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.can_see_client(uuid) TO authenticated;

-- ── events ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
      OR (public.has_permission('calendar','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('clients','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
      OR public.has_permission('quotes','view')
      OR public.has_permission('quotes','edit')
      OR public.has_permission('office','view')
    )
  )
  OR public.is_assigned_to_event(id)
);

DROP POLICY IF EXISTS events_edit ON public.events;
CREATE POLICY events_edit ON public.events FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
)
WITH CHECK (
  public.is_full_scope()
  AND public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
);

-- ── clients ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.can_see_client(id)
);

DROP POLICY IF EXISTS clients_edit ON public.clients;
CREATE POLICY clients_edit ON public.clients FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('clients','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('clients','edit'));

-- ── crew members ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS crew_members_read ON public.crew_members;
CREATE POLICY crew_members_read ON public.crew_members FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (public.has_permission('crew','view') OR public.has_permission('office','view'))
  )
  OR user_id::text = auth.user_id()
);

DROP POLICY IF EXISTS crew_members_edit ON public.crew_members;
CREATE POLICY crew_members_edit ON public.crew_members FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('crew','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('crew','edit'));

-- ── shifts ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS shifts_read ON public.shifts;
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (public.has_permission('office','view') OR public.has_permission('crew','view'))
  )
  OR crew_member_id IN (
    SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id()
  )
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
)
WITH CHECK (
  public.is_full_scope()
  AND (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
);

-- ── event days / day crew ──────────────────────────────────────────────────
DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event(event_id))
  OR public.is_assigned_to_event(event_id)
);

DROP POLICY IF EXISTS event_days_write ON public.event_days;
CREATE POLICY event_days_write ON public.event_days FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
  )
)
WITH CHECK (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
  )
);

DROP POLICY IF EXISTS event_day_crew_read ON public.event_day_crew;
CREATE POLICY event_day_crew_read ON public.event_day_crew FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event_day(event_day_id))
  OR EXISTS (
    SELECT 1 FROM public.event_days d
    WHERE d.id = event_day_id AND public.is_assigned_to_event(d.event_id)
  )
);

DROP POLICY IF EXISTS event_day_crew_write ON public.event_day_crew;
CREATE POLICY event_day_crew_write ON public.event_day_crew FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
  )
)
WITH CHECK (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
  )
);

-- ── quotes / proposals (privileged only) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.owns_quote(p_quote uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_full_scope() THEN RETURN FALSE; END IF;
  IF NOT public.is_approved() AND NOT public.is_admin() THEN RETURN FALSE; END IF;
  IF public.is_admin() OR public.has_permission('quotes','edit') THEN RETURN TRUE; END IF;
  IF NOT p_write AND public.has_permission('quotes','view') THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.id = p_quote AND q.created_by::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.owns_quote(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS quotes_read ON public.quotes;
CREATE POLICY quotes_read ON public.quotes FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','view')
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_insert ON public.quotes;
CREATE POLICY quotes_insert ON public.quotes FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_update ON public.quotes;
CREATE POLICY quotes_update ON public.quotes FOR UPDATE TO authenticated
USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
)
WITH CHECK (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_delete ON public.quotes;
CREATE POLICY quotes_delete ON public.quotes FOR DELETE TO authenticated USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
  )
);

-- ── finance / invoices / payments (privileged only) ────────────────────────
DROP POLICY IF EXISTS finance_read ON public.finance_entries;
CREATE POLICY finance_read ON public.finance_entries FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.has_permission('finance','view')
    OR public.has_permission('finance','edit')
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS finance_insert ON public.finance_entries;
CREATE POLICY finance_insert ON public.finance_entries FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    (public.has_permission('finance','edit') AND created_by::text = auth.user_id())
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS finance_update ON public.finance_entries;
CREATE POLICY finance_update ON public.finance_entries FOR UPDATE TO authenticated
USING (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()))
WITH CHECK (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()));

DROP POLICY IF EXISTS finance_delete ON public.finance_entries;
CREATE POLICY finance_delete ON public.finance_entries FOR DELETE TO authenticated
USING (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()));

-- ── price catalog / paperless (privileged only) ────────────────────────────
DROP POLICY IF EXISTS price_catalog_read ON public.price_catalog;
CREATE POLICY price_catalog_read ON public.price_catalog FOR SELECT TO authenticated
USING (public.is_full_scope() AND public.is_approved());

DROP POLICY IF EXISTS paperless_documents_read ON public.paperless_documents;
CREATE POLICY paperless_documents_read ON public.paperless_documents FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.has_permission('quotes','view')
    OR public.has_permission('finance','view')
    OR public.is_admin()
  )
);

-- ── event documents: privileged, or assigned to the event ──────────────────
DROP POLICY IF EXISTS documents_read ON public.documents;
CREATE POLICY documents_read ON public.documents FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR public.has_permission('clients','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
    )
  )
  OR (event_id IS NOT NULL AND public.is_assigned_to_event(event_id))
);

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── equipment: restricted users are read-only ──────────────────────────────
DROP POLICY IF EXISTS equipment_items_edit ON public.equipment_items;
CREATE POLICY equipment_items_edit ON public.equipment_items FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('equipment','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('equipment','edit'));

DROP POLICY IF EXISTS equipment_assignments_edit ON public.equipment_assignments;
CREATE POLICY equipment_assignments_edit ON public.equipment_assignments FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('equipment','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('equipment','edit'));

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ── profiles: restricted users see only their own profile ──────────────────
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR public.has_permission('users','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('clients','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
      OR public.has_permission('attendance','view')
      OR public.has_permission('attendance','edit')
    )
  )
);

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';


-- ── RPC guards for self-scope ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_event_with_days(
  p_event jsonb,
  p_days jsonb,
  p_remove_day_ids uuid[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_event_id uuid;
  v_day jsonb;
  v_day_id uuid;
  v_crew jsonb;
BEGIN
  IF NOT (public.is_full_scope() AND (public.is_admin() OR public.has_permission('calendar','edit'))) THEN
    RAISE EXCEPTION 'אין הרשאה לשמור אירוע' USING ERRCODE = '42501';
  END IF;

  v_event_id := NULLIF(p_event->>'id','')::uuid;
  IF v_event_id IS NULL THEN
    INSERT INTO public.events (
      title, client_id, event_type, event_date, start_date, end_date, start_time, end_time,
      warehouse_time, ready_time, venue, address, guest_count, status,
      sales_rep_id, sales_rep_name, total_amount, notes
    ) VALUES (
      p_event->>'title',
      NULLIF(p_event->>'client_id','')::uuid,
      COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      (p_event->>'event_date')::date,
      COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      NULLIF(p_event->>'start_time','')::time,
      NULLIF(p_event->>'end_time','')::time,
      NULLIF(p_event->>'warehouse_time','')::time,
      NULLIF(p_event->>'ready_time','')::time,
      NULLIF(p_event->>'venue',''),
      NULLIF(p_event->>'address',''),
      NULLIF(p_event->>'guest_count','')::int,
      COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      NULLIF(p_event->>'sales_rep_id','')::uuid,
      NULLIF(p_event->>'sales_rep_name',''),
      COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      NULLIF(p_event->>'notes','')
    ) RETURNING id INTO v_event_id;
  ELSE
    UPDATE public.events SET
      title = p_event->>'title',
      client_id = NULLIF(p_event->>'client_id','')::uuid,
      event_type = COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      event_date = (p_event->>'event_date')::date,
      start_date = COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      end_date = COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      start_time = NULLIF(p_event->>'start_time','')::time,
      end_time = NULLIF(p_event->>'end_time','')::time,
      warehouse_time = NULLIF(p_event->>'warehouse_time','')::time,
      ready_time = NULLIF(p_event->>'ready_time','')::time,
      venue = NULLIF(p_event->>'venue',''),
      address = NULLIF(p_event->>'address',''),
      guest_count = NULLIF(p_event->>'guest_count','')::int,
      status = COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      sales_rep_id = NULLIF(p_event->>'sales_rep_id','')::uuid,
      sales_rep_name = NULLIF(p_event->>'sales_rep_name',''),
      total_amount = COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      notes = NULLIF(p_event->>'notes','')
    WHERE id = v_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'האירוע לא נמצא' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_remove_day_ids IS NOT NULL AND array_length(p_remove_day_ids, 1) > 0 THEN
    DELETE FROM public.event_days
    WHERE id = ANY(p_remove_day_ids) AND event_id = v_event_id;
  END IF;

  FOR v_day IN SELECT * FROM jsonb_array_elements(COALESCE(p_days, '[]'::jsonb))
  LOOP
    INSERT INTO public.event_days (
      event_id, day_date, warehouse_time, ready_time, start_time, end_time, notes, sort_order
    ) VALUES (
      v_event_id,
      (v_day->>'day_date')::date,
      NULLIF(v_day->>'warehouse_time','')::time,
      NULLIF(v_day->>'ready_time','')::time,
      NULLIF(v_day->>'start_time','')::time,
      NULLIF(v_day->>'end_time','')::time,
      NULLIF(v_day->>'notes',''),
      COALESCE(NULLIF(v_day->>'sort_order','')::int, 0)
    )
    ON CONFLICT (event_id, day_date) DO UPDATE SET
      warehouse_time = EXCLUDED.warehouse_time,
      ready_time = EXCLUDED.ready_time,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      notes = EXCLUDED.notes,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING id INTO v_day_id;

    DELETE FROM public.event_day_crew WHERE event_day_id = v_day_id;
    FOR v_crew IN SELECT * FROM jsonb_array_elements(COALESCE(v_day->'crew', '[]'::jsonb))
    LOOP
      INSERT INTO public.event_day_crew (event_day_id, crew_member_id, role_text, notes)
      VALUES (
        v_day_id,
        (v_crew->>'crew_member_id')::uuid,
        NULLIF(v_crew->>'role_text',''),
        NULLIF(v_crew->>'notes','')
      )
      ON CONFLICT (event_day_id, crew_member_id) DO UPDATE SET
        role_text = EXCLUDED.role_text,
        notes = EXCLUDED.notes;
    END LOOP;
  END LOOP;

  RETURN v_event_id;
END $fn$;
GRANT EXECUTE ON FUNCTION public.save_event_with_days(jsonb, jsonb, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    (
      public.is_full_scope()
      AND (
        public.is_admin()
        OR public.has_permission('calendar','view')
        OR public.has_permission('crew','view')
        OR public.has_permission('clients','view')
      )
    )
    OR public.is_assigned_to_event(p_event)
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT q.id INTO v_quote
  FROM public.quotes q
  WHERE q.event_id = p_event
  ORDER BY (q.status = 'approved') DESC, q.created_at DESC
  LIMIT 1;

  IF v_quote IS NULL THEN
    v_items := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_name', s.name,
      'description', COALESCE(NULLIF(i.description, ''), i.name),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM public.shifts sh
  JOIN public.crew_members c ON c.id = sh.crew_member_id
  WHERE sh.event_id = p_event;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;

GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- Per-day crew NAMES for an assigned event (no hourly_rate exposed).
CREATE OR REPLACE FUNCTION public.event_day_crew_names(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v jsonb;
BEGIN
  IF NOT public.can_access_event(p_event) THEN
    RETURN '{}'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_object_agg(d.id::text, x.names), '{}'::jsonb) INTO v
  FROM public.event_days d
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('name', cm.full_name, 'role', dc.role_text)
        ORDER BY cm.full_name
      ),
      '[]'::jsonb
    ) AS names
    FROM public.event_day_crew dc
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE dc.event_day_id = d.id
  ) x ON true
  WHERE d.event_id = p_event;
  RETURN COALESCE(v, '{}'::jsonb);
END $fn$;
GRANT EXECUTE ON FUNCTION public.event_day_crew_names(uuid) TO authenticated;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Time-entry audit flags: manual entry vs clock, and manual hour edits.
-- Additive only; does not touch RLS or the ownership trigger.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'manual'
    CHECK (entry_source IN ('clock','manual'));
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS manually_edited boolean NOT NULL DEFAULT false;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

-- Existing rows have no proof they came from the clock: keep entry_source='manual'
-- and record the owner as the best available creator.
UPDATE public.time_entries SET created_by = user_id WHERE created_by IS NULL;

CREATE OR REPLACE FUNCTION public.track_time_entry_manual_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- Closing an open clock shift is part of the clock flow, not a manual edit.
  IF OLD.entry_source = 'clock'
     AND OLD.manually_edited = false
     AND OLD.end_time IS NULL
     AND NEW.end_time IS NOT NULL
     AND NEW.work_date IS NOT DISTINCT FROM OLD.work_date
     AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
     AND NEW.day_type IS NOT DISTINCT FROM OLD.day_type
     AND NEW.shift_type IS NOT DISTINCT FROM OLD.shift_type
     AND NEW.travel_km IS NOT DISTINCT FROM OLD.travel_km
     AND NEW.travel_amount IS NOT DISTINCT FROM OLD.travel_amount
     AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
  THEN
    RETURN NEW;
  END IF;

  IF NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time
     OR NEW.end_time IS DISTINCT FROM OLD.end_time
     OR NEW.break_minutes IS DISTINCT FROM OLD.break_minutes
     OR NEW.day_type IS DISTINCT FROM OLD.day_type
     OR NEW.shift_type IS DISTINCT FROM OLD.shift_type
     OR NEW.travel_km IS DISTINCT FROM OLD.travel_km
     OR NEW.travel_amount IS DISTINCT FROM OLD.travel_amount
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
  THEN
    NEW.manually_edited := true;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = NULLIF(auth.user_id(), '')::uuid
      ) THEN
        NEW.edited_by := NULLIF(auth.user_id(), '')::uuid;
      ELSE
        NEW.edited_by := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NEW.edited_by := NULL;
    END;
    NEW.edited_at := now();
    NEW.edit_count := COALESCE(OLD.edit_count, 0) + 1;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS time_entries_manual_changes ON public.time_entries;
CREATE TRIGGER time_entries_manual_changes
BEFORE UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.track_time_entry_manual_changes();

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Admin password-reset audit trail (no passwords stored).
-- Additive only; does not touch existing RLS or permission logic.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.password_resets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_email   text,
  method         text NOT NULL DEFAULT 'manual',
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.password_resets TO authenticated;

DROP POLICY IF EXISTS password_resets_read ON public.password_resets;
CREATE POLICY password_resets_read ON public.password_resets FOR SELECT TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS password_resets_insert ON public.password_resets;
CREATE POLICY password_resets_insert ON public.password_resets FOR INSERT TO authenticated
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Quote email delivery state (additive only).
-- ============================================================================

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS last_sent_to text;

-- Deleting an event must never destroy finance history: keep the entry and
-- unfile it (event_id = NULL) instead of cascading the delete.
ALTER TABLE public.finance_entries ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE public.finance_entries DROP CONSTRAINT IF EXISTS finance_entries_event_id_fkey;
ALTER TABLE public.finance_entries ADD CONSTRAINT finance_entries_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 0007 — Neon Auth schema grants for the site server.
--
-- Password reset (admin reset + self-service forgot-password) runs in
-- server/routes.mjs on the `site_server` role and must read the previous
-- credential hash and write the new one in neon_auth.account. The neon_auth
-- schema is owned by the `neon_auth` role with an empty ACL, so site_server
-- currently gets "permission denied for schema neon_auth".
--
-- The migration runner (neondb_owner) is a member of neon_auth, so it can
-- grant these. If it cannot, the block reports and does NOT abort the build.
-- ============================================================================
DO $neon_auth_grants$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'neon_auth') THEN
    RAISE NOTICE 'neon_auth grants skipped: schema neon_auth does not exist yet';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    RAISE NOTICE 'neon_auth grants skipped: role site_server does not exist';
  ELSE
    BEGIN
      GRANT USAGE ON SCHEMA neon_auth TO site_server;

      IF to_regclass('neon_auth."user"') IS NOT NULL THEN
        GRANT SELECT ON neon_auth."user" TO site_server;
      END IF;

      IF to_regclass('neon_auth.account') IS NOT NULL THEN
        GRANT SELECT, UPDATE ON neon_auth.account TO site_server;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'neon_auth' AND c.relkind = 'S'
      ) THEN
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA neon_auth TO site_server;
      END IF;

      RAISE NOTICE 'neon_auth grants applied to site_server';
    EXCEPTION WHEN insufficient_privilege OR invalid_schema_name THEN
      RAISE NOTICE 'neon_auth grants skipped: insufficient_privilege or invalid_schema_name';
    END;
  END IF;
END $neon_auth_grants$;


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
  IF NOT (public.is_super_admin() OR public.has_permission('users','edit')) THEN
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

-- ============================================================================
-- 0009 — Force a password change after a temporary password is issued.
--
-- The admin reset and the self-service "forgot password" flows write a
-- temporary password into neon_auth.account. This flag makes the app route the
-- user to /set-password until they choose a new one.
-- ============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- ============================================================================
-- 0010 — One quote per event + automatic version history.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.quote_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  event_id       uuid,
  version_number integer NOT NULL,
  snapshot       jsonb NOT NULL,
  total          numeric,
  label          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_number)
);

CREATE INDEX IF NOT EXISTS quote_versions_quote_version_idx
  ON public.quote_versions (quote_id, version_number DESC);

ALTER TABLE public.quote_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.quote_versions TO authenticated;

DROP POLICY IF EXISTS quote_versions_read ON public.quote_versions;
CREATE POLICY quote_versions_read ON public.quote_versions FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.is_admin()
    OR public.has_permission('quotes','view')
    OR public.has_permission('quotes','edit')
    OR (public.is_approved() AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_versions.quote_id AND q.created_by::text = auth.user_id()
    ))
  )
);

DROP POLICY IF EXISTS quote_versions_insert ON public.quote_versions;
CREATE POLICY quote_versions_insert ON public.quote_versions FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    public.is_admin()
    OR public.has_permission('quotes','edit')
    OR (public.is_approved() AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_versions.quote_id AND q.created_by::text = auth.user_id()
    ))
  )
);

-- Deduplicate existing quotes before adding the unique index. The oldest quote
-- for each event is preserved as a full snapshot on the surviving (newest) quote.
DO $dedupe$
DECLARE
  dup record;
  survivor uuid;
  old_quote record;
  snapshot jsonb;
  next_version integer;
  merged integer := 0;
BEGIN
  FOR dup IN
    SELECT event_id FROM public.quotes
    WHERE event_id IS NOT NULL
    GROUP BY event_id HAVING count(*) > 1
  LOOP
    SELECT id INTO survivor FROM public.quotes
    WHERE event_id = dup.event_id
    ORDER BY created_at DESC, updated_at DESC, id DESC
    LIMIT 1;
    SELECT COALESCE(max(version_number), 0) + 1 INTO next_version
    FROM public.quote_versions WHERE quote_id = survivor;
    FOR old_quote IN
      SELECT * FROM public.quotes
      WHERE event_id = dup.event_id AND id <> survivor
      ORDER BY created_at ASC, updated_at ASC
    LOOP
      SELECT jsonb_build_object(
        'quote', to_jsonb(old_quote),
        'sections', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sort_order) FROM public.quote_sections s WHERE s.quote_id = old_quote.id), '[]'::jsonb),
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order) FROM public.quote_items i WHERE i.quote_id = old_quote.id), '[]'::jsonb)
      ) INTO snapshot;
      INSERT INTO public.quote_versions (quote_id, event_id, version_number, snapshot, total, label, created_by)
      VALUES (survivor, dup.event_id, next_version, snapshot, old_quote.grand_total, 'הצעה קודמת — נשמרה לפני איחוד לכפילות', old_quote.created_by)
      ON CONFLICT (quote_id, version_number) DO NOTHING;
      DELETE FROM public.quotes WHERE id = old_quote.id;
      next_version := next_version + 1;
      merged := merged + 1;
    END LOOP;
  END LOOP;
  IF merged > 0 THEN
    RAISE NOTICE 'אוחדו % הצעות מחיר כפולות', merged;
  END IF;
END $dedupe$;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_per_event
  ON public.quotes (event_id) WHERE event_id IS NOT NULL;

-- ============================================================================
-- 0011 — Calendar scope by role (warehouse sees all events; crew sees assigned).
-- ============================================================================
DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
      OR (public.has_permission('calendar','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('clients','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
      OR public.has_permission('quotes','view')
      OR public.has_permission('quotes','edit')
      OR public.has_permission('office','view')
    )
  )
  OR public.is_assigned_to_event(id)
  OR public.app_role() = 'warehouse'
);

DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event(event_id))
  OR public.is_assigned_to_event(event_id)
  OR public.app_role() = 'warehouse'
);


-- ── 0012 mirror: event report fixes ───────────────────────────────────────
-- ============================================================================
-- 0012 — Event report fixes.
-- 1) is_assigned_to_event also matches event_day_crew assignments.
-- 2) event_crew_sheet authorizes warehouse + assigned crew and returns the item
--    name and description as SEPARATE fields (never collapses one into the other).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_assigned_to_event(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event AND e.sales_rep_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE d.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    public.is_admin()
    OR public.app_role() = 'warehouse'
    OR public.is_assigned_to_event(p_event)
    OR (
      public.is_full_scope()
      AND (
        public.has_permission('calendar','view')
        OR public.has_permission('crew','view')
        OR public.has_permission('clients','view')
      )
    )
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT q.id INTO v_quote
  FROM public.quotes q
  WHERE q.event_id = p_event
  ORDER BY (q.status = 'approved') DESC, q.created_at DESC
  LIMIT 1;

  IF v_quote IS NULL THEN
    v_items := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_name', s.name,
      'name', i.name,
      'description', NULLIF(i.description, ''),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'unit', i.unit,
      'is_optional', COALESCE(i.is_optional, false),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM (
    SELECT sh.crew_member_id FROM public.shifts sh WHERE sh.event_id = p_event
    UNION
    SELECT dc.crew_member_id
    FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    WHERE d.event_id = p_event
  ) x
  JOIN public.crew_members c ON c.id = x.crew_member_id;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;
GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';


-- 0013 mirror: crew dedupe + role exclusion
-- ============================================================================
-- 0013 — Crew dedupe + role exclusion.
-- Keeps the OLDEST row per normalized name, re-points every shift and
-- event_day_crew assignment to the survivor, deletes the redundant rows, then
-- removes crew rows linked to admin/accounting profiles. Finally adds a unique
-- index on lower(btrim(full_name)) and keeps the profile→crew trigger in sync.
-- Safe to run twice.
-- ============================================================================

DO $dedupe$
DECLARE
  v_before int;
  v_after int;
  v_dupes int := 0;
  v_roles int := 0;
BEGIN
  SELECT count(*) INTO v_before FROM public.crew_members;

  -- 1) Re-point shifts from duplicate rows to the oldest row per normalized name.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  UPDATE public.shifts s
     SET crew_member_id = r.survivor
    FROM ranked r
   WHERE s.crew_member_id = r.id
     AND r.id <> r.survivor;

  -- 1b) Collapse shifts that became duplicates after the re-point.
  DELETE FROM public.shifts s
   USING public.shifts keep
   WHERE s.event_id = keep.event_id
     AND s.crew_member_id = keep.crew_member_id
     AND s.starts_at = keep.starts_at
     AND s.id <> keep.id
     AND (keep.created_at, keep.id) < (s.created_at, s.id);

  -- 2) Drop event_day_crew rows that would collide with the survivor.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  ),
  dupes AS (
    SELECT dc.id
      FROM public.event_day_crew dc
      JOIN ranked r ON r.id = dc.crew_member_id
     WHERE r.id <> r.survivor
       AND EXISTS (
         SELECT 1 FROM public.event_day_crew existing
          WHERE existing.event_day_id = dc.event_day_id
            AND existing.crew_member_id = r.survivor
       )
  )
  DELETE FROM public.event_day_crew dc
   USING dupes d
   WHERE dc.id = d.id;

  -- 2b) Re-point the remaining event_day_crew rows.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  UPDATE public.event_day_crew dc
     SET crew_member_id = r.survivor
    FROM ranked r
   WHERE dc.crew_member_id = r.id
     AND r.id <> r.survivor;

  -- 3) Delete duplicate crew rows (keep the oldest).
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  DELETE FROM public.crew_members c
   USING ranked r
   WHERE c.id = r.id
     AND r.id <> r.survivor;
  GET DIAGNOSTICS v_dupes = ROW_COUNT;

  -- 4) Re-point assignments away from admin/accounting rows to a non-excluded
  --    row with the same normalized name, when one exists.
  WITH excluded AS (
    SELECT c.id, lower(btrim(c.full_name)) AS norm
      FROM public.crew_members c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE p.role IN ('admin','accounting')
  ),
  replacement AS (
    SELECT e.id AS old_id,
           (SELECT c2.id
              FROM public.crew_members c2
              LEFT JOIN public.profiles p2 ON p2.id = c2.user_id
             WHERE lower(btrim(c2.full_name)) = e.norm
               AND (p2.role IS NULL OR p2.role NOT IN ('admin','accounting'))
             ORDER BY c2.created_at ASC, c2.id ASC
             LIMIT 1) AS new_id
      FROM excluded e
  )
  UPDATE public.shifts s
     SET crew_member_id = r.new_id
    FROM replacement r
   WHERE s.crew_member_id = r.old_id
     AND r.new_id IS NOT NULL;

  WITH excluded AS (
    SELECT c.id, lower(btrim(c.full_name)) AS norm
      FROM public.crew_members c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE p.role IN ('admin','accounting')
  ),
  replacement AS (
    SELECT e.id AS old_id,
           (SELECT c2.id
              FROM public.crew_members c2
              LEFT JOIN public.profiles p2 ON p2.id = c2.user_id
             WHERE lower(btrim(c2.full_name)) = e.norm
               AND (p2.role IS NULL OR p2.role NOT IN ('admin','accounting'))
             ORDER BY c2.created_at ASC, c2.id ASC
             LIMIT 1) AS new_id
      FROM excluded e
  )
  UPDATE public.event_day_crew dc
     SET crew_member_id = r.new_id
    FROM replacement r
   WHERE dc.crew_member_id = r.old_id
     AND r.new_id IS NOT NULL;

  -- 5) Remove any assignments still owned by admin/accounting rows (no
  --    same-name replacement existed). These roles must not appear at all.
  DELETE FROM public.shifts s
   USING public.crew_members c, public.profiles p
   WHERE s.crew_member_id = c.id
     AND c.user_id = p.id
     AND p.role IN ('admin','accounting');

  DELETE FROM public.event_day_crew dc
   USING public.crew_members c, public.profiles p
   WHERE dc.crew_member_id = c.id
     AND c.user_id = p.id
     AND p.role IN ('admin','accounting');

  -- 6) Delete the admin/accounting crew rows.
  DELETE FROM public.crew_members c
   USING public.profiles p
   WHERE c.user_id = p.id
     AND p.role IN ('admin','accounting');
  GET DIAGNOSTICS v_roles = ROW_COUNT;

  SELECT count(*) INTO v_after FROM public.crew_members;
  RAISE NOTICE 'crew dedupe: before=%, after=%, duplicates_removed=%, admin_accounting_removed=%',
    v_before, v_after, v_dupes, v_roles;
END $dedupe$;

CREATE UNIQUE INDEX IF NOT EXISTS crew_members_name_unique
  ON public.crew_members (lower(btrim(full_name)));

-- 7) Keep the profile→crew trigger idempotent and role-aware.
CREATE OR REPLACE FUNCTION public.link_profile_to_crew() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  matched_id uuid;
BEGIN
  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;
  IF NEW.role IN ('admin','accounting') THEN RETURN NEW; END IF;

  SELECT id INTO matched_id
  FROM public.crew_members
  WHERE lower(btrim(full_name)) = lower(btrim(NEW.full_name))
     OR (email IS NOT NULL AND lower(email) = lower(NEW.email))
     OR (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone)
  ORDER BY
    (lower(btrim(full_name)) = lower(btrim(NEW.full_name))) DESC,
    (email IS NOT NULL AND lower(email) = lower(NEW.email)) DESC,
    (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone) DESC
  LIMIT 1;

  IF matched_id IS NOT NULL THEN
    UPDATE public.crew_members
    SET user_id = NEW.id,
        email = COALESCE(email, NEW.email),
        phone = COALESCE(phone, NEW.phone)
    WHERE id = matched_id;
  ELSE
    INSERT INTO public.crew_members (full_name, phone, role_title, hourly_rate, is_active, user_id, email)
    VALUES (
      NEW.full_name, NEW.phone,
      CASE NEW.role
        WHEN 'admin' THEN 'מנהל'
        WHEN 'sales' THEN 'מכירות'
        WHEN 'accounting' THEN 'הנהלת חשבונות'
        WHEN 'warehouse' THEN 'מחסן'
        ELSE 'טכנאי'
      END,
      NEW.hourly_rate, COALESCE(NEW.is_active, true), NEW.id, NEW.email
    )
    ON CONFLICT (lower(btrim(full_name))) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          email = COALESCE(crew_members.email, EXCLUDED.email),
          phone = COALESCE(crew_members.phone, EXCLUDED.phone);
  END IF;
  RETURN NEW;
END $fn$;


-- 0014 mirror: search permission module
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
  IF NOT (public.is_super_admin() OR public.has_permission('users','edit')) THEN
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
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';


-- 0015 mirror: dedupe clients by normalized name
-- ============================================================================
-- 0015 — Deduplicate clients by normalized name.
-- Normalization matches the app helper: lowercase, trim, collapse inner
-- whitespace, strip Hebrew niqqud (U+0591–U+05C7).
-- Survivor per group = earliest created_at, tie-break smallest id::text.
-- Coalesces missing detail fields into the survivor, re-points every FK, then
-- deletes the redundant rows and adds a unique index so duplicates cannot
-- return. Idempotent: a second run finds no duplicate groups.
-- ============================================================================

DO $dedupe$
DECLARE
  v_before int;
  v_after int;
  v_groups int := 0;
  v_removed int := 0;
  v_deleted int;
  grp record;
  survivor uuid;
BEGIN
  SELECT count(*) INTO v_before FROM public.clients;

  FOR grp IN
    SELECT lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) AS norm
    FROM public.clients
    GROUP BY lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g'))
    HAVING count(*) > 1
  LOOP
    v_groups := v_groups + 1;

    SELECT id INTO survivor
    FROM public.clients
    WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
    ORDER BY created_at ASC, id::text ASC
    LIMIT 1;

    UPDATE public.clients s
    SET contact_name = COALESCE(NULLIF(btrim(s.contact_name), ''), (
          SELECT NULLIF(btrim(c.contact_name), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.contact_name), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        phone = COALESCE(NULLIF(btrim(s.phone), ''), (
          SELECT NULLIF(btrim(c.phone), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.phone), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        email = COALESCE(NULLIF(btrim(s.email), ''), (
          SELECT NULLIF(btrim(c.email), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.email), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        company = COALESCE(NULLIF(btrim(s.company), ''), (
          SELECT NULLIF(btrim(c.company), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.company), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        address = COALESCE(NULLIF(btrim(s.address), ''), (
          SELECT NULLIF(btrim(c.address), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.address), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        notes = COALESCE(NULLIF(btrim(s.notes), ''), (
          SELECT NULLIF(btrim(c.notes), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.notes), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1))
    WHERE s.id = survivor;

    UPDATE public.events SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    UPDATE public.quotes SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    UPDATE public.paperless_documents SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    DELETE FROM public.clients
    WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
      AND id <> survivor;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_removed := v_removed + v_deleted;
  END LOOP;

  DROP INDEX IF EXISTS public.clients_name_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS clients_name_unique
    ON public.clients (lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')));

  SELECT count(*) INTO v_after FROM public.clients;
  RAISE NOTICE 'clients dedupe: before=%, after=%, duplicate_groups=%, redundant_removed=%',
    v_before, v_after, v_groups, v_removed;
END $dedupe$;


-- 0016 mirror: client extra email + contacts
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

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';


-- 0017 mirror: backfill events.total_amount from quotes.grand_total
-- ============================================================================
-- 0017 — Backfill events.total_amount from the linked quote's grand_total.
-- The events list reads the quote total directly, but other screens read
-- events.total_amount; this keeps them in sync for existing rows. Events
-- without a quote stay at 0. Idempotent.
-- ============================================================================

UPDATE public.events e
SET total_amount = latest.grand_total
FROM (
  SELECT DISTINCT ON (event_id) event_id, grand_total
  FROM public.quotes
  WHERE event_id IS NOT NULL
  ORDER BY event_id, created_at DESC
) latest
WHERE latest.event_id = e.id;


-- 0018 mirror: crew multi-role support + role data repair
-- ============================================================================
-- 0018 — Crew multi-role support + role data repair.
-- Adds `crew_roles text[]` so one crew member can hold several roles at once.
-- `role_title` stays as a compatibility column, kept in sync with
-- `crew_roles[1]` by a BEFORE INSERT/UPDATE trigger. Existing rows are
-- backfilled from their current `role_title`. Two rows that were showing the
-- wrong role are repaired to 'טכנאי'. No CHECK constraints, no indexes.
-- ============================================================================

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS crew_roles text[] NOT NULL DEFAULT '{}';

UPDATE public.crew_members
SET role_title = 'טכנאי',
    crew_roles = ARRAY['טכנאי']
WHERE full_name IN ('אברהם פנחס', 'אלי גולדשטיין')
  AND cardinality(crew_roles) = 0
  AND btrim(role_title) = 'מכירות';

DO $$
DECLARE
  v_before integer;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.crew_members
  WHERE cardinality(crew_roles) > 0;

  UPDATE public.crew_members
  SET crew_roles = ARRAY[role_title]
  WHERE cardinality(crew_roles) = 0
    AND role_title IS NOT NULL
    AND btrim(role_title) <> '';

  SELECT count(*) INTO v_after
  FROM public.crew_members
  WHERE cardinality(crew_roles) > 0;

  RAISE NOTICE '0018 crew_roles backfill: before=% after=%', v_before, v_after;
END $$;

CREATE OR REPLACE FUNCTION public.sync_crew_role_title() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.crew_roles IS NULL THEN
    NEW.crew_roles := '{}';
  END IF;
  IF cardinality(NEW.crew_roles) = 0
     AND NEW.role_title IS NOT NULL
     AND btrim(NEW.role_title) <> '' THEN
    NEW.crew_roles := ARRAY[NEW.role_title];
  END IF;
  IF cardinality(NEW.crew_roles) > 0 THEN
    NEW.role_title := NEW.crew_roles[1];
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS crew_roles_sync ON public.crew_members;
CREATE TRIGGER crew_roles_sync
BEFORE INSERT OR UPDATE ON public.crew_members
FOR EACH ROW EXECUTE FUNCTION public.sync_crew_role_title();

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- 0019 mirror: repair only the known corrupt import of quote 2432.
DO $do$
DECLARE
  v_quote_id uuid; v_event_id uuid; v_client_id uuid; v_sum numeric;
  v_general uuid := gen_random_uuid(); v_barkat uuid := gen_random_uuid(); v_sapir uuid := gen_random_uuid();
BEGIN
  SELECT id, event_id, client_id INTO v_quote_id, v_event_id, v_client_id FROM public.quotes
  WHERE quote_number = '2432' AND grand_total = 77682.00 AND client_name = 'מכון בית יעקב למורות' LIMIT 1;
  IF v_quote_id IS NULL THEN RAISE NOTICE '0019: quote 2432 is not in the corrupt state; skipped'; RETURN; END IF;
  SELECT 9500 + 13000 + 0 + 1600 + 7500 + 15000 + 3200 + 3200 + 1200 + 2500 + 1500 + 1600 + 1200 + 1600 + 800 + 0 INTO v_sum;
  IF v_sum <> 63400 THEN RAISE EXCEPTION '0019: item total assertion failed: %', v_sum; END IF;
  UPDATE public.quotes SET venue = 'מלון רויאל ים המלח', discount_type = 'percent', discount_value = 8,
    discount_amount = 5072, subtotal = 63400, total_before_vat = 58328, vat_rate = 18,
    vat_amount = 10499.04, grand_total = 68827,
    notes = $notes$מוניטור לעמדת קונטרול
4 מוניטורים בשליחות נפרדות
5 מדונות
4 מיק אלחוטי לזמרות ולמרצים
2 מיק למרצות
מיקרופון TB
מיקרופון דינמי
חיבור אינר לזמרת
חיבור לקלידים
חיבור לקלרינט
חיבור ל־2 כינורות
חיבור לחליל צד
באירוע מתקיימים 2 סימפוזיונים, שבכל סימפוזיון 6 אנשים.
הקלטת כל האירוע$notes$
  WHERE id = v_quote_id;
  UPDATE public.events SET venue = 'מלון רויאל ים המלח', address = NULL, total_amount = 68827 WHERE id = v_event_id;
  UPDATE public.clients SET address = 'ירושלים' WHERE id = v_client_id AND address IS NULL;
  DELETE FROM public.quote_items WHERE quote_id = v_quote_id;
  DELETE FROM public.quote_sections WHERE quote_id = v_quote_id;
  INSERT INTO public.quote_sections (id, quote_id, name, sort_order, show_section_totals) VALUES
    (v_general, v_quote_id, 'כללי', 0, true), (v_barkat, v_quote_id, 'אולם ברקת', 1, true), (v_sapir, v_quote_id, 'אולם ספיר', 2, true);
  INSERT INTO public.quote_items (id, quote_id, section_id, sort_order, name, description, qty, quantity, unit, unit_price, line_total, is_optional) VALUES
    (gen_random_uuid(), v_quote_id, v_general, 0, 'במות לפי סקיצה מצורפת', NULL, 1, 1, NULL, 9500, 9500, false),
    (gen_random_uuid(), v_quote_id, v_general, 1, 'מסכי לדים לפי סקיצה מצורפת', NULL, 52, 52, NULL, 250, 13000, false),
    (gen_random_uuid(), v_quote_id, v_general, 2, '2 מחשבים עם VMIX + רישיון; חיבור לכל אופציות המסכים; חיבור למעגל סגור; 2 כבלים SDI לצלם וידאו', NULL, 0, 0, NULL, 0, 0, false),
    (gen_random_uuid(), v_quote_id, v_general, 3, '2 עמודי תאורה עם 4 תומסים לד ו־4 פר לד על כל עמוד (מחירון וואו)', NULL, 1, 1, NULL, 1600, 1600, false),
    (gen_random_uuid(), v_quote_id, v_general, 4, 'מערכת הגברה ליינאריי כולל פרונט פילים ופיזורים כנדרש לכיסוי האולם עבור 700 בנות. (העמדה בקצה של האולם שלא יסתיר המסך עד כמה שניתן). 6 רמקולים + אפקטים, שליטה נפרדת בווליום לפרונט ובק. מפרט מצורף בהערות', NULL, 1, 1, NULL, 7500, 7500, false),
    (gen_random_uuid(), v_quote_id, v_general, 5, 'יום נוסף 50%', NULL, 1, 1, NULL, 15000, 15000, false),
    (gen_random_uuid(), v_quote_id, v_general, 6, 'טכנאי וידאו', NULL, 2, 2, NULL, 1600, 3200, false),
    (gen_random_uuid(), v_quote_id, v_general, 7, 'טכנאי סאונד', NULL, 2, 2, NULL, 1600, 3200, false),
    (gen_random_uuid(), v_quote_id, v_general, 8, 'אפ לייט גב במה וקצת צדדים', NULL, 20, 20, NULL, 60, 1200, false),
    (gen_random_uuid(), v_quote_id, v_barkat, 9, 'הגברה לפי מפרט', NULL, 1, 1, NULL, 2500, 2500, false),
    (gen_random_uuid(), v_quote_id, v_barkat, 10, 'מסך לד 3*2', NULL, 6, 6, NULL, 250, 1500, false),
    (gen_random_uuid(), v_quote_id, v_barkat, 11, 'במה למסך לד גובה 90', NULL, 1, 1, NULL, 1600, 1600, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 12, 'מסך פלאזמה 65 אינץ', NULL, 1, 1, NULL, 1200, 1200, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 13, 'מערכת הגברה קטנה + מיק + מחשב', NULL, 1, 1, NULL, 1600, 1600, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 14, 'תוספת פרומטר לאולם תרשיש', NULL, 1, 1, NULL, 800, 800, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 15, 'מהנדס חסר מחיר מחכה להצעה מחשמלאי של המלון', NULL, 0, 0, NULL, 0, 0, false);
END $do$;
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- 0020 mirror: repair only the known corrupt import of quote 2434.
UPDATE public.clients
SET name = 'סמינר דרכי רחל'
WHERE id = '7695fdf5-78cb-4e44-90f3-e6d2e46333b0' AND name = 'סמי נ ר דרכי רחל';

UPDATE public.quotes
SET client_name = 'סמינר דרכי רחל', venue = NULL
WHERE id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96' AND quote_number = '2434'
  AND venue = 'נייד : 8470175 - 054 חיה';

UPDATE public.events e
SET title = 'סמינר דרכי רחל', venue = NULL,
    event_date = COALESCE(q.event_date, '2026-11-07'),
    start_date = COALESCE(q.event_date, '2026-11-07'),
    end_date = COALESCE(q.event_date, '2026-11-07')
FROM public.quotes q
WHERE e.id = '1f586596-ff5c-4dd1-a33b-8033f7848633' AND e.title = 'סמי נ ר דרכי רחל'
  AND q.id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96' AND q.quote_number = '2434'
  AND e.start_date = q.quote_date;

UPDATE public.quote_items
SET name = 'מסך 2.5*4', description = '(צריך לבדוק את גובה התקרה באולם ולהחליט על גובה הבמה והמסך)'
WHERE quote_id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96' AND sort_order = 0
  AND name = 'מסך 2*4.5'
  AND description = ')צריך לבדוק את גובה התקרה באולם ולהחליט על גובה הבמה והמסך (';

UPDATE public.quote_items
SET name = 'הגברה ל 600 בנות', description = '(מפרט כמצורף בהערה למטה) כולל פיזורים מאחורה'
WHERE quote_id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96' AND sort_order = 1
  AND name = 'הגברה ל600 בנות'
  AND description = ') מפרט כמצורף בהערה למטה ( כולל פיזורים מאחורה';

UPDATE public.quote_items
SET name = 'מפרט הגברה: 3 מיק אלחוטי מיפרו, מיק אלחוטי לשירה, הקלטה, חיבור 3 כלים.', description = NULL
WHERE quote_id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96' AND sort_order = 3
  AND name = 'מפרט הגברה : 3 מיק אלחוטי מיפרו , מיק אלחוטי לשירה , הקלטה ,'
  AND description = 'חיבור 3 כלים.';

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- 0021 mirror: repair only the known corrupt import of quote 2439.
UPDATE public.clients target
SET phone = source.phone
FROM public.clients source
WHERE target.id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
  AND source.id = 'dc3c5c21-06bd-4172-81fd-7897244e350d'
  AND target.phone IS NULL AND source.phone IS NOT NULL;

UPDATE public.quotes
SET client_id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
WHERE quote_number = '2439' AND client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d';

UPDATE public.events
SET client_id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
WHERE id = (SELECT event_id FROM public.quotes WHERE quote_number = '2439')
  AND client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d';

UPDATE public.client_contacts
SET client_id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
WHERE client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d';

DELETE FROM public.clients
WHERE id = 'dc3c5c21-06bd-4172-81fd-7897244e350d' AND name = 'ת נ ועת בתיה'
  AND NOT EXISTS (SELECT 1 FROM public.quotes WHERE client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d')
  AND NOT EXISTS (SELECT 1 FROM public.events WHERE client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d');

UPDATE public.quotes
SET client_name = 'תנועת בתיה', venue = 'בנייני האומה, אולם אשכול'
WHERE quote_number = '2439' AND client_name = 'ת נ ועת בתיה'
  AND venue = 'בנייני האומה אולם אשכול';

UPDATE public.events
SET title = 'תנועת בתיה', venue = 'בנייני האומה, אולם אשכול'
WHERE id = (SELECT event_id FROM public.quotes WHERE quote_number = '2439')
  AND title = 'ת נ ועת בתיה' AND venue = 'בנייני האומה אולם אשכול';

UPDATE public.quote_items
SET name = 'מערכת הגברה ל 240 בנות מיק אלחוטיים כמות? חיבור קלידים מפרט מדויק?', description = NULL
WHERE quote_id = (SELECT id FROM public.quotes WHERE quote_number = '2439')
  AND sort_order = 4
  AND name = 'מערכת הגברה ל 240 בנות מיק אלחוטיים כמות? חיבור קלידים מפרט'
  AND description = 'מדויק?';

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- 0022 mirror: rename the stored event status value ליד → ממתין לסגירה.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'ליד';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status IN ('הצעה','בוטל');
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- 0023 mirror: rename the stored event status value במשוריין → ממתין לסגירה.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'במשוריין';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status IN ('הצעה','בוטל');
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;
DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';

-- 0024 mirror: the per-user permissions matrix is the only module gate.
-- Admin role no longer bypasses the matrix; the owner account keeps full access.

CREATE OR REPLACE FUNCTION public.has_permission(p_module text, p_action text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_approved() THEN RETURN false; END IF;
  IF public.is_super_admin() THEN RETURN true; END IF;
  IF p_action = 'edit' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_edit
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND (up.can_view OR up.can_edit)
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text) TO authenticated;

DROP POLICY IF EXISTS user_permissions_admin_write ON public.user_permissions;
CREATE POLICY user_permissions_admin_write ON public.user_permissions FOR ALL TO authenticated
USING (public.is_super_admin() OR public.has_permission('users','edit'))
WITH CHECK (public.is_super_admin() OR public.has_permission('users','edit'));

DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR (
    public.is_full_scope()
    AND (
      public.is_super_admin()
      OR public.has_permission('users','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('clients','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
      OR public.has_permission('attendance','view')
      OR public.has_permission('attendance','edit')
    )
  )
);

DROP POLICY IF EXISTS profiles_update_self_or_admin ON public.profiles;
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated
USING (
  id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','edit')
  OR public.has_permission('attendance','edit')
)
WITH CHECK (
  id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','edit')
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (
  (public.is_full_scope() AND (public.has_permission('crew','edit') OR public.has_permission('office','edit')))
  OR (public.has_permission('crew','edit') AND public.is_assigned_to_event(event_id))
)
WITH CHECK (
  (public.is_full_scope() AND (public.has_permission('crew','edit') OR public.has_permission('office','edit')))
  OR (public.has_permission('crew','edit') AND public.is_assigned_to_event(event_id))
);

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

-- 0025: optional company registration number / personal ID on clients.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS tax_id text;

-- 0026: truthful Paperless document status + guarded repair of the one unverified row.
ALTER TABLE public.paperless_documents DROP CONSTRAINT IF EXISTS paperless_documents_status_check;
ALTER TABLE public.paperless_documents ADD CONSTRAINT paperless_documents_status_check
  CHECK (status IN ('issued','failed','check','unverified','pending'));

ALTER TABLE public.paperless_documents ALTER COLUMN raw_response TYPE jsonb USING raw_response::jsonb;

UPDATE public.paperless_documents
SET status = 'unverified',
    error_message = 'התקבל אישור מהשרת אך לא הוחזר מספר מסמך או קישור'
WHERE id = '2a11c7cb-5c1b-48a7-a8df-87a1e60b67e3'
  AND status = 'issued'
  AND doc_number IS NULL
  AND doc_url IS NULL
  AND external_id IS NULL;

-- Clear the false "issued" flag on the quote linked to the repaired document row.
UPDATE public.quotes
SET paperless_status = NULL,
    paperless_issued_at = NULL
WHERE id = (
  SELECT quote_id FROM public.paperless_documents
  WHERE id = '2a11c7cb-5c1b-48a7-a8df-87a1e60b67e3'
)
  AND paperless_status IS NOT NULL
  AND paperless_document_number IS NULL
  AND paperless_url IS NULL
  AND paperless_document_id IS NULL;

NOTIFY pgrst, 'reload schema';

-- 0027 mirror: event status set → exactly 4 values:
--   ממתין לסגירה, נסגר, ממתין לתשלום, שולם
-- Maps old values (never deletes events): הצעה→ממתין לסגירה, בוצע→ממתין לתשלום,
-- בוטל→ממתין לסגירה. Idempotent: drop IF EXISTS, updates hit 0 rows on re-run,
-- constraint re-added only when missing.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'הצעה';
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'בוטל';
UPDATE public.events SET status = 'ממתין לסגירה'
  WHERE status IS NULL OR status NOT IN ('ממתין לסגירה','נסגר','ממתין לתשלום','שולם');

ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- 0028 mirror: only the account owner (a0525092333@gmail.com, via is_super_admin())
-- may DELETE events. A RESTRICTIVE policy is AND-ed with every permissive policy
-- (events_edit FOR ALL), so admins / the permissions matrix can no longer delete.
-- INSERT/UPDATE/SELECT are untouched. Idempotent: drop-then-create. No data changes.
DROP POLICY IF EXISTS events_delete_owner_only ON public.events;
CREATE POLICY events_delete_owner_only ON public.events
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_super_admin());

NOTIFY pgrst, 'reload schema';

-- 0029 mirror: lock the owner email on profiles. is_super_admin() falls back to
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

-- 0030 mirror: Paperless → production. One-time fix of the stored settings
-- (environment 'sandbox' → 'production', path '/api/invoices/wordpress/' → no
-- trailing slash, base URL → https://api.paperless.tax). Guarded by a marker row
-- so a later owner choice is never overwritten on re-runs. Idempotent.
CREATE TABLE IF NOT EXISTS public.one_time_fixes (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.one_time_fixes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.company_settings ALTER COLUMN paperless_environment SET DEFAULT 'production';
ALTER TABLE public.company_settings ALTER COLUMN paperless_document_path SET DEFAULT '/api/invoices/wordpress';

WITH marker AS (
  INSERT INTO public.one_time_fixes (key) VALUES ('0030_paperless_production')
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
UPDATE public.company_settings
SET paperless_environment = 'production',
    paperless_document_path = '/api/invoices/wordpress',
    paperless_base_url = 'https://api.paperless.tax'
WHERE id = 1 AND EXISTS (SELECT 1 FROM marker);

NOTIFY pgrst, 'reload schema';

-- 0031 mirror: quote screen redesign — additive only, no data loss.
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

-- 0035 mirror: event accounting access fix (no data changes).
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

-- Browser restrictions must not override the separate trusted-server policy.
-- Browser access still requires every existing accounting view/edit/creator check.
ALTER POLICY event_accounting_view ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_insert ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_update ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_delete ON public.event_accounting_references TO authenticated, anonymous;
NOTIFY pgrst, 'reload schema';

-- Keep these owner-only overrides last in the consolidated migration.
-- Complete existing audit storage without touching existing rows or permissions.
ALTER TABLE public.audit_logs ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.audit_logs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.audit_logs ALTER COLUMN details SET DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.security_actor(p_module text, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE uid text := nullif(auth.user_id()::text, ''); mail text; stored_role text;
  owner_account boolean := false; permitted boolean := false;
BEGIN
  IF uid IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT u.email FROM neon_auth."user" u
        WHERE u.id::text = $1 AND coalesce(u.banned, false) = false' INTO mail USING uid;
    EXCEPTION WHEN undefined_table OR undefined_column THEN mail := NULL;
    END;
    IF mail IS NOT NULL THEN
      owner_account := lower(mail) = 'a0525092333@gmail.com';
      SELECT p.role INTO stored_role FROM public.profiles p WHERE p.id::text = uid;
      IF p_action IN ('view','edit') AND p_module = ANY(public._security_modules()) THEN
        permitted := owner_account OR EXISTS (
          SELECT 1 FROM public.profiles p JOIN public.user_permissions up ON up.user_id = p.id
          WHERE p.id::text = uid AND p.is_active IS TRUE AND p.approval_status = 'approved'
            AND up.module = p_module AND CASE WHEN p_action = 'edit' THEN up.can_edit ELSE up.can_view OR up.can_edit END
        );
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('user_id',uid,'email',mail,'role',stored_role,
    'is_owner',owner_account,'allowed',coalesce(permitted,false));
END $fn$;

CREATE OR REPLACE FUNCTION public._security_owner_ids() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE ids text[];
BEGIN
  EXECUTE 'SELECT coalesce(array_agg(u.id::text), ARRAY[]::text[]) FROM neon_auth."user" u
    WHERE lower(u.email) = ''a0525092333@gmail.com''' INTO ids;
  RETURN ids;
END $fn$;

CREATE OR REPLACE FUNCTION public._security_can_audit() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT coalesce((public.security_actor('users','view')->>'is_owner')::boolean,false);
$fn$;

-- Restrict browser permission administration even if an admin has users.edit.
DROP POLICY IF EXISTS security_permissions_owner_insert ON public.user_permissions;
CREATE POLICY security_permissions_owner_insert ON public.user_permissions AS RESTRICTIVE
  FOR INSERT TO authenticated, anonymous WITH CHECK (public._security_can_audit());
DROP POLICY IF EXISTS security_permissions_owner_update ON public.user_permissions;
CREATE POLICY security_permissions_owner_update ON public.user_permissions AS RESTRICTIVE
  FOR UPDATE TO authenticated, anonymous USING (public._security_can_audit()) WITH CHECK (public._security_can_audit());
DROP POLICY IF EXISTS security_permissions_owner_delete ON public.user_permissions;
CREATE POLICY security_permissions_owner_delete ON public.user_permissions AS RESTRICTIVE
  FOR DELETE TO authenticated, anonymous USING (public._security_can_audit());

CREATE OR REPLACE FUNCTION public._security_guard_access_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- Nested auth/invite synchronization remains a trusted database operation.
  IF pg_trigger_depth() = 1 AND nullif(auth.user_id()::text,'') IS NOT NULL
    AND NOT public._security_can_audit() THEN
    RAISE EXCEPTION 'Owner-only permission administration' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public._security_guard_access_fields() FROM PUBLIC, anonymous, authenticated;
DROP TRIGGER IF EXISTS security_owner_profile_access ON public.profiles;
CREATE TRIGGER security_owner_profile_access BEFORE UPDATE OF role, is_active, approval_status ON public.profiles
  FOR EACH ROW WHEN (ROW(OLD.role,OLD.is_active,OLD.approval_status) IS DISTINCT FROM ROW(NEW.role,NEW.is_active,NEW.approval_status))
  EXECUTE FUNCTION public._security_guard_access_fields();
DO $fn$ BEGIN
  IF to_regclass('public.invites') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS security_owner_invites ON public.invites;
    CREATE TRIGGER security_owner_invites BEFORE INSERT OR UPDATE OR DELETE ON public.invites
      FOR EACH ROW EXECUTE FUNCTION public._security_guard_access_fields();
  END IF;
END $fn$;

DO $fn$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_permissions'::regclass AND conname = 'security_edit_requires_view') THEN
    ALTER TABLE public.user_permissions ADD CONSTRAINT security_edit_requires_view
      CHECK (can_edit IS NOT TRUE OR can_view IS TRUE) NOT VALID;
  END IF;
END $fn$;

ALTER FUNCTION public._security_clean_details(jsonb) SECURITY DEFINER;
DO $fn$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    GRANT EXECUTE ON FUNCTION public._security_clean_details(jsonb) TO site_server;
  END IF;
END $fn$;
NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Hour reports are private per user.
-- Employees see and change ONLY their own time_entries / time_entry_additions.
-- Only the admin may read/approve other people's reports.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.owns_time_entry(p_entry uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  IF NOT public.is_approved() THEN RETURN false; END IF;
  IF p_write THEN
    SELECT EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = p_entry
        AND te.user_id::text = auth.user_id()
        AND te.status <> 'approved'
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.time_entries te
      WHERE te.id = p_entry
        AND te.user_id::text = auth.user_id()
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.owns_time_entry(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS time_entries_read ON public.time_entries;
CREATE POLICY time_entries_read ON public.time_entries FOR SELECT TO authenticated
USING (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id()));

DROP POLICY IF EXISTS time_entries_insert ON public.time_entries;
CREATE POLICY time_entries_insert ON public.time_entries FOR INSERT TO authenticated
WITH CHECK (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'));

DROP POLICY IF EXISTS time_entries_update ON public.time_entries;
CREATE POLICY time_entries_update ON public.time_entries FOR UPDATE TO authenticated
USING (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'))
WITH CHECK (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'));

DROP POLICY IF EXISTS time_entries_delete ON public.time_entries;
CREATE POLICY time_entries_delete ON public.time_entries FOR DELETE TO authenticated
USING (public.is_admin() OR (public.is_approved() AND user_id::text = auth.user_id() AND status <> 'approved'));

-- Non-admins cannot move a report to another user or approve it.
CREATE OR REPLACE FUNCTION public.guard_time_entry_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- Server/service connections (backup restore) have no JWT; let them through.
  IF auth.user_id() IS NULL THEN RETURN NEW; END IF;
  IF public.is_admin() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' THEN
      RAISE EXCEPTION 'אישור דיווח שעות מותר למנהל בלבד' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'אין הרשאה לשנות את בעל דיווח השעות' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    RAISE EXCEPTION 'אישור דיווח שעות מותר למנהל בלבד' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'approved' AND NEW.status <> 'approved' THEN
    RAISE EXCEPTION 'אין הרשאה לשנות דיווח שעות מאושר' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS time_entries_guard_ownership ON public.time_entries;
CREATE TRIGGER time_entries_guard_ownership
BEFORE INSERT OR UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_time_entry_ownership();

NOTIFY pgrst, 'reload schema';

-- Backups contain every user's hour reports: only the admin may read them.
DROP POLICY IF EXISTS backups_read ON public.backups;
CREATE POLICY backups_read ON public.backups FOR SELECT TO authenticated
USING (public.is_admin());

GRANT INSERT, DELETE ON public.backups TO authenticated;
REVOKE SELECT ON public.backups FROM authenticated;
GRANT SELECT (
  id, created_at, kind, created_by, created_by_email, counts, total_rows,
  size_bytes, note, drive_status, drive_url, drive_file_id, drive_error, drive_sent_at
) ON public.backups TO authenticated;

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Self-scope data isolation for non-privileged roles.
-- Privileged = admin / sales / accounting (behaviour unchanged).
-- Restricted (crew, warehouse, future roles) see only their own assignments.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_full_scope() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN public.is_admin() OR public.app_role() IN ('admin','sales','accounting');
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_full_scope() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_assigned_to_event(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event AND e.sales_rep_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE d.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_see_client(p_client uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF public.is_full_scope() THEN RETURN TRUE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.client_id = p_client AND public.is_assigned_to_event(e.id)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.can_see_client(uuid) TO authenticated;

-- ── events ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
      OR (public.has_permission('calendar','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('clients','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
      OR public.has_permission('quotes','view')
      OR public.has_permission('quotes','edit')
      OR public.has_permission('office','view')
    )
  )
  OR public.is_assigned_to_event(id)
);

DROP POLICY IF EXISTS events_edit ON public.events;
CREATE POLICY events_edit ON public.events FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
)
WITH CHECK (
  public.is_full_scope()
  AND public.has_permission('clients','edit')
  AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id())
);

-- ── clients ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.can_see_client(id)
);

DROP POLICY IF EXISTS clients_edit ON public.clients;
CREATE POLICY clients_edit ON public.clients FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('clients','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('clients','edit'));

-- ── crew members ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS crew_members_read ON public.crew_members;
CREATE POLICY crew_members_read ON public.crew_members FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (public.has_permission('crew','view') OR public.has_permission('office','view'))
  )
  OR user_id::text = auth.user_id()
);

DROP POLICY IF EXISTS crew_members_edit ON public.crew_members;
CREATE POLICY crew_members_edit ON public.crew_members FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('crew','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('crew','edit'));

-- ── shifts ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS shifts_read ON public.shifts;
CREATE POLICY shifts_read ON public.shifts FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (public.has_permission('office','view') OR public.has_permission('crew','view'))
  )
  OR crew_member_id IN (
    SELECT id FROM public.crew_members WHERE user_id::text = auth.user_id()
  )
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
)
WITH CHECK (
  public.is_full_scope()
  AND (public.has_permission('crew','edit') OR public.has_permission('office','edit'))
);

-- ── event days / day crew ──────────────────────────────────────────────────
DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event(event_id))
  OR public.is_assigned_to_event(event_id)
);

DROP POLICY IF EXISTS event_days_write ON public.event_days;
CREATE POLICY event_days_write ON public.event_days FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
  )
)
WITH CHECK (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event(event_id))
  )
);

DROP POLICY IF EXISTS event_day_crew_read ON public.event_day_crew;
CREATE POLICY event_day_crew_read ON public.event_day_crew FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event_day(event_day_id))
  OR EXISTS (
    SELECT 1 FROM public.event_days d
    WHERE d.id = event_day_id AND public.is_assigned_to_event(d.event_id)
  )
);

DROP POLICY IF EXISTS event_day_crew_write ON public.event_day_crew;
CREATE POLICY event_day_crew_write ON public.event_day_crew FOR ALL TO authenticated
USING (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
  )
)
WITH CHECK (
  public.is_full_scope()
  AND (
    public.is_admin()
    OR public.has_permission('calendar','edit')
    OR (public.has_permission('crew','edit') AND public.can_access_event_day(event_day_id))
  )
);

-- ── quotes / proposals (privileged only) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.owns_quote(p_quote uuid, p_write boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_full_scope() THEN RETURN FALSE; END IF;
  IF NOT public.is_approved() AND NOT public.is_admin() THEN RETURN FALSE; END IF;
  IF public.is_admin() OR public.has_permission('quotes','edit') THEN RETURN TRUE; END IF;
  IF NOT p_write AND public.has_permission('quotes','view') THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.quotes q
    WHERE q.id = p_quote AND q.created_by::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.owns_quote(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS quotes_read ON public.quotes;
CREATE POLICY quotes_read ON public.quotes FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','view')
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_insert ON public.quotes;
CREATE POLICY quotes_insert ON public.quotes FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_update ON public.quotes;
CREATE POLICY quotes_update ON public.quotes FOR UPDATE TO authenticated
USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
)
WITH CHECK (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
    OR public.has_permission('quotes','edit')
  )
);

DROP POLICY IF EXISTS quotes_delete ON public.quotes;
CREATE POLICY quotes_delete ON public.quotes FOR DELETE TO authenticated USING (
  public.is_full_scope() AND (
    (public.is_approved() AND created_by::text = auth.user_id())
    OR public.is_admin()
  )
);

-- ── finance / invoices / payments (privileged only) ────────────────────────
DROP POLICY IF EXISTS finance_read ON public.finance_entries;
CREATE POLICY finance_read ON public.finance_entries FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.has_permission('finance','view')
    OR public.has_permission('finance','edit')
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS finance_insert ON public.finance_entries;
CREATE POLICY finance_insert ON public.finance_entries FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    (public.has_permission('finance','edit') AND created_by::text = auth.user_id())
    OR public.is_admin()
  )
);

DROP POLICY IF EXISTS finance_update ON public.finance_entries;
CREATE POLICY finance_update ON public.finance_entries FOR UPDATE TO authenticated
USING (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()))
WITH CHECK (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()));

DROP POLICY IF EXISTS finance_delete ON public.finance_entries;
CREATE POLICY finance_delete ON public.finance_entries FOR DELETE TO authenticated
USING (public.is_full_scope() AND (public.has_permission('finance','edit') OR public.is_admin()));

-- ── price catalog / paperless (privileged only) ────────────────────────────
DROP POLICY IF EXISTS price_catalog_read ON public.price_catalog;
CREATE POLICY price_catalog_read ON public.price_catalog FOR SELECT TO authenticated
USING (public.is_full_scope() AND public.is_approved());

DROP POLICY IF EXISTS paperless_documents_read ON public.paperless_documents;
CREATE POLICY paperless_documents_read ON public.paperless_documents FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.has_permission('quotes','view')
    OR public.has_permission('finance','view')
    OR public.is_admin()
  )
);

-- ── event documents: privileged, or assigned to the event ──────────────────
DROP POLICY IF EXISTS documents_read ON public.documents;
CREATE POLICY documents_read ON public.documents FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR public.has_permission('clients','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
    )
  )
  OR (event_id IS NOT NULL AND public.is_assigned_to_event(event_id))
);

NOTIFY pgrst, 'reload schema';

-- ── equipment: restricted users are read-only ──────────────────────────────
DROP POLICY IF EXISTS equipment_items_edit ON public.equipment_items;
CREATE POLICY equipment_items_edit ON public.equipment_items FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('equipment','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('equipment','edit'));

DROP POLICY IF EXISTS equipment_assignments_edit ON public.equipment_assignments;
CREATE POLICY equipment_assignments_edit ON public.equipment_assignments FOR ALL TO authenticated
USING (public.is_full_scope() AND public.has_permission('equipment','edit'))
WITH CHECK (public.is_full_scope() AND public.has_permission('equipment','edit'));

NOTIFY pgrst, 'reload schema';

-- ── profiles: restricted users see only their own profile ──────────────────
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR public.has_permission('users','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('clients','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
      OR public.has_permission('attendance','view')
      OR public.has_permission('attendance','edit')
    )
  )
);

NOTIFY pgrst, 'reload schema';


-- ── RPC guards for self-scope ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_event_with_days(
  p_event jsonb,
  p_days jsonb,
  p_remove_day_ids uuid[] DEFAULT '{}'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_event_id uuid;
  v_day jsonb;
  v_day_id uuid;
  v_crew jsonb;
BEGIN
  IF NOT (public.is_full_scope() AND (public.is_admin() OR public.has_permission('calendar','edit'))) THEN
    RAISE EXCEPTION 'אין הרשאה לשמור אירוע' USING ERRCODE = '42501';
  END IF;

  v_event_id := NULLIF(p_event->>'id','')::uuid;
  IF v_event_id IS NULL THEN
    INSERT INTO public.events (
      title, client_id, event_type, event_date, start_date, end_date, start_time, end_time,
      warehouse_time, ready_time, venue, address, guest_count, status,
      sales_rep_id, sales_rep_name, total_amount, notes
    ) VALUES (
      p_event->>'title',
      NULLIF(p_event->>'client_id','')::uuid,
      COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      (p_event->>'event_date')::date,
      COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      NULLIF(p_event->>'start_time','')::time,
      NULLIF(p_event->>'end_time','')::time,
      NULLIF(p_event->>'warehouse_time','')::time,
      NULLIF(p_event->>'ready_time','')::time,
      NULLIF(p_event->>'venue',''),
      NULLIF(p_event->>'address',''),
      NULLIF(p_event->>'guest_count','')::int,
      COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      NULLIF(p_event->>'sales_rep_id','')::uuid,
      NULLIF(p_event->>'sales_rep_name',''),
      COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      NULLIF(p_event->>'notes','')
    ) RETURNING id INTO v_event_id;
  ELSE
    UPDATE public.events SET
      title = p_event->>'title',
      client_id = NULLIF(p_event->>'client_id','')::uuid,
      event_type = COALESCE(NULLIF(p_event->>'event_type',''),'אחר'),
      event_date = (p_event->>'event_date')::date,
      start_date = COALESCE(NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      end_date = COALESCE(NULLIF(p_event->>'end_date','')::date, NULLIF(p_event->>'start_date','')::date, (p_event->>'event_date')::date),
      start_time = NULLIF(p_event->>'start_time','')::time,
      end_time = NULLIF(p_event->>'end_time','')::time,
      warehouse_time = NULLIF(p_event->>'warehouse_time','')::time,
      ready_time = NULLIF(p_event->>'ready_time','')::time,
      venue = NULLIF(p_event->>'venue',''),
      address = NULLIF(p_event->>'address',''),
      guest_count = NULLIF(p_event->>'guest_count','')::int,
      status = COALESCE(NULLIF(p_event->>'status',''),'ממתין לסגירה'),
      sales_rep_id = NULLIF(p_event->>'sales_rep_id','')::uuid,
      sales_rep_name = NULLIF(p_event->>'sales_rep_name',''),
      total_amount = COALESCE(NULLIF(p_event->>'total_amount','')::numeric, 0),
      notes = NULLIF(p_event->>'notes','')
    WHERE id = v_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'האירוע לא נמצא' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF p_remove_day_ids IS NOT NULL AND array_length(p_remove_day_ids, 1) > 0 THEN
    DELETE FROM public.event_days
    WHERE id = ANY(p_remove_day_ids) AND event_id = v_event_id;
  END IF;

  FOR v_day IN SELECT * FROM jsonb_array_elements(COALESCE(p_days, '[]'::jsonb))
  LOOP
    INSERT INTO public.event_days (
      event_id, day_date, warehouse_time, ready_time, start_time, end_time, notes, sort_order
    ) VALUES (
      v_event_id,
      (v_day->>'day_date')::date,
      NULLIF(v_day->>'warehouse_time','')::time,
      NULLIF(v_day->>'ready_time','')::time,
      NULLIF(v_day->>'start_time','')::time,
      NULLIF(v_day->>'end_time','')::time,
      NULLIF(v_day->>'notes',''),
      COALESCE(NULLIF(v_day->>'sort_order','')::int, 0)
    )
    ON CONFLICT (event_id, day_date) DO UPDATE SET
      warehouse_time = EXCLUDED.warehouse_time,
      ready_time = EXCLUDED.ready_time,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      notes = EXCLUDED.notes,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING id INTO v_day_id;

    DELETE FROM public.event_day_crew WHERE event_day_id = v_day_id;
    FOR v_crew IN SELECT * FROM jsonb_array_elements(COALESCE(v_day->'crew', '[]'::jsonb))
    LOOP
      INSERT INTO public.event_day_crew (event_day_id, crew_member_id, role_text, notes)
      VALUES (
        v_day_id,
        (v_crew->>'crew_member_id')::uuid,
        NULLIF(v_crew->>'role_text',''),
        NULLIF(v_crew->>'notes','')
      )
      ON CONFLICT (event_day_id, crew_member_id) DO UPDATE SET
        role_text = EXCLUDED.role_text,
        notes = EXCLUDED.notes;
    END LOOP;
  END LOOP;

  RETURN v_event_id;
END $fn$;
GRANT EXECUTE ON FUNCTION public.save_event_with_days(jsonb, jsonb, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    (
      public.is_full_scope()
      AND (
        public.is_admin()
        OR public.has_permission('calendar','view')
        OR public.has_permission('crew','view')
        OR public.has_permission('clients','view')
      )
    )
    OR public.is_assigned_to_event(p_event)
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT q.id INTO v_quote
  FROM public.quotes q
  WHERE q.event_id = p_event
  ORDER BY (q.status = 'approved') DESC, q.created_at DESC
  LIMIT 1;

  IF v_quote IS NULL THEN
    v_items := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_name', s.name,
      'description', COALESCE(NULLIF(i.description, ''), i.name),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM public.shifts sh
  JOIN public.crew_members c ON c.id = sh.crew_member_id
  WHERE sh.event_id = p_event;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;

GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Per-day crew NAMES for an assigned event (no hourly_rate exposed).
CREATE OR REPLACE FUNCTION public.event_day_crew_names(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v jsonb;
BEGIN
  IF NOT public.can_access_event(p_event) THEN
    RETURN '{}'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_object_agg(d.id::text, x.names), '{}'::jsonb) INTO v
  FROM public.event_days d
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('name', cm.full_name, 'role', dc.role_text)
        ORDER BY cm.full_name
      ),
      '[]'::jsonb
    ) AS names
    FROM public.event_day_crew dc
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE dc.event_day_id = d.id
  ) x ON true
  WHERE d.event_id = p_event;
  RETURN COALESCE(v, '{}'::jsonb);
END $fn$;
GRANT EXECUTE ON FUNCTION public.event_day_crew_names(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Time-entry audit flags: manual entry vs clock, and manual hour edits.
-- Additive only; does not touch RLS or the ownership trigger.
-- Idempotent: safe to re-apply on every build.
-- ============================================================================

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'manual'
    CHECK (entry_source IN ('clock','manual'));
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS manually_edited boolean NOT NULL DEFAULT false;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

-- Existing rows have no proof they came from the clock: keep entry_source='manual'
-- and record the owner as the best available creator.
UPDATE public.time_entries SET created_by = user_id WHERE created_by IS NULL;

CREATE OR REPLACE FUNCTION public.track_time_entry_manual_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  -- Closing an open clock shift is part of the clock flow, not a manual edit.
  IF OLD.entry_source = 'clock'
     AND OLD.manually_edited = false
     AND OLD.end_time IS NULL
     AND NEW.end_time IS NOT NULL
     AND NEW.work_date IS NOT DISTINCT FROM OLD.work_date
     AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
     AND NEW.day_type IS NOT DISTINCT FROM OLD.day_type
     AND NEW.shift_type IS NOT DISTINCT FROM OLD.shift_type
     AND NEW.travel_km IS NOT DISTINCT FROM OLD.travel_km
     AND NEW.travel_amount IS NOT DISTINCT FROM OLD.travel_amount
     AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
  THEN
    RETURN NEW;
  END IF;

  IF NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time
     OR NEW.end_time IS DISTINCT FROM OLD.end_time
     OR NEW.break_minutes IS DISTINCT FROM OLD.break_minutes
     OR NEW.day_type IS DISTINCT FROM OLD.day_type
     OR NEW.shift_type IS DISTINCT FROM OLD.shift_type
     OR NEW.travel_km IS DISTINCT FROM OLD.travel_km
     OR NEW.travel_amount IS DISTINCT FROM OLD.travel_amount
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
  THEN
    NEW.manually_edited := true;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = NULLIF(auth.user_id(), '')::uuid
      ) THEN
        NEW.edited_by := NULLIF(auth.user_id(), '')::uuid;
      ELSE
        NEW.edited_by := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NEW.edited_by := NULL;
    END;
    NEW.edited_at := now();
    NEW.edit_count := COALESCE(OLD.edit_count, 0) + 1;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS time_entries_manual_changes ON public.time_entries;
CREATE TRIGGER time_entries_manual_changes
BEFORE UPDATE ON public.time_entries
FOR EACH ROW EXECUTE FUNCTION public.track_time_entry_manual_changes();

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- Quote email delivery state (additive only).
-- ============================================================================

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS last_sent_to text;

NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- 0007 — Neon Auth schema grants for the site server.
--
-- Password reset (admin reset + self-service forgot-password) runs in
-- server/routes.mjs on the `site_server` role and must read the previous
-- credential hash and write the new one in neon_auth.account. The neon_auth
-- schema is owned by the `neon_auth` role with an empty ACL, so site_server
-- currently gets "permission denied for schema neon_auth".
--
-- The migration runner (neondb_owner) is a member of neon_auth, so it can
-- grant these. If it cannot, the block reports and does NOT abort the build.
-- ============================================================================
DO $neon_auth_grants$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'neon_auth') THEN
    RAISE NOTICE 'neon_auth grants skipped: schema neon_auth does not exist yet';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    RAISE NOTICE 'neon_auth grants skipped: role site_server does not exist';
  ELSE
    BEGIN
      GRANT USAGE ON SCHEMA neon_auth TO site_server;

      IF to_regclass('neon_auth."user"') IS NOT NULL THEN
        GRANT SELECT ON neon_auth."user" TO site_server;
      END IF;

      IF to_regclass('neon_auth.account') IS NOT NULL THEN
        GRANT SELECT, UPDATE ON neon_auth.account TO site_server;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'neon_auth' AND c.relkind = 'S'
      ) THEN
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA neon_auth TO site_server;
      END IF;

      RAISE NOTICE 'neon_auth grants applied to site_server';
    EXCEPTION WHEN insufficient_privilege OR invalid_schema_name THEN
      RAISE NOTICE 'neon_auth grants skipped: insufficient_privilege or invalid_schema_name';
    END;
  END IF;
END $neon_auth_grants$;

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
-- ============================================================================
-- 0010 — One quote per event + automatic version history.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.quote_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  event_id       uuid,
  version_number integer NOT NULL,
  snapshot       jsonb NOT NULL,
  total          numeric,
  label          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, version_number)
);

CREATE INDEX IF NOT EXISTS quote_versions_quote_version_idx
  ON public.quote_versions (quote_id, version_number DESC);

ALTER TABLE public.quote_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.quote_versions TO authenticated;

DROP POLICY IF EXISTS quote_versions_read ON public.quote_versions;
CREATE POLICY quote_versions_read ON public.quote_versions FOR SELECT TO authenticated USING (
  public.is_full_scope() AND (
    public.is_admin()
    OR public.has_permission('quotes','view')
    OR public.has_permission('quotes','edit')
    OR (public.is_approved() AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_versions.quote_id AND q.created_by::text = auth.user_id()
    ))
  )
);

DROP POLICY IF EXISTS quote_versions_insert ON public.quote_versions;
CREATE POLICY quote_versions_insert ON public.quote_versions FOR INSERT TO authenticated WITH CHECK (
  public.is_full_scope() AND (
    public.is_admin()
    OR public.has_permission('quotes','edit')
    OR (public.is_approved() AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_versions.quote_id AND q.created_by::text = auth.user_id()
    ))
  )
);

-- Deduplicate existing quotes before adding the unique index. The oldest quote
-- for each event is preserved as a full snapshot on the surviving (newest) quote.
DO $dedupe$
DECLARE
  dup record;
  survivor uuid;
  old_quote record;
  snapshot jsonb;
  next_version integer;
  merged integer := 0;
BEGIN
  FOR dup IN
    SELECT event_id FROM public.quotes
    WHERE event_id IS NOT NULL
    GROUP BY event_id HAVING count(*) > 1
  LOOP
    SELECT id INTO survivor FROM public.quotes
    WHERE event_id = dup.event_id
    ORDER BY created_at DESC, updated_at DESC, id DESC
    LIMIT 1;
    SELECT COALESCE(max(version_number), 0) + 1 INTO next_version
    FROM public.quote_versions WHERE quote_id = survivor;
    FOR old_quote IN
      SELECT * FROM public.quotes
      WHERE event_id = dup.event_id AND id <> survivor
      ORDER BY created_at ASC, updated_at ASC
    LOOP
      SELECT jsonb_build_object(
        'quote', to_jsonb(old_quote),
        'sections', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sort_order) FROM public.quote_sections s WHERE s.quote_id = old_quote.id), '[]'::jsonb),
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order) FROM public.quote_items i WHERE i.quote_id = old_quote.id), '[]'::jsonb)
      ) INTO snapshot;
      INSERT INTO public.quote_versions (quote_id, event_id, version_number, snapshot, total, label, created_by)
      VALUES (survivor, dup.event_id, next_version, snapshot, old_quote.grand_total, 'הצעה קודמת — נשמרה לפני איחוד לכפילות', old_quote.created_by)
      ON CONFLICT (quote_id, version_number) DO NOTHING;
      DELETE FROM public.quotes WHERE id = old_quote.id;
      next_version := next_version + 1;
      merged := merged + 1;
    END LOOP;
  END LOOP;
  IF merged > 0 THEN
    RAISE NOTICE 'אוחדו % הצעות מחיר כפולות', merged;
  END IF;
END $dedupe$;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_per_event
  ON public.quotes (event_id) WHERE event_id IS NOT NULL;
-- ============================================================================
-- 0011 — Calendar scope by role.
-- warehouse: read ALL events + event_days (no status/assignment filter).
-- crew:      read the events they are assigned to (shifts OR event_day_crew),
--            plus those events' event_days and their own shift rows.
-- admin / accounting / sales: unchanged.
-- ============================================================================

DROP POLICY IF EXISTS events_read ON public.events;
CREATE POLICY events_read ON public.events FOR SELECT TO authenticated USING (
  (
    public.is_full_scope()
    AND (
      public.is_admin()
      OR (public.has_permission('finance','view') AND public.app_role() = 'accounting')
      OR (public.has_permission('calendar','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('clients','view')
          AND (public.app_role() <> 'sales' OR sales_rep_id::text = auth.user_id()))
      OR (public.has_permission('crew','view') AND public.is_crew_on_event(id))
      OR public.has_permission('quotes','view')
      OR public.has_permission('quotes','edit')
      OR public.has_permission('office','view')
    )
  )
  OR public.is_assigned_to_event(id)
  OR public.app_role() = 'warehouse'
);

DROP POLICY IF EXISTS event_days_read ON public.event_days;
CREATE POLICY event_days_read ON public.event_days FOR SELECT TO authenticated USING (
  (public.is_full_scope() AND public.can_access_event(event_id))
  OR public.is_assigned_to_event(event_id)
  OR public.app_role() = 'warehouse'
);
-- ============================================================================
-- 0012 — Event report fixes.
-- 1) is_assigned_to_event also matches event_day_crew assignments.
-- 2) event_crew_sheet authorizes warehouse + assigned crew and returns the item
--    name and description as SEPARATE fields (never collapses one into the other).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_assigned_to_event(p_event uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.id = p_event AND e.sales_rep_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    JOIN public.crew_members cm ON cm.id = s.crew_member_id
    WHERE s.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  IF ok THEN RETURN TRUE; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    JOIN public.crew_members cm ON cm.id = dc.crew_member_id
    WHERE d.event_id = p_event AND cm.user_id::text = auth.user_id()
  ) INTO ok;
  RETURN COALESCE(ok, false);
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.event_crew_sheet(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_quote uuid;
  v_items jsonb;
  v_crew jsonb;
BEGIN
  IF NOT (
    public.is_admin()
    OR public.app_role() = 'warehouse'
    OR public.is_assigned_to_event(p_event)
    OR (
      public.is_full_scope()
      AND (
        public.has_permission('calendar','view')
        OR public.has_permission('crew','view')
        OR public.has_permission('clients','view')
      )
    )
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT q.id INTO v_quote
  FROM public.quotes q
  WHERE q.event_id = p_event
  ORDER BY (q.status = 'approved') DESC, q.created_at DESC
  LIMIT 1;

  IF v_quote IS NULL THEN
    v_items := '[]'::jsonb;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'section_name', s.name,
      'name', i.name,
      'description', NULLIF(i.description, ''),
      'quantity', COALESCE(i.quantity, i.qty, 0),
      'unit', i.unit,
      'is_optional', COALESCE(i.is_optional, false),
      'sort_order', i.sort_order
    ) ORDER BY i.sort_order), '[]'::jsonb)
    INTO v_items
    FROM public.quote_items i
    LEFT JOIN public.quote_sections s ON s.id = i.section_id
    WHERE i.quote_id = v_quote;
  END IF;

  SELECT COALESCE(jsonb_agg(DISTINCT c.full_name), '[]'::jsonb)
  INTO v_crew
  FROM (
    SELECT sh.crew_member_id FROM public.shifts sh WHERE sh.event_id = p_event
    UNION
    SELECT dc.crew_member_id
    FROM public.event_days d
    JOIN public.event_day_crew dc ON dc.event_day_id = d.id
    WHERE d.event_id = p_event
  ) x
  JOIN public.crew_members c ON c.id = x.crew_member_id;

  RETURN jsonb_build_object('items', v_items, 'crew', v_crew);
END $fn$;
GRANT EXECUTE ON FUNCTION public.event_crew_sheet(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
-- ============================================================================
-- 0013 — Crew dedupe + role exclusion.
-- Keeps the OLDEST row per normalized name, re-points every shift and
-- event_day_crew assignment to the survivor, deletes the redundant rows, then
-- removes crew rows linked to admin/accounting profiles. Finally adds a unique
-- index on lower(btrim(full_name)) and keeps the profile→crew trigger in sync.
-- Safe to run twice.
-- ============================================================================

DO $dedupe$
DECLARE
  v_before int;
  v_after int;
  v_dupes int := 0;
  v_roles int := 0;
BEGIN
  SELECT count(*) INTO v_before FROM public.crew_members;

  -- 1) Re-point shifts from duplicate rows to the oldest row per normalized name.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  UPDATE public.shifts s
     SET crew_member_id = r.survivor
    FROM ranked r
   WHERE s.crew_member_id = r.id
     AND r.id <> r.survivor;

  -- 1b) Collapse shifts that became duplicates after the re-point.
  DELETE FROM public.shifts s
   USING public.shifts keep
   WHERE s.event_id = keep.event_id
     AND s.crew_member_id = keep.crew_member_id
     AND s.starts_at = keep.starts_at
     AND s.id <> keep.id
     AND (keep.created_at, keep.id) < (s.created_at, s.id);

  -- 2) Drop event_day_crew rows that would collide with the survivor.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  ),
  dupes AS (
    SELECT dc.id
      FROM public.event_day_crew dc
      JOIN ranked r ON r.id = dc.crew_member_id
     WHERE r.id <> r.survivor
       AND EXISTS (
         SELECT 1 FROM public.event_day_crew existing
          WHERE existing.event_day_id = dc.event_day_id
            AND existing.crew_member_id = r.survivor
       )
  )
  DELETE FROM public.event_day_crew dc
   USING dupes d
   WHERE dc.id = d.id;

  -- 2b) Re-point the remaining event_day_crew rows.
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  UPDATE public.event_day_crew dc
     SET crew_member_id = r.survivor
    FROM ranked r
   WHERE dc.crew_member_id = r.id
     AND r.id <> r.survivor;

  -- 3) Delete duplicate crew rows (keep the oldest).
  WITH ranked AS (
    SELECT id,
           first_value(id) OVER (
             PARTITION BY lower(btrim(full_name))
             ORDER BY created_at ASC, id ASC
           ) AS survivor
      FROM public.crew_members
  )
  DELETE FROM public.crew_members c
   USING ranked r
   WHERE c.id = r.id
     AND r.id <> r.survivor;
  GET DIAGNOSTICS v_dupes = ROW_COUNT;

  -- 4) Re-point assignments away from admin/accounting rows to a non-excluded
  --    row with the same normalized name, when one exists.
  WITH excluded AS (
    SELECT c.id, lower(btrim(c.full_name)) AS norm
      FROM public.crew_members c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE p.role IN ('admin','accounting')
  ),
  replacement AS (
    SELECT e.id AS old_id,
           (SELECT c2.id
              FROM public.crew_members c2
              LEFT JOIN public.profiles p2 ON p2.id = c2.user_id
             WHERE lower(btrim(c2.full_name)) = e.norm
               AND (p2.role IS NULL OR p2.role NOT IN ('admin','accounting'))
             ORDER BY c2.created_at ASC, c2.id ASC
             LIMIT 1) AS new_id
      FROM excluded e
  )
  UPDATE public.shifts s
     SET crew_member_id = r.new_id
    FROM replacement r
   WHERE s.crew_member_id = r.old_id
     AND r.new_id IS NOT NULL;

  WITH excluded AS (
    SELECT c.id, lower(btrim(c.full_name)) AS norm
      FROM public.crew_members c
      JOIN public.profiles p ON p.id = c.user_id
     WHERE p.role IN ('admin','accounting')
  ),
  replacement AS (
    SELECT e.id AS old_id,
           (SELECT c2.id
              FROM public.crew_members c2
              LEFT JOIN public.profiles p2 ON p2.id = c2.user_id
             WHERE lower(btrim(c2.full_name)) = e.norm
               AND (p2.role IS NULL OR p2.role NOT IN ('admin','accounting'))
             ORDER BY c2.created_at ASC, c2.id ASC
             LIMIT 1) AS new_id
      FROM excluded e
  )
  UPDATE public.event_day_crew dc
     SET crew_member_id = r.new_id
    FROM replacement r
   WHERE dc.crew_member_id = r.old_id
     AND r.new_id IS NOT NULL;

  -- 5) Remove any assignments still owned by admin/accounting rows (no
  --    same-name replacement existed). These roles must not appear at all.
  DELETE FROM public.shifts s
   USING public.crew_members c, public.profiles p
   WHERE s.crew_member_id = c.id
     AND c.user_id = p.id
     AND p.role IN ('admin','accounting');

  DELETE FROM public.event_day_crew dc
   USING public.crew_members c, public.profiles p
   WHERE dc.crew_member_id = c.id
     AND c.user_id = p.id
     AND p.role IN ('admin','accounting');

  -- 6) Delete the admin/accounting crew rows.
  DELETE FROM public.crew_members c
   USING public.profiles p
   WHERE c.user_id = p.id
     AND p.role IN ('admin','accounting');
  GET DIAGNOSTICS v_roles = ROW_COUNT;

  SELECT count(*) INTO v_after FROM public.crew_members;
  RAISE NOTICE 'crew dedupe: before=%, after=%, duplicates_removed=%, admin_accounting_removed=%',
    v_before, v_after, v_dupes, v_roles;
END $dedupe$;

CREATE UNIQUE INDEX IF NOT EXISTS crew_members_name_unique
  ON public.crew_members (lower(btrim(full_name)));

-- 7) Keep the profile→crew trigger idempotent and role-aware.
CREATE OR REPLACE FUNCTION public.link_profile_to_crew() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  matched_id uuid;
BEGIN
  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;
  IF NEW.role IN ('admin','accounting') THEN RETURN NEW; END IF;

  SELECT id INTO matched_id
  FROM public.crew_members
  WHERE lower(btrim(full_name)) = lower(btrim(NEW.full_name))
     OR (email IS NOT NULL AND lower(email) = lower(NEW.email))
     OR (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone)
  ORDER BY
    (lower(btrim(full_name)) = lower(btrim(NEW.full_name))) DESC,
    (email IS NOT NULL AND lower(email) = lower(NEW.email)) DESC,
    (phone IS NOT NULL AND NEW.phone IS NOT NULL AND phone = NEW.phone) DESC
  LIMIT 1;

  IF matched_id IS NOT NULL THEN
    UPDATE public.crew_members
    SET user_id = NEW.id,
        email = COALESCE(email, NEW.email),
        phone = COALESCE(phone, NEW.phone)
    WHERE id = matched_id;
  ELSE
    INSERT INTO public.crew_members (full_name, phone, role_title, hourly_rate, is_active, user_id, email)
    VALUES (
      NEW.full_name, NEW.phone,
      CASE NEW.role
        WHEN 'admin' THEN 'מנהל'
        WHEN 'sales' THEN 'מכירות'
        WHEN 'accounting' THEN 'הנהלת חשבונות'
        WHEN 'warehouse' THEN 'מחסן'
        ELSE 'טכנאי'
      END,
      NEW.hourly_rate, COALESCE(NEW.is_active, true), NEW.id, NEW.email
    )
    ON CONFLICT (lower(btrim(full_name))) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          email = COALESCE(crew_members.email, EXCLUDED.email),
          phone = COALESCE(crew_members.phone, EXCLUDED.phone);
  END IF;
  RETURN NEW;
END $fn$;
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
-- ============================================================================
-- 0015 — Deduplicate clients by normalized name.
-- Normalization matches the app helper: lowercase, trim, collapse inner
-- whitespace, strip Hebrew niqqud (U+0591–U+05C7).
-- Survivor per group = earliest created_at, tie-break smallest id::text.
-- Coalesces missing detail fields into the survivor, re-points every FK, then
-- deletes the redundant rows and adds a unique index so duplicates cannot
-- return. Idempotent: a second run finds no duplicate groups.
-- ============================================================================

DO $dedupe$
DECLARE
  v_before int;
  v_after int;
  v_groups int := 0;
  v_removed int := 0;
  v_deleted int;
  grp record;
  survivor uuid;
BEGIN
  SELECT count(*) INTO v_before FROM public.clients;

  FOR grp IN
    SELECT lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) AS norm
    FROM public.clients
    GROUP BY lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g'))
    HAVING count(*) > 1
  LOOP
    v_groups := v_groups + 1;

    SELECT id INTO survivor
    FROM public.clients
    WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
    ORDER BY created_at ASC, id::text ASC
    LIMIT 1;

    UPDATE public.clients s
    SET contact_name = COALESCE(NULLIF(btrim(s.contact_name), ''), (
          SELECT NULLIF(btrim(c.contact_name), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.contact_name), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        phone = COALESCE(NULLIF(btrim(s.phone), ''), (
          SELECT NULLIF(btrim(c.phone), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.phone), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        email = COALESCE(NULLIF(btrim(s.email), ''), (
          SELECT NULLIF(btrim(c.email), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.email), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        company = COALESCE(NULLIF(btrim(s.company), ''), (
          SELECT NULLIF(btrim(c.company), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.company), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        address = COALESCE(NULLIF(btrim(s.address), ''), (
          SELECT NULLIF(btrim(c.address), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.address), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1)),
        notes = COALESCE(NULLIF(btrim(s.notes), ''), (
          SELECT NULLIF(btrim(c.notes), '') FROM public.clients c
          WHERE lower(regexp_replace(regexp_replace(btrim(c.name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
            AND c.id <> survivor AND NULLIF(btrim(c.notes), '') IS NOT NULL
          ORDER BY c.created_at ASC, c.id::text ASC LIMIT 1))
    WHERE s.id = survivor;

    UPDATE public.events SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    UPDATE public.quotes SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    UPDATE public.paperless_documents SET client_id = survivor
    WHERE client_id IN (
      SELECT id FROM public.clients
      WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
        AND id <> survivor
    );

    DELETE FROM public.clients
    WHERE lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')) = grp.norm
      AND id <> survivor;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_removed := v_removed + v_deleted;
  END LOOP;

  DROP INDEX IF EXISTS public.clients_name_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS clients_name_unique
    ON public.clients (lower(regexp_replace(regexp_replace(btrim(name), '[֑-ׇ]', '', 'g'), '[[:space:]]+', ' ', 'g')));

  SELECT count(*) INTO v_after FROM public.clients;
  RAISE NOTICE 'clients dedupe: before=%, after=%, duplicate_groups=%, redundant_removed=%',
    v_before, v_after, v_groups, v_removed;
END $dedupe$;
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
-- ============================================================================
-- 0017 — Backfill events.total_amount from the linked quote's grand_total.
-- The events list reads the quote total directly, but other screens read
-- events.total_amount; this keeps them in sync for existing rows. Events
-- without a quote stay at 0. Idempotent.
-- ============================================================================

UPDATE public.events e
SET total_amount = latest.grand_total
FROM (
  SELECT DISTINCT ON (event_id) event_id, grand_total
  FROM public.quotes
  WHERE event_id IS NOT NULL
  ORDER BY event_id, created_at DESC
) latest
WHERE latest.event_id = e.id;
-- ============================================================================
-- 0018 — Crew multi-role support + role data repair.
--
-- Adds `crew_roles text[]` so one crew member can hold several roles at once.
-- `role_title` stays as a compatibility column, kept in sync with
-- `crew_roles[1]` by a BEFORE INSERT/UPDATE trigger. Existing rows are
-- backfilled from their current `role_title`. Two rows that were showing the
-- wrong role are repaired to 'טכנאי'. No CHECK constraints, no indexes.
-- ============================================================================

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS crew_roles text[] NOT NULL DEFAULT '{}';

-- Repair the two rows that were stored with the wrong role. The guard makes
-- this a one-shot: it only fires while the row is still un-migrated
-- (crew_roles empty) and still holds the bad value, so re-applying the
-- migration never overwrites a role the user sets later.
UPDATE public.crew_members
SET role_title = 'טכנאי',
    crew_roles = ARRAY['טכנאי']
WHERE full_name IN ('אברהם פנחס', 'אלי גולדשטיין')
  AND cardinality(crew_roles) = 0
  AND btrim(role_title) = 'מכירות';

DO $$
DECLARE
  v_before integer;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.crew_members
  WHERE cardinality(crew_roles) > 0;

  UPDATE public.crew_members
  SET crew_roles = ARRAY[role_title]
  WHERE cardinality(crew_roles) = 0
    AND role_title IS NOT NULL
    AND btrim(role_title) <> '';

  SELECT count(*) INTO v_after
  FROM public.crew_members
  WHERE cardinality(crew_roles) > 0;

  RAISE NOTICE '0018 crew_roles backfill: before=% after=%', v_before, v_after;
END $$;

-- Keep role_title = crew_roles[1] on every write. A legacy write that only
-- sets role_title backfills crew_roles from it, so the two never diverge.
CREATE OR REPLACE FUNCTION public.sync_crew_role_title() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.crew_roles IS NULL THEN
    NEW.crew_roles := '{}';
  END IF;
  IF cardinality(NEW.crew_roles) = 0
     AND NEW.role_title IS NOT NULL
     AND btrim(NEW.role_title) <> '' THEN
    NEW.crew_roles := ARRAY[NEW.role_title];
  END IF;
  IF cardinality(NEW.crew_roles) > 0 THEN
    NEW.role_title := NEW.crew_roles[1];
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS crew_roles_sync ON public.crew_members;
CREATE TRIGGER crew_roles_sync
BEFORE INSERT OR UPDATE ON public.crew_members
FOR EACH ROW EXECUTE FUNCTION public.sync_crew_role_title();

NOTIFY pgrst, 'reload schema';
-- 0019: repair only the known corrupt import of quote 2432.
-- The guard becomes false after the repair, so this is idempotent and scoped.
DO $do$
DECLARE
  v_quote_id uuid;
  v_event_id uuid;
  v_client_id uuid;
  v_sum numeric;
  v_general uuid := gen_random_uuid();
  v_barkat uuid := gen_random_uuid();
  v_sapir uuid := gen_random_uuid();
BEGIN
  SELECT id, event_id, client_id
  INTO v_quote_id, v_event_id, v_client_id
  FROM public.quotes
  WHERE quote_number = '2432'
    AND grand_total = 77682.00
    AND client_name = 'מכון בית יעקב למורות'
  LIMIT 1;

  IF v_quote_id IS NULL THEN
    RAISE NOTICE '0019: quote 2432 is not in the corrupt state; skipped';
    RETURN;
  END IF;

  SELECT 9500 + 13000 + 0 + 1600 + 7500 + 15000 + 3200 + 3200
       + 1200 + 2500 + 1500 + 1600 + 1200 + 1600 + 800 + 0
  INTO v_sum;
  IF v_sum <> 63400 THEN
    RAISE EXCEPTION '0019: item total assertion failed: %', v_sum;
  END IF;

  UPDATE public.quotes
  SET venue = 'מלון רויאל ים המלח',
      discount_type = 'percent',
      discount_value = 8,
      discount_amount = 5072,
      subtotal = 63400,
      total_before_vat = 58328,
      vat_rate = 18,
      vat_amount = 10499.04,
      grand_total = 68827,
      notes = $notes$מוניטור לעמדת קונטרול
4 מוניטורים בשליחות נפרדות
5 מדונות
4 מיק אלחוטי לזמרות ולמרצים
2 מיק למרצות
מיקרופון TB
מיקרופון דינמי
חיבור אינר לזמרת
חיבור לקלידים
חיבור לקלרינט
חיבור ל־2 כינורות
חיבור לחליל צד
באירוע מתקיימים 2 סימפוזיונים, שבכל סימפוזיון 6 אנשים.
הקלטת כל האירוע$notes$
  WHERE id = v_quote_id;

  UPDATE public.events
  SET venue = 'מלון רויאל ים המלח', address = NULL, total_amount = 68827
  WHERE id = v_event_id;

  UPDATE public.clients
  SET address = 'ירושלים'
  WHERE id = v_client_id AND address IS NULL;

  DELETE FROM public.quote_items WHERE quote_id = v_quote_id;
  DELETE FROM public.quote_sections WHERE quote_id = v_quote_id;

  INSERT INTO public.quote_sections (id, quote_id, name, sort_order, show_section_totals)
  VALUES
    (v_general, v_quote_id, 'כללי', 0, true),
    (v_barkat, v_quote_id, 'אולם ברקת', 1, true),
    (v_sapir, v_quote_id, 'אולם ספיר', 2, true);

  INSERT INTO public.quote_items
    (id, quote_id, section_id, sort_order, name, description, qty, quantity, unit, unit_price, line_total, is_optional)
  VALUES
    (gen_random_uuid(), v_quote_id, v_general, 0, 'במות לפי סקיצה מצורפת', NULL, 1, 1, NULL, 9500, 9500, false),
    (gen_random_uuid(), v_quote_id, v_general, 1, 'מסכי לדים לפי סקיצה מצורפת', NULL, 52, 52, NULL, 250, 13000, false),
    (gen_random_uuid(), v_quote_id, v_general, 2, '2 מחשבים עם VMIX + רישיון; חיבור לכל אופציות המסכים; חיבור למעגל סגור; 2 כבלים SDI לצלם וידאו', NULL, 0, 0, NULL, 0, 0, false),
    (gen_random_uuid(), v_quote_id, v_general, 3, '2 עמודי תאורה עם 4 תומסים לד ו־4 פר לד על כל עמוד (מחירון וואו)', NULL, 1, 1, NULL, 1600, 1600, false),
    (gen_random_uuid(), v_quote_id, v_general, 4, 'מערכת הגברה ליינאריי כולל פרונט פילים ופיזורים כנדרש לכיסוי האולם עבור 700 בנות. (העמדה בקצה של האולם שלא יסתיר המסך עד כמה שניתן). 6 רמקולים + אפקטים, שליטה נפרדת בווליום לפרונט ובק. מפרט מצורף בהערות', NULL, 1, 1, NULL, 7500, 7500, false),
    (gen_random_uuid(), v_quote_id, v_general, 5, 'יום נוסף 50%', NULL, 1, 1, NULL, 15000, 15000, false),
    (gen_random_uuid(), v_quote_id, v_general, 6, 'טכנאי וידאו', NULL, 2, 2, NULL, 1600, 3200, false),
    (gen_random_uuid(), v_quote_id, v_general, 7, 'טכנאי סאונד', NULL, 2, 2, NULL, 1600, 3200, false),
    (gen_random_uuid(), v_quote_id, v_general, 8, 'אפ לייט גב במה וקצת צדדים', NULL, 20, 20, NULL, 60, 1200, false),
    (gen_random_uuid(), v_quote_id, v_barkat, 9, 'הגברה לפי מפרט', NULL, 1, 1, NULL, 2500, 2500, false),
    (gen_random_uuid(), v_quote_id, v_barkat, 10, 'מסך לד 3*2', NULL, 6, 6, NULL, 250, 1500, false),
    (gen_random_uuid(), v_quote_id, v_barkat, 11, 'במה למסך לד גובה 90', NULL, 1, 1, NULL, 1600, 1600, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 12, 'מסך פלאזמה 65 אינץ', NULL, 1, 1, NULL, 1200, 1200, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 13, 'מערכת הגברה קטנה + מיק + מחשב', NULL, 1, 1, NULL, 1600, 1600, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 14, 'תוספת פרומטר לאולם תרשיש', NULL, 1, 1, NULL, 800, 800, false),
    (gen_random_uuid(), v_quote_id, v_sapir, 15, 'מהנדס חסר מחיר מחכה להצעה מחשמלאי של המלון', NULL, 0, 0, NULL, 0, 0, false);
END $do$;

NOTIFY pgrst, 'reload schema';
-- 0020: repair only the known corrupt import of quote 2434.
-- Every statement is guarded by the exact current wrong value, so a second
-- run is a no-op and no other row can be touched.

UPDATE public.clients
SET name = 'סמינר דרכי רחל'
WHERE id = '7695fdf5-78cb-4e44-90f3-e6d2e46333b0'
  AND name = 'סמי נ ר דרכי רחל';

UPDATE public.quotes
SET client_name = 'סמינר דרכי רחל', venue = NULL
WHERE id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96'
  AND quote_number = '2434'
  AND venue = 'נייד : 8470175 - 054 חיה';

UPDATE public.events e
SET title = 'סמינר דרכי רחל', venue = NULL,
    event_date = COALESCE(q.event_date, '2026-11-07'),
    start_date = COALESCE(q.event_date, '2026-11-07'),
    end_date = COALESCE(q.event_date, '2026-11-07')
FROM public.quotes q
WHERE e.id = '1f586596-ff5c-4dd1-a33b-8033f7848633'
  AND e.title = 'סמי נ ר דרכי רחל'
  AND q.id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96'
  AND q.quote_number = '2434'
  AND e.start_date = q.quote_date;

UPDATE public.quote_items
SET name = 'מסך 2.5*4',
    description = '(צריך לבדוק את גובה התקרה באולם ולהחליט על גובה הבמה והמסך)'
WHERE quote_id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96'
  AND sort_order = 0
  AND name = 'מסך 2*4.5'
  AND description = ')צריך לבדוק את גובה התקרה באולם ולהחליט על גובה הבמה והמסך (';

UPDATE public.quote_items
SET name = 'הגברה ל 600 בנות',
    description = '(מפרט כמצורף בהערה למטה) כולל פיזורים מאחורה'
WHERE quote_id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96'
  AND sort_order = 1
  AND name = 'הגברה ל600 בנות'
  AND description = ') מפרט כמצורף בהערה למטה ( כולל פיזורים מאחורה';

UPDATE public.quote_items
SET name = 'מפרט הגברה: 3 מיק אלחוטי מיפרו, מיק אלחוטי לשירה, הקלטה, חיבור 3 כלים.',
    description = NULL
WHERE quote_id = '7529bc49-84e7-4d78-86a1-4fbb8ed59a96'
  AND sort_order = 3
  AND name = 'מפרט הגברה : 3 מיק אלחוטי מיפרו , מיק אלחוטי לשירה , הקלטה ,'
  AND description = 'חיבור 3 כלים.';

NOTIFY pgrst, 'reload schema';
-- 0021: repair only the known corrupt import of quote 2439.
-- Every statement is guarded by the exact current wrong value, so a second
-- run is a no-op and no other client, quote, event or item can be touched.

-- Carry the duplicate client's phone only when the surviving client lacks one.
UPDATE public.clients target
SET phone = source.phone
FROM public.clients source
WHERE target.id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
  AND source.id = 'dc3c5c21-06bd-4172-81fd-7897244e350d'
  AND target.phone IS NULL
  AND source.phone IS NOT NULL;

-- Repoint the quote and its event to the pre-existing client.
UPDATE public.quotes
SET client_id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
WHERE quote_number = '2439'
  AND client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d';

UPDATE public.events
SET client_id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
WHERE id = (SELECT event_id FROM public.quotes WHERE quote_number = '2439')
  AND client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d';

-- Keep any contacts attached to the duplicate.
UPDATE public.client_contacts
SET client_id = '165f095b-bb9b-409a-8a49-97adc01a17f5'
WHERE client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d';

-- Delete the duplicate only when nothing else references it.
DELETE FROM public.clients
WHERE id = 'dc3c5c21-06bd-4172-81fd-7897244e350d'
  AND name = 'ת נ ועת בתיה'
  AND NOT EXISTS (SELECT 1 FROM public.quotes WHERE client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d')
  AND NOT EXISTS (SELECT 1 FROM public.events WHERE client_id = 'dc3c5c21-06bd-4172-81fd-7897244e350d');

-- Correct the client name and venue on the quote and its event.
UPDATE public.quotes
SET client_name = 'תנועת בתיה', venue = 'בנייני האומה, אולם אשכול'
WHERE quote_number = '2439'
  AND client_name = 'ת נ ועת בתיה'
  AND venue = 'בנייני האומה אולם אשכול';

UPDATE public.events
SET title = 'תנועת בתיה', venue = 'בנייני האומה, אולם אשכול'
WHERE id = (SELECT event_id FROM public.quotes WHERE quote_number = '2439')
  AND title = 'ת נ ועת בתיה'
  AND venue = 'בנייני האומה אולם אשכול';

-- Merge the split item sentence back into the name.
UPDATE public.quote_items
SET name = 'מערכת הגברה ל 240 בנות מיק אלחוטיים כמות? חיבור קלידים מפרט מדויק?',
    description = NULL
WHERE quote_id = (SELECT id FROM public.quotes WHERE quote_number = '2439')
  AND sort_order = 4
  AND name = 'מערכת הגברה ל 240 בנות מיק אלחוטיים כמות? חיבור קלידים מפרט'
  AND description = 'מדויק?';

NOTIFY pgrst, 'reload schema';
-- 0022: rename the stored event status value ליד → ממתין לסגירה.
-- Idempotent: the drop is IF EXISTS, the update affects 0 rows on re-run,
-- and the constraint is only added when it is missing.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'ליד';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status IN ('הצעה','בוטל');
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
-- 0023: rename the stored event status value במשוריין → ממתין לסגירה.
-- Idempotent: drop is IF EXISTS, the update affects 0 rows on re-run,
-- the default is idempotent, and the constraint is only added when missing.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'במשוריין';

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status IN ('הצעה','בוטל');
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
-- 0024: the per-user permissions matrix is the only module gate.
-- Admin role no longer bypasses the matrix; the owner account keeps full access.

CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF auth.user_id() IS NULL OR auth.user_id() = '' THEN RETURN false; END IF;

  BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM neon_auth."user" u
      WHERE u.id::text = auth.user_id()
      AND lower(u.email) = ''a0525092333@gmail.com'')' INTO ok;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  IF ok THEN RETURN true; END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id::text = auth.user_id()
        AND lower(p.email) = 'a0525092333@gmail.com'
    ) INTO ok;
  EXCEPTION WHEN OTHERS THEN
    ok := false;
  END;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_permission(p_module text, p_action text DEFAULT 'view')
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE ok boolean := false;
BEGIN
  IF NOT public.is_approved() THEN RETURN false; END IF;
  IF public.is_super_admin() THEN RETURN true; END IF;
  IF p_action = 'edit' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND up.can_edit
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id::text = auth.user_id() AND up.module = p_module AND (up.can_view OR up.can_edit)
    ) INTO ok;
  END IF;
  RETURN COALESCE(ok, false);
END $fn$;
GRANT EXECUTE ON FUNCTION public.has_permission(text, text) TO authenticated;

DROP POLICY IF EXISTS user_permissions_admin_write ON public.user_permissions;
CREATE POLICY user_permissions_admin_write ON public.user_permissions FOR ALL TO authenticated
USING (public.is_super_admin() OR public.has_permission('users','edit'))
WITH CHECK (public.is_super_admin() OR public.has_permission('users','edit'));

DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING (
  id::text = auth.user_id()
  OR (
    public.is_full_scope()
    AND (
      public.is_super_admin()
      OR public.has_permission('users','view')
      OR public.has_permission('calendar','view')
      OR public.has_permission('clients','view')
      OR public.has_permission('finance','view')
      OR public.has_permission('crew','view')
      OR public.has_permission('equipment','view')
      OR public.has_permission('attendance','view')
      OR public.has_permission('attendance','edit')
    )
  )
);

DROP POLICY IF EXISTS profiles_update_self_or_admin ON public.profiles;
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated
USING (
  id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','edit')
  OR public.has_permission('attendance','edit')
)
WITH CHECK (
  id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','edit')
  OR public.has_permission('attendance','edit')
);

DROP POLICY IF EXISTS shifts_edit ON public.shifts;
CREATE POLICY shifts_edit ON public.shifts FOR ALL TO authenticated
USING (
  (public.is_full_scope() AND (public.has_permission('crew','edit') OR public.has_permission('office','edit')))
  OR (public.has_permission('crew','edit') AND public.is_assigned_to_event(event_id))
)
WITH CHECK (
  (public.is_full_scope() AND (public.has_permission('crew','edit') OR public.has_permission('office','edit')))
  OR (public.has_permission('crew','edit') AND public.is_assigned_to_event(event_id))
);

DROP POLICY IF EXISTS user_permissions_read ON public.user_permissions;
CREATE POLICY user_permissions_read ON public.user_permissions FOR SELECT TO authenticated USING (
  user_id::text = auth.user_id()
  OR public.is_super_admin()
  OR public.has_permission('users','view')
  OR public.has_permission('users','edit')
);

NOTIFY pgrst, 'reload schema';
-- 0025: optional company registration number / personal ID on clients.
-- Free text, nullable, no default, no backfill. Existing rows stay NULL.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS tax_id text;

NOTIFY pgrst, 'reload schema';
-- 0026: truthful Paperless document status + guarded repair of the one unverified row.
ALTER TABLE public.paperless_documents DROP CONSTRAINT IF EXISTS paperless_documents_status_check;
ALTER TABLE public.paperless_documents ADD CONSTRAINT paperless_documents_status_check
  CHECK (status IN ('issued','failed','check','unverified','pending'));

ALTER TABLE public.paperless_documents ALTER COLUMN raw_response TYPE jsonb USING raw_response::jsonb;

UPDATE public.paperless_documents
SET status = 'unverified',
    error_message = 'התקבל אישור מהשרת אך לא הוחזר מספר מסמך או קישור'
WHERE id = '2a11c7cb-5c1b-48a7-a8df-87a1e60b67e3'
  AND status = 'issued'
  AND doc_number IS NULL
  AND doc_url IS NULL
  AND external_id IS NULL;

-- Clear the false "issued" flag on the quote linked to the repaired document row.
UPDATE public.quotes
SET paperless_status = NULL,
    paperless_issued_at = NULL
WHERE id = (
  SELECT quote_id FROM public.paperless_documents
  WHERE id = '2a11c7cb-5c1b-48a7-a8df-87a1e60b67e3'
)
  AND paperless_status IS NOT NULL
  AND paperless_document_number IS NULL
  AND paperless_url IS NULL
  AND paperless_document_id IS NULL;

NOTIFY pgrst, 'reload schema';
-- 0027: event status set → exactly 4 values:
--   ממתין לסגירה, נסגר, ממתין לתשלום, שולם
-- Maps old values (never deletes events): הצעה→ממתין לסגירה, בוצע→ממתין לתשלום,
-- בוטל→ממתין לסגירה. Idempotent: drop IF EXISTS, updates hit 0 rows on re-run,
-- constraint re-added only when missing.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;

UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'הצעה';
UPDATE public.events SET status = 'ממתין לתשלום' WHERE status = 'בוצע';
UPDATE public.events SET status = 'ממתין לסגירה' WHERE status = 'בוטל';
UPDATE public.events SET status = 'ממתין לסגירה'
  WHERE status IS NULL OR status NOT IN ('ממתין לסגירה','נסגר','ממתין לתשלום','שולם');

ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'ממתין לסגירה';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_status_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK (status = ANY (ARRAY[''ממתין לסגירה'',''נסגר'',''ממתין לתשלום'',''שולם'']))';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
-- 0028: only the account owner (a0525092333@gmail.com, via is_super_admin())
-- may DELETE events. A RESTRICTIVE policy is AND-ed with every permissive policy
-- (events_edit FOR ALL), so admins / the permissions matrix can no longer delete.
-- INSERT/UPDATE/SELECT are untouched. Idempotent: drop-then-create. No data changes.
DROP POLICY IF EXISTS events_delete_owner_only ON public.events;
CREATE POLICY events_delete_owner_only ON public.events
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.is_super_admin());

NOTIFY pgrst, 'reload schema';
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
-- 0030: Paperless → production. One-time fix of the stored settings
-- (environment 'sandbox' → 'production', path '/api/invoices/wordpress/' → no
-- trailing slash, base URL → https://api.paperless.tax). Guarded by a marker row
-- so a later owner choice is never overwritten on re-runs. Idempotent.
CREATE TABLE IF NOT EXISTS public.one_time_fixes (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.one_time_fixes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.company_settings ALTER COLUMN paperless_environment SET DEFAULT 'production';
ALTER TABLE public.company_settings ALTER COLUMN paperless_document_path SET DEFAULT '/api/invoices/wordpress';

WITH marker AS (
  INSERT INTO public.one_time_fixes (key) VALUES ('0030_paperless_production')
  ON CONFLICT (key) DO NOTHING
  RETURNING key
)
UPDATE public.company_settings
SET paperless_environment = 'production',
    paperless_document_path = '/api/invoices/wordpress',
    paperless_base_url = 'https://api.paperless.tax'
WHERE id = 1 AND EXISTS (SELECT 1 FROM marker);

NOTIFY pgrst, 'reload schema';
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
-- Browser restrictions must not override the separate trusted-server policy.
-- Browser access still requires every existing accounting view/edit/creator check.
ALTER POLICY event_accounting_view ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_insert ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_update ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_delete ON public.event_accounting_references TO authenticated, anonymous;
NOTIFY pgrst, 'reload schema';
-- Keep these owner-only overrides last in the consolidated migration.
-- Complete existing audit storage without touching existing rows or permissions.
ALTER TABLE public.audit_logs ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.audit_logs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.audit_logs ALTER COLUMN details SET DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.security_actor(p_module text, p_action text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE uid text := nullif(auth.user_id()::text, ''); mail text; stored_role text;
  owner_account boolean := false; permitted boolean := false;
BEGIN
  IF uid IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT u.email FROM neon_auth."user" u
        WHERE u.id::text = $1 AND coalesce(u.banned, false) = false' INTO mail USING uid;
    EXCEPTION WHEN undefined_table OR undefined_column THEN mail := NULL;
    END;
    IF mail IS NOT NULL THEN
      owner_account := lower(mail) = 'a0525092333@gmail.com';
      SELECT p.role INTO stored_role FROM public.profiles p WHERE p.id::text = uid;
      IF p_action IN ('view','edit') AND p_module = ANY(public._security_modules()) THEN
        permitted := owner_account OR EXISTS (
          SELECT 1 FROM public.profiles p JOIN public.user_permissions up ON up.user_id = p.id
          WHERE p.id::text = uid AND p.is_active IS TRUE AND p.approval_status = 'approved'
            AND up.module = p_module AND CASE WHEN p_action = 'edit' THEN up.can_edit ELSE up.can_view OR up.can_edit END
        );
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('user_id',uid,'email',mail,'role',stored_role,
    'is_owner',owner_account,'allowed',coalesce(permitted,false));
END $fn$;

CREATE OR REPLACE FUNCTION public._security_owner_ids() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE ids text[];
BEGIN
  EXECUTE 'SELECT coalesce(array_agg(u.id::text), ARRAY[]::text[]) FROM neon_auth."user" u
    WHERE lower(u.email) = ''a0525092333@gmail.com''' INTO ids;
  RETURN ids;
END $fn$;

CREATE OR REPLACE FUNCTION public._security_can_audit() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT coalesce((public.security_actor('users','view')->>'is_owner')::boolean,false);
$fn$;

-- Restrict browser permission administration even if an admin has users.edit.
DROP POLICY IF EXISTS security_permissions_owner_insert ON public.user_permissions;
CREATE POLICY security_permissions_owner_insert ON public.user_permissions AS RESTRICTIVE
  FOR INSERT TO authenticated, anonymous WITH CHECK (public._security_can_audit());
DROP POLICY IF EXISTS security_permissions_owner_update ON public.user_permissions;
CREATE POLICY security_permissions_owner_update ON public.user_permissions AS RESTRICTIVE
  FOR UPDATE TO authenticated, anonymous USING (public._security_can_audit()) WITH CHECK (public._security_can_audit());
DROP POLICY IF EXISTS security_permissions_owner_delete ON public.user_permissions;
CREATE POLICY security_permissions_owner_delete ON public.user_permissions AS RESTRICTIVE
  FOR DELETE TO authenticated, anonymous USING (public._security_can_audit());

CREATE OR REPLACE FUNCTION public._security_guard_access_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  -- Nested auth/invite synchronization remains a trusted database operation.
  IF pg_trigger_depth() = 1 AND nullif(auth.user_id()::text,'') IS NOT NULL
    AND NOT public._security_can_audit() THEN
    RAISE EXCEPTION 'Owner-only permission administration' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public._security_guard_access_fields() FROM PUBLIC, anonymous, authenticated;
DROP TRIGGER IF EXISTS security_owner_profile_access ON public.profiles;
CREATE TRIGGER security_owner_profile_access BEFORE UPDATE OF role, is_active, approval_status ON public.profiles
  FOR EACH ROW WHEN (ROW(OLD.role,OLD.is_active,OLD.approval_status) IS DISTINCT FROM ROW(NEW.role,NEW.is_active,NEW.approval_status))
  EXECUTE FUNCTION public._security_guard_access_fields();
DO $fn$ BEGIN
  IF to_regclass('public.invites') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS security_owner_invites ON public.invites;
    CREATE TRIGGER security_owner_invites BEFORE INSERT OR UPDATE OR DELETE ON public.invites
      FOR EACH ROW EXECUTE FUNCTION public._security_guard_access_fields();
  END IF;
END $fn$;

DO $fn$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_permissions'::regclass AND conname = 'security_edit_requires_view') THEN
    ALTER TABLE public.user_permissions ADD CONSTRAINT security_edit_requires_view
      CHECK (can_edit IS NOT TRUE OR can_view IS TRUE) NOT VALID;
  END IF;
END $fn$;

ALTER FUNCTION public._security_clean_details(jsonb) SECURITY DEFINER;
DO $fn$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'site_server') THEN
    GRANT EXECUTE ON FUNCTION public._security_clean_details(jsonb) TO site_server;
  END IF;
END $fn$;
NOTIFY pgrst, 'reload schema';
