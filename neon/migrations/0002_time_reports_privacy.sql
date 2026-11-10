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
