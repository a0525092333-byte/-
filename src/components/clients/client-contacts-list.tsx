import { useQuery } from "@tanstack/react-query";
import { Mail, Phone } from "lucide-react";
import { listContacts } from "@/lib/client-contacts";
import type { Client } from "@/lib/types";

/** Read-only list of a client's extra email + additional contacts. */
export function ClientContactsList({
  client,
  className,
}: {
  client: Pick<Client, "id" | "extra_email">;
  className?: string;
}) {
  const contactsQ = useQuery({
    queryKey: ["client_contacts", client.id],
    queryFn: () => listContacts(client.id),
  });
  const contacts = contactsQ.data ?? [];
  if (!client.extra_email && !contacts.length) return null;

  return (
    <div className={className}>
      {client.extra_email ? (
        <a
          href={`mailto:${client.extra_email}`}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Mail className="size-3.5" />
          <span dir="ltr">{client.extra_email}</span>
        </a>
      ) : null}
      {contacts.map((contact) => (
        <div key={contact.id} className="rounded-lg border border-border p-2 text-xs">
          <p className="font-medium text-foreground">
            {contact.full_name}
            {contact.role ? <span className="text-muted-foreground"> · {contact.role}</span> : null}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {contact.email ? (
              <a href={`mailto:${contact.email}`} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <Mail className="size-3.5" />
                <span dir="ltr">{contact.email}</span>
              </a>
            ) : null}
            {contact.phone ? (
              <a href={`tel:${contact.phone}`} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <Phone className="size-3.5" />
                <span dir="ltr">{contact.phone}</span>
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
