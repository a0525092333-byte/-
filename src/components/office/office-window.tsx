import { FloatingWindow } from "@/components/floating-window";
import { OfficeBoard } from "./office-board";

export function OfficeWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <FloatingWindow open={open} onClose={onClose} title="מצב משרד" storageKey="vincen:office-window">
      <OfficeBoard />
    </FloatingWindow>
  );
}
