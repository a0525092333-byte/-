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
