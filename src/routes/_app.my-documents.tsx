import { createFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { useCrewMembers } from "@/hooks/use-data";
import { CrewDocumentsPanel } from "@/components/crew/crew-documents-panel";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, SectionCard } from "@/components/shared";

export const Route = createFileRoute("/_app/my-documents")({ component: MyDocumentsPage });

function MyDocumentsPage() {
  const { user } = useSession();
  const crewQ = useCrewMembers(Boolean(user?.id));
  const myCrew = (crewQ.data ?? []).find((member) => member.user_id === user?.id) ?? null;

  if (crewQ.isLoading) return <PageSkeleton />;
  if (crewQ.error) {
    return <ErrorState message="לא הצלחנו לטעון את המסמכים. נסה שוב." onRetry={() => crewQ.refetch()} />;
  }

  return (
    <div>
      <PageHeader
        title="המסמכים שלי"
        description="העלאת תעודת זהות, רישיון נהיגה ורישיון עבודה בגובה"
      />
      {myCrew ? (
        <SectionCard title={`המסמכים של ${myCrew.full_name}`} description="הקבצים נשמרים באופן מאובטח ונראים רק לך ולמנהל">
          <CrewDocumentsPanel crewMember={myCrew} canEdit onChanged={() => crewQ.refetch()} />
        </SectionCard>
      ) : (
        <EmptyState
          icon={FileText}
          title="המשתמש שלך אינו מקושר לאיש צוות"
          description="פנה למנהל כדי לקשר את המשתמש שלך לכרטיס איש הצוות, ואז תוכל להעלות את המסמכים."
        />
      )}
    </div>
  );
}
