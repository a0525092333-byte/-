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
