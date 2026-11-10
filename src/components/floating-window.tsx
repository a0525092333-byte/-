import * as React from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type FloatingRect = { x: number; y: number; w: number; h: number };

function viewportSize() {
  if (typeof window === "undefined") return { w: 1280, h: 800 };
  return { w: window.innerWidth, h: window.innerHeight };
}

function defaultRect(viewport = viewportSize()): FloatingRect {
  const w = Math.min(1120, Math.max(360, viewport.w - 96));
  const h = Math.min(780, Math.max(320, viewport.h - 96));
  return {
    x: Math.max(8, Math.round((viewport.w - w) / 2)),
    y: Math.max(8, Math.round((viewport.h - h) / 2)),
    w,
    h,
  };
}

function clampRect(rect: FloatingRect, viewport = viewportSize()): FloatingRect {
  const minW = Math.min(340, viewport.w - 16);
  const minH = Math.min(240, viewport.h - 16);
  const w = Math.min(Math.max(rect.w, minW), Math.max(minW, viewport.w - 16));
  const h = Math.min(Math.max(rect.h, minH), Math.max(minH, viewport.h - 16));
  const x = Math.min(Math.max(rect.x, 8), Math.max(8, viewport.w - w - 8));
  const y = Math.min(Math.max(rect.y, 8), Math.max(8, viewport.h - h - 8));
  return { x, y, w, h };
}

function readSaved(key: string): FloatingRect | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FloatingRect>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.w === "number" &&
      typeof parsed.h === "number"
    ) {
      return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function writeSaved(key: string, rect: FloatingRect) {
  try {
    window.localStorage.setItem(key, JSON.stringify(rect));
  } catch {
    /* storage may be unavailable */
  }
}

export function FloatingWindow({
  open,
  onClose,
  title,
  storageKey,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  storageKey: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [rect, setRect] = React.useState<FloatingRect>(() => defaultRect());
  const dragRef = React.useRef<{ startX: number; startY: number; orig: FloatingRect } | null>(null);
  const resizeRef = React.useRef<{ startX: number; startY: number; orig: FloatingRect } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const viewport = viewportSize();
    const saved = readSaved(storageKey);
    setRect(clampRect(saved ?? defaultRect(viewport), viewport));
    setExpanded(viewport.w < 640);
  }, [open, storageKey]);

  React.useEffect(() => {
    if (!open) return;
    const onResize = () => setRect((current) => clampRect(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    writeSaved(storageKey, rect);
  }, [rect, open, storageKey]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (expanded) return;
    if ((event.target as HTMLElement).closest('[data-no-drag], input, button, label, a')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, orig: rect };
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setRect(
      clampRect({
        ...dragRef.current.orig,
        x: dragRef.current.orig.x + dx,
        y: dragRef.current.orig.y + dy,
      }),
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (expanded) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { startX: event.clientX, startY: event.clientY, orig: rect };
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return;
    const dx = event.clientX - resizeRef.current.startX;
    const dy = event.clientY - resizeRef.current.startY;
    const orig = resizeRef.current.orig;
    // Bottom-left handle in RTL: dragging left grows the width, down grows the height.
    setRect(clampRect({ ...orig, x: orig.x + dx, w: orig.w - dx, h: orig.h + dy }));
  }

  function endResize(event: React.PointerEvent<HTMLDivElement>) {
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className={cn(
          "absolute flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl",
          expanded ? "inset-2" : "",
          className,
        )}
        style={expanded ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        <div
          className="flex shrink-0 cursor-move touch-none select-none items-center justify-between gap-2 border-b border-border bg-card px-3 py-2"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-label={expanded ? "כווץ חלון" : "הרחב חלון"}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="סגירת חלון"
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {!expanded ? (
          <div
            role="separator"
            aria-label="שינוי גודל חלון"
            className="absolute bottom-0 left-0 size-6 cursor-nesw-resize touch-none"
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          >
            <span className="pointer-events-none absolute bottom-1 left-1 size-3 border-b-2 border-l-2 border-muted-foreground/60" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
