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
