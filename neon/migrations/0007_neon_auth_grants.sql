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

