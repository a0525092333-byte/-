import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, ChevronDown, ChevronUp, Copy, History, ImagePlus, Plus, Printer, Save, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  useClients,
  useCompanySettings,
  useEvents,
  usePriceCatalog,
  useQuote,
  useQuoteImages,
  useQuoteItems,
  useQuoteSections,
  useQuoteVersions,
  useQuotes,
} from "@/hooks/use-data";
import { db } from "@/integrations/neon/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClientPicker } from "@/components/clients/client-picker";
import { clientPickerCopy } from "@/content/client-picker";
import { Field, Select, Textarea } from "@/components/ui/controls";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { ErrorState, isolateLtrText, LtrText, NoAccess, PageHeader, PageSkeleton, SectionCard, stripBidiMarks } from "@/components/shared";
import { dateShort, dateTime, todayISO } from "@/lib/format";
import { fetchQuoteFieldNotes, restoreQuoteVersion, saveQuote } from "@/lib/quote-save";
import { listContacts } from "@/lib/client-contacts";
import { SearchPicker } from "@/components/quotes/search-picker";
import {
  DEFAULT_TERMS,
  computeQuoteTotals,
  lineTotal,
  money0,
  money2,
  nextQuoteNumber,
  quoteTermsText,
} from "@/lib/quotes";
import type { ClientContact, DiscountType, PriceCatalogItem, QuoteItem, QuoteSection, QuoteStatus, QuoteVersion } from "@/lib/types";

type QuoteForm = {
  quote_number: string;
  client_id: string;
  client_name: string;
  client_address: string;
  venue: string;
  event_address: string;
  event_contact_id: string;
  event_contact_name: string;
  event_contact_phone: string;
  subject: string;
  event_id: string;
  event_date: string;
  quote_date: string;
  valid_until: string;
  status: QuoteStatus;
  currency: string;
  discount_type: DiscountType;
  discount_value: string;
  vat_rate: string;
  notes: string;
  termsText: string;
};

type SectionDraft = { id: string; name: string; show_section_totals: boolean };
type ItemDraft = {
  id: string;
  section_id: string | null;
  name: string;
  description: string;
  qty: string;
  unit: string;
  unit_price: string;
  is_optional: boolean;
};

type ImageDraft = { id: string; data_url: string; mime: string; caption: string };

const MAX_QUOTE_IMAGES = 12;
const MAX_IMAGE_BYTES = 400 * 1024;

async function compressQuoteImage(file: File): Promise<{ dataUrl: string; mime: string } | { error: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 1400;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { error: "לא הצלחנו לעבד את התמונה" };
    ctx.drawImage(bitmap, 0, 0, width, height);
    let quality = 0.82;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > MAX_IMAGE_BYTES * 1.37 && quality > 0.4) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > MAX_IMAGE_BYTES * 1.37) {
      return { error: "התמונה גדולה מדי גם לאחר דחיסה — נסה תמונה אחרת" };
    }
    return { dataUrl, mime: "image/jpeg" };
  } catch {
    return { error: "לא הצלחנו לקרוא את התמונה — נסה תמונה אחרת" };
  }
}

function emptyForm(): QuoteForm {
  return {
    quote_number: "",
    client_id: "",
    client_name: "",
    client_address: "",
    venue: "",
    event_address: "",
    event_contact_id: "",
    event_contact_name: "",
    event_contact_phone: "",
    subject: "",
    event_id: "",
    event_date: todayISO(),
    quote_date: todayISO(),
    valid_until: "",
    status: "draft",
    currency: "ILS",
    discount_type: "percent",
    discount_value: "0",
    vat_rate: "18",
    notes: "",
    termsText: DEFAULT_TERMS.join("\n"),
  };
}

