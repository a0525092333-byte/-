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
