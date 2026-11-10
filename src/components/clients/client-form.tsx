import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createClient, updateClient } from "@/lib/clients";
import { listContacts, saveContacts } from "@/lib/client-contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Textarea } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/overlay";
import type { Client } from "@/lib/types";
import { setEditingActive } from "@/lib/data-events";

type ContactRow = {
  key: string;
  full_name: string;
  role: string;
  email: string;
  phone: string;
};

function emptyContact(): ContactRow {
  return { key: crypto.randomUUID(), full_name: "", role: "", email: "", phone: "" };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ClientForm({
  open,
  onOpenChange,
  client,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  client: Client | null;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [extraEmail, setExtraEmail] = useState("");
  const [company, setCompany] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [notes, setNotes] = useState("");
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEditingActive("client-form", open);
    return () => setEditingActive("client-form", false);
  }, [open]);

  const contactsQ = useQuery({
    queryKey: ["client_contacts", client?.id],
    enabled: open && !!client?.id,
    queryFn: () => listContacts(client!.id),
    staleTime: 60_000,
  });

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(client?.name ?? "");
      setContactName(client?.contact_name ?? "");
      setPhone(client?.phone ?? "");
      setEmail(client?.email ?? "");
      setExtraEmail(client?.extra_email ?? "");
      setCompany(client?.company ?? "");
      setAddress(client?.address ?? "");
      setTaxId(client?.tax_id ?? "");
      setNotes(client?.notes ?? "");
      setContacts([]);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open || !client) return;
    const rows = contactsQ.data ?? [];
    setContacts(
      rows.map((row) => ({
        key: row.id,
        full_name: row.full_name,
        role: row.role ?? "",
        email: row.email ?? "",
        phone: row.phone ?? "",
      })),
    );
  }, [open, client?.id, contactsQ.data]);

  function updateContact(key: string, patch: Partial<ContactRow>) {
    setContacts((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addContact() {
    setContacts((current) => [...current, emptyContact()]);
  }

  function removeContact(key: string) {
    setContacts((current) => current.filter((row) => row.key !== key));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("נא להזין שם לקוח.");
      return;
    }
    if (extraEmail.trim() && !EMAIL_RE.test(extraEmail.trim())) {
      setError("כתובת המייל הנוספת אינה תקינה.");
      return;
    }
    for (const row of contacts) {
      const hasContent = row.full_name.trim() || row.role.trim() || row.email.trim() || row.phone.trim();
      if (!hasContent) continue;
      if (!row.full_name.trim()) {
        setError("נא להזין שם איש קשר לכל שורה עם פרטים.");
        return;
      }
      if (row.email.trim() && !EMAIL_RE.test(row.email.trim())) {
        setError("כתובת המייל של איש הקשר אינה תקינה.");
        return;
      }
    }

    setBusy(true);
    const payload = {
      name: name.trim(),
      contact_name: contactName.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      extra_email: extraEmail.trim() || null,
      company: company.trim() || null,
      address: address.trim() || null,
      tax_id: taxId.trim() || null,
      notes: notes.trim() || null,
    };
    const result = client ? await updateClient(client.id, payload) : await createClient(payload);
    const dbError = result.error;
    const reused = "reused" in result ? result.reused : false;
    const savedId: string | null = client?.id ?? ("id" in result && typeof result.id === "string" ? result.id : null);
    if (dbError) {
      setBusy(false);
      setError(
        dbError.code === "23505"
          ? "לקוח בשם הזה כבר קיים — עדכן את הלקוח הקיים."
          : "לא הצלחנו לשמור את הלקוח. נסה שוב.",
      );
      return;
    }
    if (savedId) {
      const contactsResult = await saveContacts(savedId, contacts);
      if (contactsResult.error) {
        setBusy(false);
        setError("הלקוח נשמר, אבל פרטי הקשר הנוספים לא נשמרו. נסה שוב.");
        return;
      }
    }
    setBusy(false);
    toast.success(client ? "הלקוח עודכן" : reused ? "הלקוח כבר קיים — הפרטים עודכנו" : "הלקוח נוצר");
    queryClient.invalidateQueries({ queryKey: ["clients"] });
    if (savedId) queryClient.invalidateQueries({ queryKey: ["client_contacts", savedId] });
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={client ? "עריכת לקוח" : "לקוח חדש"}
      description="פרטי קשר, אנשי קשר נוספים ופרטי הארגון"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>ביטול</Button>
          <Button type="submit" form="client-form" disabled={busy || (!!client && (contactsQ.isLoading || contactsQ.isError))}>{busy ? "שומר…" : "שמירה"}</Button>
        </div>
      }
    >
      <form id="client-form" onSubmit={save} className="space-y-4">
        <Field label="שם הלקוח" htmlFor="client-name">
          <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: משפחת כהן" className="h-11" />
        </Field>
        <Field label="איש קשר" htmlFor="client-contact">
          <Input id="client-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="שם איש הקשר" className="h-11" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="חברה" htmlFor="client-company">
            <Input id="client-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="שם החברה" className="h-11" />
          </Field>
          <Field label="כתובת" htmlFor="client-address">
            <Input id="client-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="רחוב, עיר" className="h-11" />
          </Field>
        </div>
        <Field label="ח.פ / ת.ז" htmlFor="client-tax-id">
          <Input
            id="client-tax-id"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder="מספר ח.פ או ת.ז (למשל 512345678)"
            inputMode="numeric"
            dir="ltr"
            className="h-11 text-start"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="טלפון" htmlFor="client-phone">
            <Input id="client-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" dir="ltr" className="h-11 text-start" />
          </Field>
          <Field label="אימייל" htmlFor="client-email">
            <Input id="client-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.co.il" dir="ltr" className="h-11 text-start" />
          </Field>
        </div>
        <Field label="הערות" htmlFor="client-notes">
          <Textarea id="client-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="העדפות, היסטוריה, פרטי חיוב" />
        </Field>

        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <p className="mb-2 text-sm font-semibold text-foreground">פרטי קשר נוספים</p>
          {client && contactsQ.isError ? (
            <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              לא ניתן לטעון את פרטי הקשר. סגור ופתח שוב את הטופס.
            </p>
          ) : null}
          <Field label="מייל נוסף" htmlFor="client-extra-email">
            <Input
              id="client-extra-email"
              type="email"
              value={extraEmail}
              onChange={(event) => setExtraEmail(event.target.value)}
              placeholder="another@email.com"
              dir="ltr"
              className="text-start"
            />
          </Field>
          <div className="mt-3 space-y-2">
            {contacts.map((member) => (
              <div key={member.key} className="rounded-lg border border-border bg-card p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">איש קשר נוסף</p>
                  <button
                    type="button"
                    onClick={() => removeContact(member.key)}
                    aria-label="הסרת איש קשר"
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="שם איש קשר" htmlFor={`contact-name-${member.key}`}>
                    <Input id={`contact-name-${member.key}`} value={member.full_name} onChange={(e) => updateContact(member.key, { full_name: e.target.value })} className="h-10" />
                  </Field>
                  <Field label="קשר לאירוע / תפקיד" htmlFor={`contact-role-${member.key}`}>
                    <Input id={`contact-role-${member.key}`} value={member.role} onChange={(e) => updateContact(member.key, { role: e.target.value })} className="h-10" />
                  </Field>
                  <Field label="מייל" htmlFor={`contact-email-${member.key}`}>
                    <Input id={`contact-email-${member.key}`} type="email" value={member.email} onChange={(e) => updateContact(member.key, { email: e.target.value })} dir="ltr" className="h-10 text-start" />
                  </Field>
                  <Field label="טלפון" htmlFor={`contact-phone-${member.key}`}>
                    <Input id={`contact-phone-${member.key}`} value={member.phone} onChange={(e) => updateContact(member.key, { phone: e.target.value })} dir="ltr" className="h-10 text-start" />
                  </Field>
                </div>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={addContact}>
            <Plus className="size-4" /> הוסף איש קשר
          </Button>
        </div>

        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      </form>
    </Dialog>
  );
}
