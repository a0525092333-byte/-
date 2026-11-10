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
