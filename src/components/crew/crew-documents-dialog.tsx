import { Dialog } from "@/components/ui/overlay";
import { CrewDocumentsPanel } from "./crew-documents-panel";

export function CrewDocumentsDialog({
  open,
  onOpenChange,
  crewMember,
  canEdit,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  crewMember: { id: string; full_name: string } | null;
  canEdit: boolean;
  onChanged?: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={crewMember ? `מסמכים — ${crewMember.full_name}` : "מסמכים"}
      description="תעודת זהות, רישיון נהיגה ורישיון עבודה בגובה"
      size="lg"
    >
      {crewMember ? (
        <CrewDocumentsPanel crewMember={crewMember} canEdit={canEdit} onChanged={onChanged} />
      ) : null}
    </Dialog>
  );
}
