-- Browser restrictions must not override the separate trusted-server policy.
-- Browser access still requires every existing accounting view/edit/creator check.
ALTER POLICY event_accounting_view ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_insert ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_update ON public.event_accounting_references TO authenticated, anonymous;
ALTER POLICY event_accounting_delete ON public.event_accounting_references TO authenticated, anonymous;
NOTIFY pgrst, 'reload schema';
