import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  History,
  ImagePlus,
  Plus,
  Printer,
  Save,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
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
import { ErrorState, isolateLtrText, LtrText, NoAccess, PageHeader, PageSkeleton, stripBidiMarks } from "@/components/shared";
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
  const quickNameRef = useRef<HTMLInputElement>(null);
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
  const [copyBarOpen, setCopyBarOpen] = useState(false);
  const versionsQ = useQuoteVersions(savedId, !!savedId);
  const [copyPickerValue, setCopyPickerValue] = useState("");
  const [fieldNotes, setFieldNotes] = useState("");
  const [fieldNotesReady, setFieldNotesReady] = useState(!quoteId);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [newContact, setNewContact] = useState({ full_name: "", phone: "", role: "", email: "" });
  const [contactSaving, setContactSaving] = useState(false);
  const [expandedDescIds, setExpandedDescIds] = useState<Record<string, boolean>>({});
  const [quickDraft, setQuickDraft] = useState({ name: "", unit_price: "", qty: "1", description: "" });

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
      const loadedItems = (itemsQ.data ?? []).map((item) => ({
        id: item.id,
        section_id: item.section_id,
        name: item.name,
        description: item.description ?? "",
        qty: String(item.qty ?? 1),
        unit: item.unit ?? "",
        unit_price: String(item.unit_price ?? 0),
        is_optional: item.is_optional,
      }));
      setItems(loadedItems);
      const initialExpanded: Record<string, boolean> = {};
      for (const it of loadedItems) {
        if (it.description.trim()) initialExpanded[it.id] = true;
      }
      setExpandedDescIds(initialExpanded);
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
    if (initialEventId) {
      const existingForEvent = (quotesQ.data ?? []).find((item) => item.event_id === initialEventId);
      if (existingForEvent) {
        navigate({ to: "/quotes/$id", params: { id: existingForEvent.id }, replace: true });
        return;
      }
    }
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
    setItems([]);
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
  const catalog = catalogQ.data ?? [];
  const quotes = quotesQ.data ?? [];
  const copyableQuotes = quotes.filter((item) => item.id !== savedId && item.id !== quoteId);
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
    const nextExp: Record<string, boolean> = {};
    for (const it of nextItems) {
      if (it.description.trim()) nextExp[it.id] = true;
    }
    setExpandedDescIds(nextExp);
    setSections(nextSections);
    setItems(nextItems);
    setCopySourceId("");
    setCopyPickerValue("");
    setCopyBarOpen(false);
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

  function commitQuickDraft() {
    const cleanName = stripBidiMarks(quickDraft.name).trim();
    if (!cleanName && !(Number(quickDraft.unit_price) > 0)) {
      quickNameRef.current?.focus();
      return;
    }
    const newId = crypto.randomUUID();
    const cleanDesc = stripBidiMarks(quickDraft.description).trim();
    setItems((current) => [
      ...current,
      {
        id: newId,
        section_id: defaultSectionId,
        name: cleanName,
        description: cleanDesc,
        qty: quickDraft.qty.trim() || "1",
        unit: "",
        unit_price: quickDraft.unit_price.trim() || "0",
        is_optional: false,
      },
    ]);
    if (cleanDesc) {
      setExpandedDescIds((prev) => ({ ...prev, [newId]: true }));
    }
    setQuickDraft({ name: "", unit_price: "", qty: "1", description: "" });
    requestAnimationFrame(() => quickNameRef.current?.focus());
  }

  function onQuickKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitQuickDraft();
    }
  }

  function toggleDescRow(id: string) {
    setExpandedDescIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function moveItem(id: string, direction: -1 | 1) {
    setItems((current) => {
      const idx = current.findIndex((it) => it.id === id);
      if (idx === -1) return current;
      const target = idx + direction;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
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
    const newId = crypto.randomUUID();
    const desc = item.description ?? "";
    setItems((current) => [
      ...current,
      {
        id: newId,
        section_id: defaultSectionId,
        name: item.name,
        description: desc,
        qty: "1",
        unit: item.unit ?? "",
        unit_price: String(item.default_price ?? 0),
        is_optional: false,
      },
    ]);
    if (desc.trim()) {
      setExpandedDescIds((prev) => ({ ...prev, [newId]: true }));
    }
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

    let effectiveItems = items;
    if (quickDraft.name.trim() || Number(quickDraft.unit_price) > 0) {
      effectiveItems = [
        ...items,
        {
          id: crypto.randomUUID(),
          section_id: defaultSectionId,
          name: stripBidiMarks(quickDraft.name).trim(),
          description: stripBidiMarks(quickDraft.description).trim(),
          qty: quickDraft.qty.trim() || "1",
          unit: "",
          unit_price: quickDraft.unit_price.trim() || "0",
          is_optional: false,
        },
      ];
      setItems(effectiveItems);
      setQuickDraft({ name: "", unit_price: "", qty: "1", description: "" });
    }

    const effectiveTotals = computeQuoteTotals(
      effectiveItems.map((item) => ({ qty: Number(item.qty) || 0, unit_price: Number(item.unit_price) || 0 })),
      form.discount_type,
      Number(form.discount_value) || 0,
      Number(form.vat_rate) || 0,
    );

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
      discount_value: Number(form.discount_value)