export function QuoteBuilder({
  quoteId,
  initialDate,
  initialEventId,
}: {
  quoteId?: string;
  initialDate?: string;
  initialEventId?: string;
}) {
  const { user, can } = useSession();
  const canEdit = can("quotes", "edit");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const quoteQ = useQuote(quoteId);
  const sectionsQ = useQuoteSections(quoteId);
  const itemsQ = useQuoteItems(quoteId);
  const imagesQ = useQuoteImages(quoteId);
  const quotesQ = useQuotes(canEdit);
  const clientsQ = useClients(canEdit || can("clients") || can("quotes"));
  const eventsQ = useEvents(canEdit || can("clients") || can("calendar") || can("quotes"));
  const catalogQ = usePriceCatalog(canEdit);
  const settingsQ = useCompanySettings(true);
  const [form, setForm] = useState<QuoteForm>(() => emptyForm());
  const [sections, setSections] = useState<SectionDraft[]>([]);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [images, setImages] = useState<ImageDraft[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [initialized, setInitialized] = useState(false);
  const [savedId, setSavedId] = useState<string | undefined>(quoteId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventNotice, setEventNotice] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<QuoteVersion | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<QuoteVersion | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [copySourceId, setCopySourceId] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyConfirmOpen, setCopyConfirmOpen] = useState(false);
  const [pendingCopyId, setPendingCopyId] = useState<string | null>(null);
  const versionsQ = useQuoteVersions(savedId, !!savedId);
  const [copyPickerValue, setCopyPickerValue] = useState("");
  const [fieldNotes, setFieldNotes] = useState("");
  const [fieldNotesReady, setFieldNotesReady] = useState(!quoteId);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [newContact, setNewContact] = useState({ full_name: "", phone: "", role: "", email: "" });
  const [contactSaving, setContactSaving] = useState(false);
  const contactsQ = useQuery({
    queryKey: ["client_contacts", form.client_id],
    queryFn: () => listContacts(form.client_id),
    enabled: !!form.client_id,
    retry: 0,
  });
  const fieldNotesQ = useQuery({
    queryKey: ["quote_field_notes", quoteId],
    queryFn: () => fetchQuoteFieldNotes(quoteId as string),
    enabled: !!quoteId && canEdit,
    retry: 1,
    staleTime: 0,
  });
  useEffect(() => {
    if (fieldNotesReady || !quoteId) return;
    if (fieldNotesQ.data !== undefined) {
      setFieldNotes(fieldNotesQ.data);
      setFieldNotesReady(true);
    }
  }, [fieldNotesQ.data, fieldNotesReady, quoteId]);

  useEffect(() => {
    if (initialized) return;
    if (quoteId) {
      if (quoteQ.isLoading || sectionsQ.isLoading || itemsQ.isLoading || imagesQ.isLoading) return;
      const quote = quoteQ.data;
      if (!quote) return;
      setForm({
        quote_number: quote.quote_number,
        client_id: quote.client_id ?? "",
        client_name: quote.client_name,
        client_address: quote.client_address ?? "",
        venue: quote.venue ?? "",
        event_address: quote.event_address ?? "",
        event_contact_id: quote.event_contact_id ?? "",
        event_contact_name: quote.event_contact_name ?? "",
        event_contact_phone: quote.event_contact_phone ?? "",
        subject: quote.subject ?? "",
        event_id: quote.event_id ?? "",
        event_date: quote.event_date ?? todayISO(),
        quote_date: quote.issue_date ?? quote.quote_date ?? todayISO(),
        valid_until: quote.valid_until ?? "",
        status: quote.status,
        currency: quote.currency ?? "ILS",
        discount_type: quote.discount_type === "fixed" ? "amount" : quote.discount_type,
        discount_value: String(quote.discount_value ?? 0),
        vat_rate: String(quote.vat_rate ?? 18),
        notes: quote.notes ?? "",
        termsText: quoteTermsText(quote),
      });
      setSections(
        (sectionsQ.data ?? []).map((section) => ({
          id: section.id,
          name: section.name,
          show_section_totals: section.show_section_totals,
        })),
      );
      setItems(
        (itemsQ.data ?? []).map((item) => ({
          id: item.id,
          section_id: item.section_id,
          name: item.name,
          description: item.description ?? "",
          qty: String(item.qty ?? 1),
          unit: item.unit ?? "",
          unit_price: String(item.unit_price ?? 0),
          is_optional: item.is_optional,
        })),
      );
      setImages(
        (imagesQ.data ?? []).map((image) => ({
          id: String(image.id),
          data_url: image.data_url,
          mime: image.mime,
          caption: image.caption ?? "",
        })),
      );
      setInitialized(true);
      return;
    }
    if (settingsQ.isLoading || quotesQ.isLoading) return;
    // One quote per event: if this event already has a quote, open it for editing
    // instead of starting a second one.
    if (initialEventId) {
      const existingForEvent = (quotesQ.data ?? []).find((item) => item.event_id === initialEventId);
      if (existingForEvent) {
        navigate({ to: "/quotes/$id", params: { id: existingForEvent.id }, replace: true });
        return;
      }
    }
    // Wait for the events/clients lists to finish any in-flight fetch. After an
    // event is created the list cache is stale-but-present, so `isLoading` is
    // false while the refetch is still running — initializing then would miss
    // the brand-new event. `isFetching` covers that window.
    if (initialEventId && (eventsQ.isLoading || eventsQ.isFetching || clientsQ.isLoading || clientsQ.isFetching)) return;
    const settings = settingsQ.data;
    const initialEvent = initialEventId
      ? (eventsQ.data ?? []).find((event) => event.id === initialEventId)
      : undefined;
    const initialClient = initialEvent?.client_id
      ? (clientsQ.data ?? []).find((client) => client.id === initialEvent.client_id)
      : undefined;
    setEventNotice(
      initialEventId && !initialEvent
        ? "האירוע לא נטען — ייתכן שאין הרשאה או שהאירוע נמחק."
        : null,
    );
    const sectionId = crypto.randomUUID();
    setForm({
      ...emptyForm(),
      quote_number: nextQuoteNumber((quotesQ.data ?? []).map((quote) => quote.quote_number), settings?.quote_number_prefix ?? ""),
      vat_rate: String(settings?.default_vat_rate ?? 18),
      notes: settings?.default_notes ?? "",
      termsText: settings?.default_terms_text ?? DEFAULT_TERMS.join("\n"),
      event_id: initialEvent?.id ?? "",
      event_date: initialEvent?.event_date ?? initialDate ?? todayISO(),
      venue: initialEvent?.venue || initialEvent?.title || "",
      event_address: initialEvent?.address || "",
      subject: initialEvent?.title ?? "",
      client_id: initialClient?.id ?? "",
      client_name: initialClient?.name || initialEvent?.title || "",
      client_address: initialClient?.address || initialEvent?.address || "",
    });
    setSections([{ id: sectionId, name: "כללי", show_section_totals: true }]);
    setItems([
      { id: crypto.randomUUID(), section_id: sectionId, name: "", description: "", qty: "1", unit: "", unit_price: "0", is_optional: false },
    ]);
    setInitialized(true);
  }, [
    initialized,
    quoteId,
    quoteQ.isLoading,
    quoteQ.data,
    sectionsQ.isLoading,
    sectionsQ.data,
    itemsQ.isLoading,
    itemsQ.data,
    imagesQ.isLoading,
    imagesQ.data,
    settingsQ.isLoading,
    settingsQ.data,
    quotesQ.isLoading,
    quotesQ.data,
    initialDate,
    initialEventId,
    eventsQ.isLoading,
    eventsQ.isFetching,
    eventsQ.data,
    clientsQ.isLoading,
    clientsQ.isFetching,
    clientsQ.data,
    navigate,
  ]);

  const clients = clientsQ.data ?? [];
  const events = eventsQ.data ?? [];
  const catalog = catalogQ.data ?? [];
  const quotes = quotesQ.data ?? [];
  const copyableQuotes = quotes.filter((item) => item.id !== savedId && item.id !== quoteId);
  const quote = quoteQ.data;
  const settings = settingsQ.data;
  const totals = computeQuoteTotals(
    items.map((item) => ({ qty: Number(item.qty) || 0, unit_price: Number(item.unit_price) || 0 })),
    form.discount_type,
    Number(form.discount_value) || 0,
    Number(form.vat_rate) || 0,
  );
  const filteredCatalog = useMemo(() => {
    const query = catalogSearch.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter((item) =>
      `${item.name} ${item.section ?? ""} ${item.description ?? ""}`.toLowerCase().includes(query),
    );
  }, [catalog, catalogSearch]);

  if (!canEdit) return <NoAccess moduleLabel="מודול הצעות המחיר" />;
  if (quoteId && (quoteQ.isLoading || sectionsQ.isLoading || itemsQ.isLoading)) return <PageSkeleton />;
  if (!quoteId && (settingsQ.isLoading || quotesQ.isLoading)) return <PageSkeleton />;
  if (settingsQ.error) {
    return <ErrorState message="לא הצלחנו לטעון את פרטי החברה. נסה שוב." onRetry={() => settingsQ.refetch()} />;
  }
  if (quotesQ.error) {
    return <ErrorState message="לא הצלחנו לטעון את מספרי ההצעות. נסה שוב." onRetry={() => quotesQ.refetch()} />;
  }
  if (quoteId && (quoteQ.error || sectionsQ.error || itemsQ.error)) {
    return (
      <ErrorState
        message="לא הצלחנו לטעון את ההצעה. נסה שוב."
        onRetry={() => {
          quoteQ.refetch();
          sectionsQ.refetch();
          itemsQ.refetch();
        }}
      />
    );
  }
  if (quoteId && !quoteQ.isLoading && !quoteQ.data) {
    return <ErrorState message="ההצעה לא נמצאה." onRetry={() => quoteQ.refetch()} />;
  }
  if (!initialized) return <PageSkeleton />;

  function updateForm(patch: Partial<QuoteForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function onClientChange(id: string) {
    const client = clients.find((item) => item.id === id);
    setForm((current) => ({
      ...current,
      event_contact_id: current.client_id === id ? current.event_contact_id : "",
      event_contact_name: current.client_id === id ? current.event_contact_name : "",
      event_contact_phone: current.client_id === id ? current.event_contact_phone : "",
      client_id: id,
      client_name: client?.name ?? current.client_name,
      client_address: client?.address ?? current.client_address,
    }));
  }

  async function onImageFiles(files: FileList | null) {
    if (!files?.length) return;
    setImageError(null);
    const remaining = MAX_QUOTE_IMAGES - images.length;
    if (remaining <= 0) {
      setImageError(`אפשר להוסיף עד ${MAX_QUOTE_IMAGES} תמונות להצעה`);
      return;
    }
    const selected = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      setImageError(`אפשר להוסיף עד ${MAX_QUOTE_IMAGES} תמונות להצעה — נוספו ${remaining}`);
    }
    setImageBusy(true);
    const next: ImageDraft[] = [];
    for (const file of selected) {
      const result = await compressQuoteImage(file);
      if ("error" in result) {
        setImageError(result.error);
        continue;
      }
      next.push({ id: crypto.randomUUID(), data_url: result.dataUrl, mime: result.mime, caption: "" });
    }
    setImages((current) => [...current, ...next].slice(0, MAX_QUOTE_IMAGES));
    setImageBusy(false);
  }

  function removeImage(id: string) {
    setImages((current) => current.filter((image) => image.id !== id));
  }

  function updateImageCaption(id: string, caption: string) {
    setImages((current) => current.map((image) => (image.id === id ? { ...image, caption } : image)));
  }

  function moveImage(id: string, direction: -1 | 1) {
    setImages((current) => {
      const index = current.findIndex((image) => image.id === id);
      if (index === -1) return current;
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const contacts: ClientContact[] = contactsQ.data ?? [];
  const defaultSectionId = sections[0]?.id ?? null;

  function targetHasContent() {
    return items.some((item) => item.name.trim() || Number(item.unit_price) > 0);
  }

  // Copies only the line items (and their hidden grouping) from another quote.
  async function applyCopy(sourceId: string) {
    const source = quotes.find((item) => item.id === sourceId);
    if (!source) return;
    setCopyBusy(true);
    const [sectionsRes, itemsRes] = await Promise.all([
      db.from<QuoteSection[]>("quote_sections").select("*").eq("quote_id", sourceId).order("sort_order", { ascending: true }),
      db.from<QuoteItem[]>("quote_items").select("*").eq("quote_id", sourceId).order("sort_order", { ascending: true }),
    ]);
    setCopyBusy(false);
    if (sectionsRes.error || itemsRes.error) {
      toast.error("לא הצלחנו לטעון את ההצעה להעתקה");
      return;
    }
    const sourceSections = sectionsRes.data ?? [];
    const sourceItems = itemsRes.data ?? [];
    const sectionMap = new Map<string, string>();
    const nextSections: SectionDraft[] = sourceSections.map((section) => {
      const id = crypto.randomUUID();
      sectionMap.set(section.id, id);
      return { id, name: section.name, show_section_totals: section.show_section_totals };
    });
    let fallbackSectionId = nextSections[0]?.id ?? null;
    if (!fallbackSectionId) {
      fallbackSectionId = crypto.randomUUID();
      nextSections.push({ id: fallbackSectionId, name: "כללי", show_section_totals: true });
    }
    const nextItems: ItemDraft[] = sourceItems.map((item) => ({
      id: crypto.randomUUID(),
      section_id: item.section_id ? sectionMap.get(item.section_id) ?? fallbackSectionId : fallbackSectionId,
      name: item.name,
      description: item.description ?? "",
      qty: String(item.qty ?? 1),
      unit: item.unit ?? "",
      unit_price: String(item.unit_price ?? 0),
      is_optional: item.is_optional,
    }));
    setSections(nextSections);
    setItems(nextItems);
    setCopySourceId("");
    setCopyPickerValue("");
    toast.success(`הפריטים הועתקו מההצעה ${source.quote_number}`);
  }

  function requestCopy() {
    if (!copySourceId) return;
    if (targetHasContent()) {
      setPendingCopyId(copySourceId);
      setCopyConfirmOpen(true);
      return;
    }
    void applyCopy(copySourceId);
  }

  function addItem() {
    setItems((current) => [
      ...current,
      { id: crypto.randomUUID(), section_id: defaultSectionId, name: "", description: "", qty: "1", unit: "", unit_price: "0", is_optional: false },
    ]);
  }

  function updateItem(id: string, patch: Partial<ItemDraft>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  function openCatalog() {
    setCatalogSearch("");
    setCatalogOpen(true);
  }

  function insertCatalogItem(item: PriceCatalogItem) {
    setItems((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        section_id: defaultSectionId,
        name: item.name,
        description: item.description ?? "",
        qty: "1",
        unit: item.unit ?? "",
        unit_price: String(item.default_price ?? 0),
        is_optional: false,
      },
    ]);
    setCatalogOpen(false);
    setCatalogSearch("");
    toast.success("הפריט נוסף להצעה");
  }

  function chooseContact(contactId: string) {
    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) {
      updateForm({ event_contact_id: "" });
      return;
    }
    updateForm({
      event_contact_id: contact.id,
      event_contact_name: contact.full_name,
      event_contact_phone: contact.phone ?? "",
    });
  }

  async function addContact() {
    const fullName = newContact.full_name.trim();
    if (!fullName) {
      toast.error("נא להזין שם איש קשר");
      return;
    }
    if (!form.client_id) {
      updateForm({ event_contact_id: "", event_contact_name: fullName, event_contact_phone: newContact.phone.trim() });
      setContactDialogOpen(false);
      setNewContact({ full_name: "", phone: "", role: "", email: "" });
      return;
    }
    setContactSaving(true);
    const id = crypto.randomUUID();
    const { error: insertError } = await db.from("client_contacts").insert({
      id,
      client_id: form.client_id,
      full_name: fullName,
      phone: newContact.phone.trim() || null,
      role: newContact.role.trim() || null,
      email: newContact.email.trim() || null,
      sort_order: contacts.length,
    });
    setContactSaving(false);
    if (insertError) {
      // No permission to edit clients → keep the person as free text on this quote.
      updateForm({ event_contact_id: "", event_contact_name: fullName, event_contact_phone: newContact.phone.trim() });
      toast.error("לא ניתן היה לשמור את איש הקשר ברשימת הלקוח — הוא נשמר בהצעה זו בלבד");
    } else {
      await queryClient.invalidateQueries({ queryKey: ["client_contacts", form.client_id] });
      updateForm({ event_contact_id: id, event_contact_name: fullName, event_contact_phone: newContact.phone.trim() });
      toast.success("איש הקשר נוסף לרשימת הלקוח");
    }
    setContactDialogOpen(false);
    setNewContact({ full_name: "", phone: "", role: "", email: "" });
  }

  // The single "עדכון" button performs every step at once: it saves all fields and
  // approves the quote (approval unlocks event creation from the quote).
  // A rejected / cancelled quote keeps its status.
  function updateStatus(current: QuoteStatus): QuoteStatus {
    return current === "rejected" || current === "cancelled" ? current : "approved";
  }

  async function save(status: QuoteStatus) {
    setError(null);
    if (!form.quote_number.trim()) {
      setError("נא להזין מספר הצעה.");
      return;
    }
    if (!form.client_name.trim()) {
      setError("נא להזין שם לקוח.");
      return;
    }
    setSaving(true);
    const id = savedId ?? crypto.randomUUID();
    const payload = {
      quote_number: form.quote_number.trim(),
      client_id: form.client_id || null,
      client_name: form.client_name.trim(),
      client_address: form.client_address.trim() || null,
      venue: form.venue.trim() || null,
      event_address: form.event_address.trim() || null,
      event_contact_id: form.event_contact_id || null,
      event_contact_name: form.event_contact_name.trim() || null,
      event_contact_phone: form.event_contact_phone.trim() || null,
      subject: form.subject.trim() || null,
      event_id: form.event_id || null,
      event_date: form.event_date || null,
      quote_date: form.quote_date || todayISO(),
      issue_date: form.quote_date || todayISO(),
      valid_until: form.valid_until || null,
      print_date: todayISO(),
      currency: form.currency || "ILS",
      status,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value) || 0,
      vat_rate: Number(form.vat_rate) || 0,
      notes: form.notes.trim() || null,
      terms: form.termsText.split("\n").map((term) => term.trim()).filter(Boolean),
      terms_text: form.termsText.trim() || null,
      subtotal: totals.subtotal,
      discount_amount: totals.discountAmount,
      total_before_vat: totals.afterDiscount,
      vat_amount: totals.vatAmount,
      grand_total: totals.grandTotal,
    };
    const sectionRows = sections.map((section, index) => ({
      id: section.id,
      name: section.name.trim() || "סעיף",
      sort_order: index,
      show_section_totals: section.show_section_totals,
    }));
    const itemRows = items.map((item, index) => ({
      id: item.id,
      section_id: item.section_id,
      sort_order: index,
      name: item.name.trim() || "פריט",
      description: item.description.trim() || null,
      qty: Number(item.qty) || 0,
      quantity: Number(item.qty) || 0,
      unit: item.unit.trim() || null,
      unit_price: Number(item.unit_price) || 0,
      line_total: lineTotal({ qty: Number(item.qty) || 0, unit_price: Number(item.unit_price) || 0 }),
      is_optional: item.is_optional,
    }));
    const imageRows = images.map((image, index) => ({
      position: index,
      mime: image.mime,
      data_url: image.data_url,
      caption: image.caption.trim() || null,
    }));
    const result = await saveQuote({
      quote: { id, ...payload },
      sections: sectionRows,
      items: itemRows,
      images: imageRows,
      // Only send the crew notes once they were loaded, so a failed load never wipes them.
      ...(fieldNotesReady ? { fieldNotes } : {}),
    });
    setSaving(false);
    if (!result.ok) {
      if (result.error === "event_has_quote" && result.existingId) {
        toast.error("לאירוע זה כבר קיימת הצעת מחיר — נפתחת ההצעה הקיימת");
        navigate({ to: "/quotes/$id", params: { id: result.existingId }, replace: true });
        return;
      }
      setError(result.message);
      return;
    }
    if (!savedId) setSavedId(id);
    queryClient.invalidateQueries({ queryKey: ["quotes"] });
    queryClient.invalidateQueries({ queryKey: ["quote", id] });
    queryClient.invalidateQueries({ queryKey: ["quote_sections", id] });
    queryClient.invalidateQueries({ queryKey: ["quote_items", id] });
    queryClient.invalidateQueries({ queryKey: ["quote_images", id] });
    queryClient.invalidateQueries({ queryKey: ["quote_versions", id] });
    queryClient.invalidateQueries({ queryKey: ["quote_field_notes", id] });
    toast.success(savedId ? "ההצעה עודכנה — המצב הקודם נשמר בהיסטוריית הגרסאות" : "ההצעה נשמרה");
    navigate({ to: "/quotes/$id/print", params: { id } });
  }

  async function duplicateCurrent() {
    if (!savedId) return;
    setSaving(true);
    const newId = crypto.randomUUID();
    const newNumber = nextQuoteNumber(quotes.map((quote) => quote.quote_number), settings?.quote_number_prefix ?? "");
    const { error } = await db.from("quotes").insert({
      id: newId,
      quote_number: newNumber,
      client_id: form.client_id || null,
      client_name: form.client_name.trim(),
      client_address: form.client_address.trim() || null,
      venue: form.venue.trim() || null,
      event_address: form.event_address.trim() || null,
      event_contact_id: form.event_contact_id || null,
      event_contact_name: form.event_contact_name.trim() || null,
      event_contact_phone: form.event_contact_phone.trim() || null,
      subject: form.subject.trim() || null,
      event_id: null,
      event_date: form.event_date || null,
      quote_date: todayISO(),
      issue_date: todayISO(),
      valid_until: form.valid_until || null,
      print_date: todayISO(),
      currency: form.currency || "ILS",
      status: "draft",
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value) || 0,
      vat_rate: Number(form.vat_rate) || 0,
      notes: form.notes.trim() || null,
      terms: form.termsText.split("\n").map((term) => term.trim()).filter(Boolean),
      terms_text: form.termsText.trim() || null,
      subtotal: totals.subtotal,
      discount_amount: totals.discountAmount,
      total_before_vat: totals.afterDiscount,
      vat_amount: totals.vatAmount,
      grand_total: totals.grandTotal,
      created_by: user?.id ?? null,
    });
    if (error) {
      setSaving(false);
      toast.error("לא הצלחנו לשכפל את ההצעה");
      return;
    }
    const sectionMap = new Map<string, string>();
    const newSections = sections.map((section, index) => {
      const sectionId = crypto.randomUUID();
      sectionMap.set(section.id, sectionId);
      return {
        id: sectionId,
        quote_id: newId,
        name: section.name,
        sort_order: index,
        show_section_totals: section.show_section_totals,
      };
    });
    if (newSections.length) {
      const { error: sectionError } = await db.from("quote_sections").insert(newSections);
      if (sectionError) {
        setSaving(false);
        toast.error("לא הצלחנו לשכפל את ההצעה");
        return;
      }
    }
    const newItems = items.map((item, index) => ({
      id: crypto.randomUUID(),
      quote_id: newId,
      section_id: item.section_id ? sectionMap.get(item.section_id) ?? null : null,
      sort_order: index,
      name: item.name,
      description: item.description,
      qty: Number(item.qty) || 0,
      quantity: Number(item.qty) || 0,
      unit: item.unit,
      unit_price: Number(item.unit_price) || 0,
      line_total: lineTotal({ qty: Number(item.qty) || 0, unit_price: Number(item.unit_price) || 0 }),
      is_optional: item.is_optional,
    }));
    if (newItems.length) {
      const { error: itemError } = await db.from("quote_items").insert(newItems);
      if (itemError) {
        setSaving(false);
        toast.error("לא הצלחנו לשכפל את ההצעה");
        return;
      }
    }
    setSaving(false);
    toast.success("ההצעה שוכפלה כהצעה עצמאית ללא שיוך לאירוע");
    queryClient.invalidateQueries({ queryKey: ["quotes"] });
    navigate({ to: "/quotes/$id", params: { id: newId } });
  }

  async function confirmRestore() {
    if (!restoreTarget || !savedId) return;
    setRestoring(true);
    const result = await restoreQuoteVersion(savedId, restoreTarget.id);
    if (!result.ok) {
      setRestoring(false);
      toast.error(result.message);
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["quote", savedId] }),
      queryClient.invalidateQueries({ queryKey: ["quote_sections", savedId] }),
      queryClient.invalidateQueries({ queryKey: ["quote_items", savedId] }),
      queryClient.invalidateQueries({ queryKey: ["quote_versions", savedId] }),
    ]);
    setRestoring(false);
    setRestoreTarget(null);
    setPreviewVersion(null);
    setVersionsOpen(false);
    setInitialized(false);
    toast.success("הגרסה שוחזרה — המצב הקודם נשמר כגרסה חדשה");
  }

  function printCurrent() {
    if (savedId) navigate({ to: "/quotes/$id/print", params: { id: savedId } });
  }

  return (
    <div>
      <PageHeader
        title={quoteId ? "עריכת הצעת מחיר" : "הצעת מחיר חדשה"}
        description="לקוח, אירוע, פריטים ומחירים"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/quotes">חזרה להצעות</Link>
            </Button>
            {savedId ? (
              <Button type="button" variant="outline" onClick={printCurrent}>
                <Printer className="size-4" /> הדפסה / PDF
              </Button>
            ) : null}
            {savedId ? (
              <Button type="button" variant="outline" onClick={() => setVersionsOpen(true)}>
                <History className="size-4" /> גרסאות
              </Button>
            ) : null}
            {savedId ? (
              <Button type="button" variant="outline" onClick={duplicateCurrent} disabled={saving || quotesQ.isLoading}>
                <Copy className="size-4" /> שכפול
              </Button>
            ) : null}
            <Button type="button" onClick={() => save(updateStatus(form.status))} disabled={saving}>
              <Save className="size-4" /> {saving ? "שומר…" : "עדכון"}
            </Button>
          </div>
        }
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {eventNotice ? (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {eventNotice}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <h2 className="text-lg font-bold text-foreground">פרטי ההצעה</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="quote-number" className="text-sm font-medium text-muted-foreground">
            מספר הצעה
          </label>
          <Input
            id="quote-number"
            value={form.quote_number}
            onChange={(e) => updateForm({ quote_number: e.target.value })}
            dir="ltr"
            className="num h-10 w-32 text-center text-base font-bold"
          />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <div className="grid gap-5 md:grid-cols-2">
            <SectionCard title="פרטי לקוח" description="שם, כתובת ותאריכי ההצעה">
              <div className="grid gap-3">
                <Field label="בחירה מרשימת הלקוחות" htmlFor="quote-client">
                  <ClientPicker id="quote-client" clients={clients} value={form.client_id} onChange={onClientChange} emptyLabel={clientPickerCopy.manual} />
                </Field>
                <Field label="שם לקוח" htmlFor="quote-client-name">
                  <Input id="quote-client-name" value={form.client_name} onChange={(e) => updateForm({ client_name: e.target.value })} className="h-11" />
                </Field>
                <Field label="כתובת" htmlFor="quote-client-address">
                  <Input id="quote-client-address" value={form.client_address} onChange={(e) => updateForm({ client_address: e.target.value })} className="h-11" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="תאריך הצעה" htmlFor="quote-date">
                    <Input id="quote-date" type="date" value={form.quote_date} onChange={(e) => updateForm({ quote_date: e.target.value })} className="h-11" />
                  </Field>
                  <Field label="תוקף הצעה" htmlFor="quote-valid-until">
                    <Input id="quote-valid-until" type="date" value={form.valid_until} onChange={(e) => updateForm({ valid_until: e.target.value })} className="h-11" />
                  </Field>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="פרטי אירוע" description="מקום, כתובת, תאריך ואיש קשר בשטח">
              <div className="grid gap-3">
                <Field label="מקום האירוע" htmlFor="quote-venue">
                  <Input id="quote-venue" value={form.venue} onChange={(e) => updateForm({ venue: e.target.value })} className="h-11" />
                </Field>
                <Field label="כתובת האירוע" htmlFor="quote-event-address">
                  <Input id="quote-event-address" value={form.event_address} onChange={(e) => updateForm({ event_address: e.target.value })} className="h-11" />
                </Field>
                <Field label="תאריך האירוע" htmlFor="quote-event-date">
                  <Input id="quote-event-date" type="date" value={form.event_date} onChange={(e) => updateForm({ event_date: e.target.value })} className="h-11" />
                </Field>
                <Field label="איש קשר מטעם הלקוח באירוע" htmlFor="quote-contact-picker">
                  {form.client_id ? (
                    <SearchPicker
                      id="quote-contact-picker"
                      options={contacts.map((contact) => ({
                        id: contact.id,
                        label: contact.full_name,
                        sub: [contact.role, contact.phone].filter(Boolean).join(" · ") || null,
                        search: contact.email ?? "",
                      }))}
                      value={form.event_contact_id}
                      onChange={chooseContact}
                      placeholder="חיפוש איש קשר מרשימת הלקוח"
                      emptyText={contactsQ.isLoading ? "טוען אנשי קשר…" : contactsQ.isError ? "לא הצלחנו לטעון את אנשי הקשר" : "אין אנשי קשר תואמים — אפשר להוסיף חדש"}
                      ariaLabel="בחירת איש קשר מרשימת הלקוח"
                      displayValue={form.event_contact_id ? form.event_contact_name : ""}
                    />
                  ) : (
                    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                      בחר לקוח מהרשימה כדי לבחור מתוך אנשי הקשר שלו, או הקלד ידנית למטה.
                    </p>
                  )}
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="שם איש הקשר" htmlFor="quote-contact-name">
                    <Input
                      id="quote-contact-name"
                      value={form.event_contact_name}
                      onChange={(e) => updateForm({ event_contact_name: e.target.value, event_contact_id: "" })}
                      className="h-11"
                    />
                  </Field>
                  <Field label="טלפון" htmlFor="quote-contact-phone">
                    <Input
                      id="quote-contact-phone"
                      type="tel"
                      dir="ltr"
                      inputMode="tel"
                      value={form.event_contact_phone}
                      onChange={(e) => updateForm({ event_contact_phone: e.target.value })}
                      className="h-11 text-start"
                    />
                  </Field>
                </div>
                <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setContactDialogOpen(true)}>
                  <UserPlus className="size-4" /> הוספת איש קשר חדש
                </Button>
              </div>
            </SectionCard>
          </div>

          <SectionCard title="העתקה מהצעה קיימת" description="העתקת הפריטים מהצעת מחיר קיימת להצעה הזו">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <Field label="הצעת מחיר קיימת" htmlFor="quote-copy-source">
                  <SearchPicker
                    id="quote-copy-source"
                    options={copyableQuotes.map((item) => ({
                      id: item.id,
                      label: `${item.quote_number} · ${item.client_name}`,
                      sub: `${item.event_date ? dateShort(item.event_date) : "—"} · ${money0(item.grand_total)}${item.venue ? ` · ${item.venue}` : ""}`,
                      search: [item.subject, item.venue].filter(Boolean).join(" "),
                    }))}
                    value={copyPickerValue}
                    onChange={(id) => {
                      setCopyPickerValue(id);
                      setCopySourceId(id);
                    }}
                    placeholder="חיפוש לפי מספר הצעה, לקוח או מקום"
                    emptyText="לא נמצאו הצעות"
                    ariaLabel="בחירת הצעה להעתקה"
                  />
                </Field>
              </div>
              <Button type="button" variant="outline" className="h-11" disabled={!copySourceId || copyBusy} onClick={requestCopy}>
                <Copy className="size-4" /> {copyBusy ? "מעתיק…" : "העתק פריטים"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">מועתקים הפריטים בלבד. פרטי הלקוח, האירוע והמחירים הכלליים של ההצעה הזו לא משתנים.</p>
          </SectionCard>

          <SectionCard title="פריטים" description="שם פריט, מחיר, כמות וסה״כ לשורה">
            <div className="space-y-3">
              {items.map((item, index) => (
                <div key={item.id} className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-start gap-2">
                    <span className="num mt-3 w-5 shrink-0 text-center text-xs font-semibold text-muted-foreground" aria-hidden="true">
                      {index + 1}
                    </span>
                    <Textarea
                      value={isolateLtrText(item.name)}
                      onChange={(e) => updateItem(item.id, { name: stripBidiMarks(e.target.value).replace(/\s*\n+\s*/g, " ") })}
                      placeholder="שם הפריט"
                      rows={2}
                      className="min-h-20 flex-1 resize-y text-base sm:min-h-11"
                      aria-label={`שם הפריט ${index + 1}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 text-muted-foreground hover:bg-red-50 hover:text-red-700"
                      onClick={() => removeItem(item.id)}
                      aria-label={`מחיקת שורה ${index + 1}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    value={isolateLtrText(item.description)}
                    onChange={(e) => updateItem(item.id, { description: stripBidiMarks(e.target.value) })}
                    placeholder="פירוט (לא חובה — כל שורה תודפס כנקודה)"
                    className="mt-2 min-h-12 text-sm"
                    aria-label={`פירוט פריט ${index + 1}`}
                  />
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Field label="מחיר ליחידה" htmlFor={`price-${item.id}`}>
                      <Input id={`price-${item.id}`} type="number" min="0" step="any" inputMode="decimal" value={item.unit_price} onChange={(e) => updateItem(item.id, { unit_price: e.target.value })} className="h-11" />
                    </Field>
                    <Field label="כמות" htmlFor={`qty-${item.id}`}>
                      <Input id={`qty-${item.id}`} type="number" min="0" step="any" inputMode="decimal" value={item.qty} onChange={(e) => updateItem(item.id, { qty: e.target.value })} className="h-11" />
                    </Field>
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">סה״כ</p>
                      <p className="num flex h-11 items-center text-sm font-semibold text-foreground">
                        {money2(lineTotal({ qty: Number(item.qty) || 0, unit_price: Number(item.unit_price) || 0 }))}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
              {!items.length ? (
                <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">אין עדיין פריטים בהצעה.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={addItem}>
                  <Plus className="size-4" /> הוסף שורה
                </Button>
                <Button type="button" variant="outline" onClick={openCatalog}>
                  <BookOpen className="size-4" /> בחר מהמחירון
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="תמונות להצעה" description="התמונות יופיעו בהדפסה ובקובץ ה-PDF שנשלח ללקוח">
            <div className="space-y-3">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  onImageFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={imageBusy || images.length >= MAX_QUOTE_IMAGES}
                >
                  <ImagePlus className="size-4" /> {imageBusy ? "מעבד…" : "הוספת תמונות"}
                </Button>
                <span className="text-xs text-muted-foreground">{images.length}/{MAX_QUOTE_IMAGES} תמונות</span>
              </div>
              {images.length >= MAX_QUOTE_IMAGES ? (
                <p className="text-xs text-amber-700">הגעת למגבלת {MAX_QUOTE_IMAGES} התמונות להצעה.</p>
              ) : null}
              {imageError ? (
                <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{imageError}</p>
              ) : null}
              {images.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {images.map((image, index) => (
                    <div key={image.id} className="rounded-lg border border-border bg-muted/30 p-2">
                      <div className="relative">
                        <img src={image.data_url} alt={image.caption || `תמונה ${index + 1}`} className="h-28 w-full rounded object-contain" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute end-1 top-1 size-8 bg-background/80 text-red-700 hover:bg-red-50"
                          onClick={() => removeImage(image.id)}
                          aria-label={`הסרת תמונה ${index + 1}`}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                      <Input
                        value={image.caption}
                        onChange={(e) => updateImageCaption(image.id, e.target.value)}
                        placeholder="כיתוב (לא חובה)"
                        className="mt-2 h-9 text-xs"
                        aria-label={`כיתוב לתמונה ${index + 1}`}
                      />
                      <div className="mt-1 flex items-center justify-between">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => moveImage(image.id, -1)}
                          disabled={index === 0}
                          aria-label={`הזזת תמונה ${index + 1} למעלה`}
                        >
                          <ChevronUp className="size-4" />
                        </Button>
                        <span className="text-[10px] text-muted-foreground">{index + 1}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => moveImage(image.id, 1)}
                          disabled={index === images.length - 1}
                          aria-label={`הזזת תמונה ${index + 1} למטה`}
                        >
                          <ChevronDown className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">אין עדיין תמונות בהצעה.</p>
              )}
            </div>
          </SectionCard>

          <SectionCard title="הערות ותנאים" description="ההערות והתנאים יודפסו בהצעה">
            <div className="space-y-4">
              <Field label="הערות" htmlFor="quote-notes" hint="כל שורה תודפס כנקודה">
                <Textarea id="quote-notes" value={form.notes} onChange={(e) => updateForm({ notes: e.target.value })} className="min-h-28" />
              </Field>
              <Field label="תנאים / הסכם" htmlFor="quote-terms" hint="שורה אחת לכל תנאי">
                <Textarea id="quote-terms" value={form.termsText} onChange={(e) => updateForm({ termsText: e.target.value })} className="min-h-32" />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="הערות לצוות שטח ומחסנאי" description="פנימי — מופיע רק בדוח האירוע, לא בהצעת המחיר ולא נשלח ללקוח">
            {quoteId && !fieldNotesReady && fieldNotesQ.isError ? (
              <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                לא הצלחנו לטעון את ההערות הקיימות — הן לא יידרסו בשמירה.
                <Button type="button" variant="outline" size="sm" onClick={() => fieldNotesQ.refetch()}>
                  נסה שוב
                </Button>
              </div>
            ) : null}
            <Field label="הערות פנימיות" htmlFor="quote-field-notes">
              <Textarea
                id="quote-field-notes"
                value={fieldNotes}
                onChange={(e) => setFieldNotes(e.target.value)}
                disabled={!fieldNotesReady}
                placeholder={fieldNotesReady ? "לדוגמה: כניסה מהחניה האחורית, להביא כבל 30 מ׳, פריקה עד 14:00" : "טוען…"}
                className="min-h-28"
              />
            </Field>
          </SectionCard>
        </div>

        <div className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          <SectionCard title="סיכום" description="מתעדכן בזמן אמת">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">סך הכול לפני הנחה</span>
                <span className="num font-medium">{money2(totals.subtotal)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="סוג הנחה" htmlFor="discount-type">
                  <Select id="discount-type" value={form.discount_type} onChange={(e) => updateForm({ discount_type: e.target.value as DiscountType })}>
                    <option value="percent">אחוז</option>
                    <option value="amount">סכום ₪</option>
                  </Select>
                </Field>
                <Field label="הנחה" htmlFor="discount-value">
                  <Input id="discount-value" type="number" min="0" step="any" inputMode="decimal" value={form.discount_value} onChange={(e) => updateForm({ discount_value: e.target.value })} className="h-11" />
                </Field>
              </div>
              {totals.discountAmount > 0 ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">הנחה</span>
                  <span className="num font-medium">{money2(totals.discountAmount)}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span className="text-muted-foreground">מחיר לפני מע״מ</span>
                <span className="num font-medium">{money2(totals.afterDiscount)}</span>
              </div>
              <Field label="מע״מ %" htmlFor="vat-rate">
                <Input id="vat-rate" type="number" min="0" step="any" inputMode="decimal" value={form.vat_rate} onChange={(e) => updateForm({ vat_rate: e.target.value })} className="h-11" />
              </Field>
              <div className="flex justify-between">
                <span className="text-muted-foreground">מע״מ</span>
                <span className="num font-medium">{money2(totals.vatAmount)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-3 text-base">
                <span className="font-semibold">סה״כ לתשלום</span>
                <span className="num font-bold text-primary">{money0(totals.grandTotal)}</span>
              </div>
            </div>
            <Button type="button" className="mt-4 h-12 w-full text-base" onClick={() => save(updateStatus(form.status))} disabled={saving}>
              <Save className="size-4" /> {saving ? "שומר…" : "עדכון"}
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">שומר את כל הפרטים, הפריטים, איש הקשר וההערות בפעולה אחת</p>
          </SectionCard>
        </div>
      </div>

      <Dialog
        open={contactDialogOpen}
        onOpenChange={(open) => {
          if (!contactSaving) setContactDialogOpen(open);
        }}
        title="איש קשר חדש"
        description={form.client_id ? "יתווסף לרשימת אנשי הקשר של הלקוח וייבחר לאירוע" : "יישמר בהצעה זו (לא נבחר לקוח מהרשימה)"}
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setContactDialogOpen(false)} disabled={contactSaving}>
              ביטול
            </Button>
            <Button type="button" onClick={addContact} disabled={contactSaving}>
              {contactSaving ? "שומר…" : "הוספה"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3">
          <Field label="שם מלא" htmlFor="new-contact-name">
            <Input id="new-contact-name" value={newContact.full_name} onChange={(e) => setNewContact((c) => ({ ...c, full_name: e.target.value }))} className="h-11" />
          </Field>
          <Field label="טלפון" htmlFor="new-contact-phone">
            <Input id="new-contact-phone" type="tel" dir="ltr" inputMode="tel" value={newContact.phone} onChange={(e) => setNewContact((c) => ({ ...c, phone: e.target.value }))} className="h-11 text-start" />
          </Field>
          <Field label="תפקיד" htmlFor="new-contact-role">
            <Input id="new-contact-role" value={newContact.role} onChange={(e) => setNewContact((c) => ({ ...c, role: e.target.value }))} placeholder="לדוגמה: מנהל שטח" className="h-11" />
          </Field>
          <Field label="אימייל" htmlFor="new-contact-email">
            <Input id="new-contact-email" type="email" dir="ltr" value={newContact.email} onChange={(e) => setNewContact((c) => ({ ...c, email: e.target.value }))} className="h-11 text-start" />
          </Field>
        </div>
      </Dialog>

      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen} title="בחירה מהמחירון" description="פריטים עם מחיר ברירת מחדל" size="lg">
        <div className="space-y-3">
          <Input value={catalogSearch} onChange={(e) => setCatalogSearch(e.target.value)} placeholder="חיפוש פריט, סעיף או תיאור" className="h-11" />
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {filteredCatalog.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => insertCatalogItem(item)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-start hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.section || "כללי"} · {item.unit || "יח׳"}</p>
                </div>
                <span className="num shrink-0 text-sm font-semibold text-foreground">{money2(item.default_price)}</span>
              </button>
            ))}
            {!filteredCatalog.length ? (
              <p className="py-6 text-center text-sm text-muted-foreground">לא נמצאו פריטים במחירון.</p>
            ) : null}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={versionsOpen}
        onOpenChange={(open) => {
          setVersionsOpen(open);
          if (!open) setPreviewVersion(null);
        }}
        title="היסטוריית גרסאות"
        description="נשמרת אוטומטית לפני כל עדכון של ההצעה"
        size="lg"
      >
        <div className="space-y-3">
          {versionsQ.isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">טוען גרסאות…</p>
          ) : versionsQ.error ? (
            <p className="py-6 text-center text-sm text-red-700">לא הצלחנו לטעון את הגרסאות. נסה שוב.</p>
          ) : !(versionsQ.data ?? []).length ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
              <History className="mx-auto mb-2 size-6 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">אין עדיין גרסאות</p>
              <p className="mt-1 text-sm text-muted-foreground">ברגע שתעדכנו את ההצעה, המצב הקודם יישמר כאן אוטומטית.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {(versionsQ.data ?? []).map((version) => (
                <li key={version.id}>
                  <button
                    type="button"
                    onClick={() => setPreviewVersion(version)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-start hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">גרסה {version.version_number}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {dateTime(version.created_at)}
                        {version.label ? ` · ${version.label}` : ""}
                      </p>
                    </div>
                    <span className="num shrink-0 text-sm font-semibold text-foreground">{money0(version.total)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      <Dialog
        open={!!previewVersion}
        onOpenChange={(open) => {
          if (!open) setPreviewVersion(null);
        }}
        title={previewVersion ? `גרסה ${previewVersion.version_number} — תצוגה מקדימה` : "תצוגה מקדימה"}
        description={previewVersion ? dateTime(previewVersion.created_at) : undefined}
        size="lg"
        footer={
          previewVersion ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setPreviewVersion(null)}>
                סגירה
              </Button>
              <Button type="button" onClick={() => setRestoreTarget(previewVersion)}>
                שחזר גרסה זו
              </Button>
            </div>
          ) : null
        }
      >
        {previewVersion ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium text-foreground">{previewVersion.snapshot?.quote?.client_name || "ללא לקוח"}</p>
              <p className="text-muted-foreground">
                הצעה {previewVersion.snapshot?.quote?.quote_number || "—"}
                {previewVersion.snapshot?.quote?.event_date ? ` · ${previewVersion.snapshot.quote.event_date}` : ""}
              </p>
            </div>
            <div className="space-y-2">
              {(previewVersion.snapshot?.items ?? []).map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3 border-b border-border pb-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground"><LtrText>{item.name}</LtrText></p>
                    {item.description ? <p className="truncate text-xs text-muted-foreground"><LtrText>{item.description}</LtrText></p> : null}
                    <p className="text-xs text-muted-foreground">
                      {item.qty} × {money2(item.unit_price)}
                    </p>
                  </div>
                  <span className="num shrink-0 font-medium text-foreground">{money2(item.line_total ?? item.qty * item.unit_price)}</span>
                </div>
              ))}
              {!(previewVersion.snapshot?.items ?? []).length ? (
                <p className="py-4 text-center text-sm text-muted-foreground">אין פריטים בגרסה זו.</p>
              ) : null}
            </div>
            <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">סך הכול לפני הנחה</span>
                <span className="num">{money2(previewVersion.snapshot?.quote?.subtotal)}</span>
              </div>
              {Number(previewVersion.snapshot?.quote?.discount_amount) > 0 ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">הנחה</span>
                  <span className="num">{money2(previewVersion.snapshot?.quote?.discount_amount)}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span className="text-muted-foreground">מע״מ</span>
                <span className="num">{money2(previewVersion.snapshot?.quote?.vat_amount)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1.5 text-base">
                <span className="font-semibold">סה״כ לתשלום</span>
                <span className="num font-bold text-primary">{money0(previewVersion.snapshot?.quote?.grand_total ?? previewVersion.total)}</span>
              </div>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open && !restoring) setRestoreTarget(null);
        }}
        title="שחזור גרסה"
        description={restoreTarget ? `גרסה ${restoreTarget.version_number}` : undefined}
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRestoreTarget(null)} disabled={restoring}>
              ביטול
            </Button>
            <Button type="button" onClick={confirmRestore} disabled={restoring}>
              {restoring ? "משחזר…" : "שחזר גרסה זו"}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-foreground">
          המצב הנוכחי של ההצעה יישמר אוטומטית כגרסה חדשה, ואז תוחל הגרסה הנבחרת. הפעולה אינה מוחקת נתונים.
        </p>
      </Dialog>

      <ConfirmDialog
        open={copyConfirmOpen}
        onOpenChange={(open) => {
          setCopyConfirmOpen(open);
          if (!open) setPendingCopyId(null);
        }}
        title="להחליף את התוכן הקיים?"
        description="בהצעה הזו כבר יש פריטים. ההעתקה תחליף אותם בפריטים של ההצעה הנבחרת. ההצעה המקורית לא משתנה."
        confirmLabel="החלף תוכן"
        busy={copyBusy}
        onConfirm={() => {
          const sourceId = pendingCopyId;
          setCopyConfirmOpen(false);
          setPendingCopyId(null);
          if (sourceId) void applyCopy(sourceId);
        }}
      />
    </div>
  );
}
