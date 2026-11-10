import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";
import { accountingFilesCopy as copy } from "@/content/event-accounting";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export default function ProtectedPdfPreview({ bytes }: { bytes: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    // Render authenticated bytes, never a public document URL or native PDF plugin.
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false });
    task.promise.then((pdf) => { if (!disposed) setDocument(pdf); }).catch(() => { if (!disposed) { setError(true); setLoading(false); } });
    return () => { disposed = true; void task.destroy().catch(() => {}); };
  }, [bytes]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let disposed = false;
    let render: pdfjs.RenderTask | undefined;
    setLoading(true); setError(false);
    document.getPage(page).then(async (pdfPage) => {
      if (disposed || !canvas.current) return;
      const element = canvas.current;
      const original = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1024 / original.width) });
      element.width = viewport.width; element.height = viewport.height;
      const context = element.getContext("2d");
      if (!context) throw new Error("canvas_unavailable");
      render = pdfPage.render({ canvasContext: context, viewport });
      await render.promise;
      if (!disposed) setLoading(false);
    }).catch(() => { if (!disposed) { setError(true); setLoading(false); } });
    return () => { disposed = true; render?.cancel(); };
  }, [document, page]);

  return <div className="space-y-2">
    {document ? <div className="flex flex-wrap items-center justify-between gap-2">
      <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>{copy.previewPrevious}</Button>
      <span className="text-xs" role="status">{copy.previewPage(page, document.numPages)}</span>
      <Button type="button" size="sm" variant="outline" disabled={page >= document.numPages} onClick={() => setPage(page + 1)}>{copy.previewNext}</Button>
    </div> : null}
    {loading ? <p role="status" className="py-3 text-sm">{copy.previewLoading}</p> : null}
    {error ? <p role="alert" className="py-3 text-sm text-destructive">{copy.previewError}</p> : null}
    <div className="max-h-[60vh] overflow-auto rounded-lg border bg-white">
      <canvas ref={canvas} role="img" aria-label={copy.previewPage(page, document?.numPages ?? 1)} className={error ? "hidden" : "block h-auto w-full min-w-[720px]"} />
    </div>
  </div>;
}
