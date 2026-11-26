import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, ChevronDown, ChevronUp, Copy, FileText, History, ImagePlus, Plus, Printer, Save, Trash2, UserPlus, X } from "lucide-react";
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
import { DEFAULT_TERMS, computeQuoteTotals, lineTotal, money0, money2, nextQuoteNumber, quoteTermsText } from "@/lib/quotes";
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
type ItemDraft = { id: string; section_id: string | null; name: string; description: string; qty: string; unit: string; unit_price: string; is_optional: boolean };
type ImageDraft = { id: string; data_url: string; mime: string; caption: string };

const MAX_QUOTE_IMAGES = 12;
const MAX_IMAGE_BYTES = 400 * 1024;

async function compressQuoteImage(file: File): Promise<{ dataUrl: string; mime: string } | { error: string }> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return { error: "לא הצלחנו לעבד את התמונה" };
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    let q = 0.82;
    let dataUrl = canvas.toDataURL("image/jpeg", q);
    while (dataUrl.length > MAX_IMAGE_BYTES * 1.37 && q > 0.4) {
      q -= 0.08;
      dataUrl = canvas.toDataURL("image/jpeg", q);
    }
    return dataUrl.length > MAX_IMAGE_BYTES * 1.37
      ? { error: "התמונה גדולה מדי גם לאחר דחיסה — נסה תמונה אחרת" }
      : { dataUrl, mime: "image/jpeg" };
  } catch {
    return { error: "לא הצלחנו לקרוא את התמונה — נסה תמונה אחרת" };
  }
}

function emptyForm(): QuoteForm {
  return {
    quote_number: "", client_id: "", client_name: "", client_address: "", venue: "", event_address: "",
    event_contact_id: "", event_contact_name: "", event_contact_phone: "", subject: "", event_id: "",
    event_date: todayISO(), quote_date: todayISO(), valid_until: "", status: "draft", currency: "ILS",
    discount_type: "percent", discount_value: "0", vat_rate: "18", notes: "", termsText: DEFAULT_TERMS.join("\n"),
  };
}

export function QuoteBuilder({ quoteId, initialDate, initialEventId }: { quoteId?: string; initialDate?: string; initialEventId?: string }) {
  const { user, can } = useSession();
  const canEdit = can("quotes", "edit");
  const navigate = useNavigate();
  const qc = useQueryClient();
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
  const [copyPickerValue, setCopyPickerValue] = useState("");
  const [fieldNotes, setFieldNotes] = useState("");
  const [fieldNotesReady, setFieldNotesReady] = useState(!quoteId);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [newContact, setNewContact] = useState({ full_name: "", phone: "", role: "", email: "" });
  const [contactSaving, setContactSaving] = useState(false);
  const [expandedDescIds, setExpandedDescIds] = useState<Record<string, boolean>>({});
  const [quickDraft, setQuickDraft] = useState({ name: "", unit_price: "", qty: "1", description: "" });

  const versionsQ = useQuoteVersions(savedId, !!savedId);
  const contactsQ = useQuery({ queryKey: ["client_contacts", form.client_id], queryFn: () => listContacts(form.client_id), enabled: !!form.client_id, retry: 0 });
  const fieldNotesQ = useQuery({ queryKey: ["quote_field_notes", quoteId], queryFn: () => fetchQuoteFieldNotes(quoteId as string), enabled: !!quoteId && canEdit, retry: 1, staleTime: 0 });

  useEffect(() => {
    if (!fieldNotesReady && quoteId && fieldNotesQ.data !== undefined) {
      setFieldNotes(fieldNotesQ.data);
      setFieldNotesReady(true);
    }
  }, [fieldNotesQ.data, fieldNotesReady, quoteId]);

  useEffect(() => {
    if (initialized) return;
    if (quoteId) {
      if (quoteQ.isLoading || sectionsQ.isLoading || itemsQ.isLoading || imagesQ.isLoading) return;
      const q = quoteQ.data;
      if (!q) return;
      setForm({
        quote_number: q.quote_number, client_id: q.client_id ?? "", client_name: q.client_name,
        client_address: q.client_address ?? "", venue: q.venue ?? "", event_address: q.event_address ?? "",
        event_contact_id: q.event_contact_id ?? "", event_contact_name: q.event_contact_name ?? "",
        event_contact_phone: q.event_contact_phone ?? "", subject: q.subject ?? "", event_id: q.event_id ?? "",
        event_date: q.event_date ?? todayISO(), quote_date: q.issue_date ?? q.quote_date ?? todayISO(),
        valid_until: q.valid_until ?? "", status: q.status, currency: q.currency ?? "ILS",
        discount_type: q.discount_type === "fixed" ? "amount" : q.discount_type,
        discount_value: String(q.discount_value ?? 0), vat_rate: String(q.vat_rate ?? 18),
        notes: q.notes ?? "", termsText: quoteTermsText(q),
      });
      setSections((sectionsQ.data ?? []).map((s) => ({ id: s.id, name: s.name, show_section_totals: s.show_section_totals })));
      const loaded = (itemsQ.data ?? []).map((it) => ({
        id: it.id, section_id: it.section_id, name: it.name, description: it.description ?? "",
        qty: String(it.qty ?? 1), unit: it.unit ?? "", unit_price: String(it.unit_price ?? 0), is_optional: it.is_optional,
      }));
      setItems(loaded);
      const exp: Record<string, boolean> = {};
      for (const it of loaded) if (it.description.trim()) exp[it.id] = true;
      setExpandedDescIds(exp);
      setImages((imagesQ.data ?? []).map((img) => ({ id: String(img.id), data_url: img.data_url, mime: img.mime, caption: img.caption ?? "" })));
      setInitialized(true);
      return;
    }
    if (settingsQ.isLoading || quotesQ.isLoading) return;
    if (initialEventId) {
      const existing = (quotesQ.data ?? []).find((it) => it.event_id === initialEventId);
      if (existing) { navigate({ to: "/quotes/$id", params: { id: existing.id }, replace: true }); return; }
    }
    if (initialEventId && (eventsQ.isLoading || eventsQ.isFetching || clientsQ.isLoading || clientsQ.isFetching)) return;
    const s = settingsQ.data;
    const ev = initialEventId ? (eventsQ.data ?? []).find((e) => e.id === initialEventId) : undefined;
    const cl = ev?.client_id ? (clientsQ.data ?? []).find((c) => c.id === ev.client_id) : undefined;
    setEventNotice(initialEventId && !ev ? "האירוע לא נטען — ייתכן שאין הרשאה או שהאירוע נמחק." : null);
    const sid = crypto.randomUUID();
    setForm({
      ...emptyForm(),
      quote_number: nextQuoteNumber((quotesQ.data ?? []).map((q) => q.quote_number), s?.quote_number_prefix ?? ""),
      vat_rate: String(s?.default_vat_rate ?? 18), notes: s?.default_notes ?? "",
      termsText: s?.default_terms_text ?? DEFAULT_TERMS.join("\n"),
      event_id: ev?.id ?? "", event_date: ev?.event_date ?? initialDate ?? todayISO(),
      venue: ev?.venue || ev?.title || "", event_address: ev?.address || "", subject: ev?.title ?? "",
      client_id: cl?.id ?? "", client_name: cl?.name || ev?.title || "", client_address: cl?.address || ev?.address || "",
    });
    setSections([{ id: sid, name: "כללי", show_section_totals: true }]);
    setItems([]);
    setInitialized(true);
  }, [
    initialized, quoteId, quoteQ.isLoading, quoteQ.data, sectionsQ.isLoading, sectionsQ.data,
    itemsQ.isLoading, itemsQ.data, imagesQ.isLoading, imagesQ.data, settingsQ.isLoading, settingsQ.data,
    quotesQ.isLoading, quotesQ.data, initialDate, initialEventId, eventsQ.isLoading, eventsQ.isFetching,
    eventsQ.data, clientsQ.isLoading, clientsQ.isFetching, clientsQ.data, navigate,
  ]);

  const clients = clientsQ.data ?? [];
  const catalog = catalogQ.data ?? [];
  const quotes = quotesQ.data ?? [];
  const copyableQuotes = quotes.filter((it) => it.id !== savedId && it.id !== quoteId);
  const settings = settingsQ.data;
  const totals = computeQuoteTotals(
    items.map((it) => ({ qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 })),
    form.discount_type, Number(form.discount_value) || 0, Number(form.vat_rate) || 0,
  );
  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    return q ? catalog.filter((it) => `${it.name} ${it.section ?? ""} ${it.description ?? ""}`.toLowerCase().includes(q)) : catalog;
  }, [catalog, catalogSearch]);

  if (!canEdit) return <NoAccess moduleLabel="מודול הצעות המחיר" />;
  if (quoteId && (quoteQ.isLoading || sectionsQ.isLoading || itemsQ.isLoading)) return <PageSkeleton />;
  if (!quoteId && (settingsQ.isLoading || quotesQ.isLoading)) return <PageSkeleton />;
  if (settingsQ.error) return <ErrorState message="לא הצלחנו לטעון את פרטי החברה. נסה שוב." onRetry={() => settingsQ.refetch()} />;
  if (quotesQ.error) return <ErrorState message="לא הצלחנו לטעון את מספרי ההצעות. נסה שוב." onRetry={() => quotesQ.refetch()} />;
  if (quoteId && (quoteQ.error || sectionsQ.error || itemsQ.error)) {
    return <ErrorState message="לא הצלחנו לטעון את ההצעה. נסה שוב." onRetry={() => { quoteQ.refetch(); sectionsQ.refetch(); itemsQ.refetch(); }} />;
  }
  if (quoteId && !quoteQ.isLoading && !quoteQ.data) return <ErrorState message="ההצעה לא נמצאה." onRetry={() => quoteQ.refetch()} />;
  if (!initialized) return <PageSkeleton />;

  const contacts: ClientContact[] = contactsQ.data ?? [];
  const defaultSectionId = sections[0]?.id ?? null;
  const updateForm = (patch: Partial<QuoteForm>) => setForm((cur) => ({ ...cur, ...patch }));
  const updateItem = (id: string, patch: Partial<ItemDraft>) => setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const nextSaveStatus = (cur: QuoteStatus): QuoteStatus => (cur === "rejected" || cur === "cancelled" ? cur : "approved");

  function onClientChange(id: string) {
    const cl = clients.find((it) => it.id === id);
    setForm((cur) => ({
      ...cur,
      event_contact_id: cur.client_id === id ? cur.event_contact_id : "",
      event_contact_name: cur.client_id === id ? cur.event_contact_name : "",
      event_contact_phone: cur.client_id === id ? cur.event_contact_phone : "",
      client_id: id, client_name: cl?.name ?? cur.client_name, client_address: cl?.address ?? cur.client_address,
    }));
  }

  async function onImageFiles(files: FileList | null) {
    if (!files?.length) return;
    setImageError(null);
    const rem = MAX_QUOTE_IMAGES - images.length;
    if (rem <= 0) { setImageError(`אפשר להוסיף עד ${MAX_QUOTE_IMAGES} תמונות להצעה`); return; }
    if (files.length > rem) setImageError(`אפשר להוסיף עד ${MAX_QUOTE_IMAGES} תמונות להצעה — נוספו ${rem}`);
    setImageBusy(true);
    const next: ImageDraft[] = [];
    for (const f of Array.from(files).slice(0, rem)) {
      const res = await compressQuoteImage(f);
      if ("error" in res) { setImageError(res.error); continue; }
      next.push({ id: crypto.randomUUID(), data_url: res.dataUrl, mime: res.mime, caption: "" });
    }
    setImages((cur) => [...cur, ...next].slice(0, MAX_QUOTE_IMAGES));
    setImageBusy(false);
  }

  function moveInList<T extends { id: string }>(setter: React.Dispatch<React.SetStateAction<T[]>>, id: string, dir: -1 | 1) {
    setter((cur) => {
      const i = cur.findIndex((x) => x.id === id);
      const t = i + dir;
      if (i === -1 || t < 0 || t >= cur.length) return cur;
      const copy = [...cur];
      [copy[i], copy[t]] = [copy[t], copy[i]];
      return copy;
    });
  }

  async function applyCopy(sourceId: string) {
    const src = quotes.find((it) => it.id === sourceId);
    if (!src) return;
    setCopyBusy(true);
    const [secRes, itmRes] = await Promise.all([
      db.from<QuoteSection[]>("quote_sections").select("*").eq("quote_id", sourceId).order("sort_order", { ascending: true }),
      db.from<QuoteItem[]>("quote_items").select("*").eq("quote_id", sourceId).order("sort_order", { ascending: true }),
    ]);
    setCopyBusy(false);
    if (secRes.error || itmRes.error) { toast.error("לא הצלחנו לטעון את ההצעה להעתקה"); return; }
    const secMap = new Map<string, string>();
    const nextSec: SectionDraft[] = (secRes.data ?? []).map((s) => {
      const id = crypto.randomUUID();
      secMap.set(s.id, id);
      return { id, name: s.name, show_section_totals: s.show_section_totals };
    });
    let fb = nextSec[0]?.id ?? null;
    if (!fb) { fb = crypto.randomUUID(); nextSec.push({ id: fb, name: "כללי", show_section_totals: true }); }
    const nextItm: ItemDraft[] = (itmRes.data ?? []).map((it) => ({
      id: crypto.randomUUID(), section_id: it.section_id ? secMap.get(it.section_id) ?? fb : fb,
      name: it.name, description: it.description ?? "", qty: String(it.qty ?? 1),
      unit: it.unit ?? "", unit_price: String(it.unit_price ?? 0), is_optional: it.is_optional,
    }));
    const exp: Record<string, boolean> = {};
    for (const it of nextItm) if (it.description.trim()) exp[it.id] = true;
    setExpandedDescIds(exp);
    setSections(nextSec);
    setItems(nextItm);
    setCopySourceId("");
    setCopyPickerValue("");
    setCopyBarOpen(false);
    toast.success(`הפריטים הועתקו מההצעה ${src.quote_number}`);
  }

  function requestCopy() {
    if (!copySourceId) return;
    if (items.some((it) => it.name.trim() || Number(it.unit_price) > 0)) {
      setPendingCopyId(copySourceId);
      setCopyConfirmOpen(true);
      return;
    }
    void applyCopy(copySourceId);
  }

  function commitQuickDraft() {
    const cleanName = stripBidiMarks(quickDraft.name).trim();
    if (!cleanName && !(Number(quickDraft.unit_price) > 0)) { quickNameRef.current?.focus(); return; }
    const newId = crypto.randomUUID();
    const cleanDesc = stripBidiMarks(quickDraft.description).trim();
    setItems((cur) => [...cur, {
      id: newId, section_id: defaultSectionId, name: cleanName, description: cleanDesc,
      qty: quickDraft.qty.trim() || "1", unit: "", unit_price: quickDraft.unit_price.trim() || "0", is_optional: false,
    }]);
    if (cleanDesc) setExpandedDescIds((prev) => ({ ...prev, [newId]: true }));
    setQuickDraft({ name: "", unit_price: "", qty: "1", description: "" });
    requestAnimationFrame(() => quickNameRef.current?.focus());
  }

  function onQuickKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); commitQuickDraft(); }
  }

  function insertCatalogItem(item: PriceCatalogItem) {
    const newId = crypto.randomUUID();
    const desc = item.description ?? "";
    setItems((cur) => [...cur, {
      id: newId, section_id: defaultSectionId, name: item.name, description: desc,
      qty: "1", unit: item.unit ?? "", unit_price: String(item.default_price ?? 0), is_optional: false,
    }]);
    if (desc.trim()) setExpandedDescIds((prev) => ({ ...prev, [newId]: true }));
    setCatalogOpen(false);
    setCatalogSearch("");
    toast.success("הפריט נוסף להצעה");
  }

  async function addContact() {
    const fullName = newContact.full_name.trim();
    if (!fullName) { toast.error("נא להזין שם איש קשר"); return; }
    if (!form.client_id) {
      updateForm({ event_contact_id: "", event_contact_name: fullName, event_contact_phone: newContact.phone.trim() });
      setContactDialogOpen(false);
      setNewContact({ full_name: "", phone: "", role: "", email: "" });
      return;
    }
    setContactSaving(true);
    const id = crypto.randomUUID();
    const { error: insErr } = await db.from("client_contacts").insert({
      id, client_id: form.client_id, full_name: fullName, phone: newContact.phone.trim() || null,
      role: newContact.role.trim() || null, email: newContact.email.trim() || null, sort_order: contacts.length,
    });
    setContactSaving(false);
    if (insErr) {
      updateForm({ event_contact_id: "", event_contact_name: fullName, event_contact_phone: newContact.phone.trim() });
      toast.error("לא ניתן היה לשמור את איש הקשר ברשימת הלקוח — הוא נשמר בהצעה זו בלבד");
    } else {
      await qc.invalidateQueries({ queryKey: ["client_contacts", form.client_id] });
      updateForm({ event_contact_id: id, event_contact_name: fullName, event_contact_phone: newContact.phone.trim() });
      toast.success("איש הקשר נוסף לרשימת הלקוח");
    }
    setContactDialogOpen(false);
    setNewContact({ full_name: "", phone: "", role: "", email: "" });
  }

  async function save(status: QuoteStatus) {
    setError(null);
    if (!form.quote_number.trim()) { setError("נא להזין מספר הצעה."); return; }
    if (!form.client_name.trim()) { setError("נא להזין שם לקוח."); return; }

    let effItems = items;
    if (quickDraft.name.trim() || Number(quickDraft.unit_price) > 0) {
      effItems = [...items, {
        id: crypto.randomUUID(), section_id: defaultSectionId,
        name: stripBidiMarks(quickDraft.name).trim(), description: stripBidiMarks(quickDraft.description).trim(),
        qty: quickDraft.qty.trim() || "1", unit: "", unit_price: quickDraft.unit_price.trim() || "0", is_optional: false,
      }];
      setItems(effItems);
      setQuickDraft({ name: "", unit_price: "", qty: "1", description: "" });
    }

    const effTotals = computeQuoteTotals(
      effItems.map((it) => ({ qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 })),
      form.discount_type, Number(form.discount_value) || 0, Number(form.vat_rate) || 0,
    );

    setSaving(true);
    const id = savedId ?? crypto.randomUUID();
    const res = await saveQuote({
      quote: {
        id, quote_number: form.quote_number.trim(), client_id: form.client_id || null,
        client_name: form.client_name.trim(), client_address: form.client_address.trim() || null,
        venue: form.venue.trim() || null, event_address: form.event_address.trim() || null,
        event_contact_id: form.event_contact_id || null, event_contact_name: form.event_contact_name.trim() || null,
        event_contact_phone: form.event_contact_phone.trim() || null, subject: form.subject.trim() || null,
        event_id: form.event_id || null, event_date: form.event_date || null,
        quote_date: form.quote_date || todayISO(), issue_date: form.quote_date || todayISO(),
        valid_until: form.valid_until || null, print_date: todayISO(), currency: form.currency || "ILS",
        status, discount_type: form.discount_type, discount_value: Number(form.discount_value) || 0,
        vat_rate: Number(form.vat_rate) || 0, notes: form.notes.trim() || null,
        terms: form.termsText.split("\n").map((t) => t.trim()).filter(Boolean),
        terms_text: form.termsText.trim() || null, subtotal: effTotals.subtotal,
        discount_amount: effTotals.discountAmount, total_before_vat: effTotals.afterDiscount,
        vat_amount: effTotals.vatAmount, grand_total: effTotals.grandTotal,
      },
      sections: sections.map((s, idx) => ({ id: s.id, name: s.name.trim() || "סעיף", sort_order: idx, show_section_totals: s.show_section_totals })),
      items: effItems.map((it, idx) => ({
        id: it.id, section_id: it.section_id, sort_order: idx, name: it.name.trim() || "פריט",
        description: it.description.trim() || null, qty: Number(it.qty) || 0, quantity: Number(it.qty) || 0,
        unit: it.unit.trim() || null, unit_price: Number(it.unit_price) || 0,
        line_total: lineTotal({ qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 }), is_optional: it.is_optional,
      })),
      images: images.map((img, idx) => ({ position: idx, mime: img.mime, data_url: img.data_url, caption: img.caption.trim() || null })),
      ...(fieldNotesReady ? { fieldNotes } : {}),
    });
    setSaving(false);
    if (!res.ok) {
      if (res.error === "event_has_quote" && res.existingId) {
        toast.error("לאירוע זה כבר קיימת הצעת מחיר — נפתחת ההצעה הקיימת");
        navigate({ to: "/quotes/$id", params: { id: res.existingId }, replace: true });
        return;
      }
      setError(res.message);
      return;
    }
    if (!savedId) setSavedId(id);
    for (const k of [["quotes"], ["quote", id], ["quote_sections", id], ["quote_items", id], ["quote_images", id], ["quote_versions", id], ["quote_field_notes", id]]) {
      qc.invalidateQueries({ queryKey: k });
    }
    toast.success(savedId ? "ההצעה עודכנה — המצב הקודם נשמר בהיסטוריית הגרסאות" : "ההצעה נשמרה");
    navigate({ to: "/quotes/$id/print", params: { id } });
  }

  async function duplicateCurrent() {
    if (!savedId) return;
    setSaving(true);
    const newId = crypto.randomUUID();
    const newNumber = nextQuoteNumber(quotes.map((q) => q.quote_number), settings?.quote_number_prefix ?? "");
    const { error: qErr } = await db.from("quotes").insert({
      id: newId, quote_number: newNumber, client_id: form.client_id || null, client_name: form.client_name.trim(),
      client_address: form.client_address.trim() || null, venue: form.venue.trim() || null,
      event_address: form.event_address.trim() || null, event_contact_id: form.event_contact_id || null,
      event_contact_name: form.event_contact_name.trim() || null, event_contact_phone: form.event_contact_phone.trim() || null,
      subject: form.subject.trim() || null, event_id: null, event_date: form.event_date || null,
      quote_date: todayISO(), issue_date: todayISO(), valid_until: form.valid_until || null, print_date: todayISO(),
      currency: form.currency || "ILS", status: "draft", discount_type: form.discount_type,
      discount_value: Number(form.discount_value) || 0, vat_rate: Number(form.vat_rate) || 0,
      notes: form.notes.trim() || null, terms: form.termsText.split("\n").map((t) => t.trim()).filter(Boolean),
      terms_text: form.termsText.trim() || null, subtotal: totals.subtotal, discount_amount: totals.discountAmount,
      total_before_vat: totals.afterDiscount, vat_amount: totals.vatAmount, grand_total: totals.grandTotal,
      created_by: user?.id ?? null,
    });
    if (qErr) { setSaving(false); toast.error("לא הצלחנו לשכפל את ההצעה"); return; }
    const secMap = new Map<string, string>();
    const newSec = sections.map((s, idx) => {
      const sid = crypto.randomUUID();
      secMap.set(s.id, sid);
      return { id: sid, quote_id: newId, name: s.name, sort_order: idx, show_section_totals: s.show_section_totals };
    });
    if (newSec.length) {
      const { error: sErr } = await db.from("quote_sections").insert(newSec);
      if (sErr) { setSaving(false); toast.error("לא הצלחנו לשכפל את ההצעה"); return; }
    }
    const newItm = items.map((it, idx) => ({
      id: crypto.randomUUID(), quote_id: newId, section_id: it.section_id ? secMap.get(it.section_id) ?? null : null,
      sort_order: idx, name: it.name, description: it.description, qty: Number(it.qty) || 0, quantity: Number(it.qty) || 0,
      unit: it.unit, unit_price: Number(it.unit_price) || 0,
      line_total: lineTotal({ qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 }), is_optional: it.is_optional,
    }));
    if (newItm.length) {
      const { error: iErr } = await db.from("quote_items").insert(newItm);
      if (iErr) { setSaving(false); toast.error("לא הצלחנו לשכפל את ההצעה"); return; }
    }
    setSaving(false);
    toast.success("ההצעה שוכפלה כהצעה עצמאית ללא שיוך לאירוע");
    qc.invalidateQueries({ queryKey: ["quotes"] });
    navigate({ to: "/quotes/$id", params: { id: newId } });
  }

  async function confirmRestore() {
    if (!restoreTarget || !savedId) return;
    setRestoring(true);
    const res = await restoreQuoteVersion(savedId, restoreTarget.id);
    if (!res.ok) { setRestoring(false); toast.error(res.message); return; }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["quote", savedId] }),
      qc.invalidateQueries({ queryKey: ["quote_sections", savedId] }),
      qc.invalidateQueries({ queryKey: ["quote_items", savedId] }),
      qc.invalidateQueries({ queryKey: ["quote_versions", savedId] }),
    ]);
    setRestoring(false);
    setRestoreTarget(null);
    setPreviewVersion(null);
    setVersionsOpen(false);
    setInitialized(false);
    toast.success("הגרסה שוחזרה — המצב הקודם נשמר כגרסה חדשה");
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title={quoteId ? "עריכת הצעת מחיר" : "הצעת מחיר חדשה"}
        description="לקוח, אירוע, פריטים ומחירים"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm" className="h-9"><Link to="/quotes">חזרה להצעות</Link></Button>
            {savedId ? <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => navigate({ to: "/quotes/$id/print", params: { id: savedId } })}><Printer className="size-4" /> הדפסה / PDF</Button> : null}
            {savedId ? <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setVersionsOpen(true)}><History className="size-4" /> גרסאות</Button> : null}
            {savedId ? <Button type="button" variant="outline" size="sm" className="h-9" onClick={duplicateCurrent} disabled={saving || quotesQ.isLoading}><Copy className="size-4" /> שכפול</Button> : null}
            <Button type="button" size="sm" className="h-9 px-4" onClick={() => save(nextSaveStatus(form.status))} disabled={saving}>
              <Save className="size-4" /> {saving ? "שומר…" : "עדכון"}
            </Button>
          </div>
        }
      />

      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {eventNotice ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{eventNotice}</p> : null}

      <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-12">
          <div className="lg:col-span-2">
            <label htmlFor="quote-number" className="mb-1 block text-[11px] font-medium text-muted-foreground">מס׳ הצעה</label>
            <Input id="quote-number" value={form.quote_number} onChange={(e) => updateForm({ quote_number: e.target.value })} dir="ltr" className="num h-9 text-center text-sm font-bold" />
          </div>
          <div className="lg:col-span-3">
            <label htmlFor="quote-client" className="mb-1 block text-[11px] font-medium text-muted-foreground">בחירה מרשימת לקוחות</label>
            <ClientPicker id="quote-client" clients={clients} value={form.client_id} onChange={onClientChange} emptyLabel={clientPickerCopy.manual} />
          </div>
          <div className="lg:col-span-3">
            <label htmlFor="quote-client-name" className="mb-1 block text-[11px] font-medium text-muted-foreground">שם לקוח *</label>
            <Input id="quote-client-name" value={form.client_name} onChange={(e) => updateForm({ client_name: e.target.value })} placeholder="שם הלקוח בהצעה" className="h-9 text-sm" />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="quote-date" className="mb-1 block text-[11px] font-medium text-muted-foreground">תאריך הצעה</label>
            <Input id="quote-date" type="date" value={form.quote_date} onChange={(e) => updateForm({ quote_date: e.target.value })} className="h-9 text-sm" />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="quote-valid-until" className="mb-1 block text-[11px] font-medium text-muted-foreground">תוקף הצעה</label>
            <Input id="quote-valid-until" type="date" value={form.valid_until} onChange={(e) => updateForm({ valid_until: e.target.value })} className="h-9 text-sm" />
          </div>
        </div>

        <div className="mt-2.5 grid gap-2.5 border-t border-border/60 pt-2.5 sm:grid-cols-2 lg:grid-cols-12">
          <div className="lg:col-span-3">
            <label htmlFor="quote-venue" className="mb-1 block text-[11px] font-medium text-muted-foreground">מקום האירוע</label>
            <Input id="quote-venue" value={form.venue} onChange={(e) => updateForm({ venue: e.target.value })} placeholder="אולם / מיקום" className="h-9 text-sm" />
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="quote-event-date" className="mb-1 block text-[11px] font-medium text-muted-foreground">תאריך האירוע</label>
            <Input id="quote-event-date" type="date" value={form.event_date} onChange={(e) => updateForm({ event_date: e.target.value })} className="h-9 text-sm" />
          </div>
          <div className="lg:col-span-3">
            <label htmlFor="quote-event-address" className="mb-1 block text-[11px] font-medium text-muted-foreground">כתובת האירוע</label>
            <Input id="quote-event-address" value={form.event_address} onChange={(e) => updateForm({ event_address: e.target.value })} placeholder="עיר / רחוב" className="h-9 text-sm" />
          </div>
          <div className="lg:col-span-2">
            <div className="mb-1 flex items-center justify-between gap-1">
              <label htmlFor="quote-contact-name" className="text-[11px] font-medium text-muted-foreground">איש קשר בשטח</label>
              <button type="button" onClick={() => setContactDialogOpen(true)} className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline">
                <UserPlus className="size-3" /> חדש
              </button>
            </div>
            {form.client_id && contacts.length > 0 ? (
              <div className="space-y-1">
                <SearchPicker
                  id="quote-contact-picker"
                  options={contacts.map((c) => ({ id: c.id, label: c.full_name, sub: [c.role, c.phone].filter(Boolean).join(" · ") || null, search: c.email ?? "" }))}
                  value={form.event_contact_id}
                  onChange={(cid) => {
                    const c = contacts.find((x) => x.id === cid);
                    if (!c) updateForm({ event_contact_id: "" });
                    else updateForm({ event_contact_id: c.id, event_contact_name: c.full_name, event_contact_phone: c.phone ?? "" });
                  }}
                  placeholder={form.event_contact_name || "בחר או הקלד איש קשר"}
                  emptyText="אין אנשי קשר תואמים"
                  ariaLabel="בחירת איש קשר מרשימת הלקוח"
                  displayValue={form.event_contact_id ? form.event_contact_name : ""}
                />
                {!form.event_contact_id ? (
                  <Input id="quote-contact-name" value={form.event_contact_name} onChange={(e) => updateForm({ event_contact_name: e.target.value, event_contact_id: "" })} placeholder="או הקלד שם ידנית" className="h-8 text-xs" />
                ) : null}
              </div>
            ) : (
              <Input id="quote-contact-name" value={form.event_contact_name} onChange={(e) => updateForm({ event_contact_name: e.target.value, event_contact_id: "" })} placeholder="שם איש קשר" className="h-9 text-sm" />
            )}
          </div>
          <div className="lg:col-span-2">
            <label htmlFor="quote-contact-phone" className="mb-1 block text-[11px] font-medium text-muted-foreground">טלפון איש קשר</label>
            <Input id="quote-contact-phone" type="tel" dir="ltr" inputMode="tel" value={form.event_contact_phone} onChange={(e) => updateForm({ event_contact_phone: e.target.value })} placeholder="050-0000000" className="h-9 text-start text-sm" />
          </div>
        </div>

        <details className="mt-2 border-t border-border/50 pt-2">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">פרטים נוספים (כתובת לקוח / נושא הצעה)</summary>
          <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
            <div>
              <label htmlFor="quote-client-address" className="mb-1 block text-[11px] font-medium text-muted-foreground">כתובת הלקוח</label>
              <Input id="quote-client-address" value={form.client_address} onChange={(e) => updateForm({ client_address: e.target.value })} className="h-9 text-sm" />
            </div>
            <div>
              <label htmlFor="quote-subject" className="mb-1 block text-[11px] font-medium text-muted-foreground">נושא ההצעה (אופציונלי)</label>
              <Input id="quote-subject" value={form.subject} onChange={(e) => updateForm({ subject: e.target.value })} className="h-9 text-sm" />
            </div>
          </div>
        </details>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-foreground">פריטים בהצעה</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">{items.length} שורות</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => { setCatalogSearch(""); setCatalogOpen(true); }}>
              <BookOpen className="size-3.5" /> בחר מהמחירון
            </Button>
            <Button type="button" variant={copyBarOpen ? "secondary" : "outline"} size="sm" className="h-8 text-xs" onClick={() => setCopyBarOpen((v) => !v)}>
              <Copy className="size-3.5" /> העתקה מהצעה קיימת
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setItems((cur) => [...cur, { id: crypto.randomUUID(), section_id: defaultSectionId, name: "", description: "", qty: "1", unit: "", unit_price: "0", is_optional: false }])}>
              <Plus className="size-3.5" /> שורה ריקה
            </Button>
          </div>
        </div>

        {copyBarOpen ? (
          <div className="border-b border-border bg-muted/30 px-3 py-2.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <SearchPicker
                  id="quote-copy-source"
                  options={copyableQuotes.map((it) => ({
                    id: it.id, label: `${it.quote_number} · ${it.client_name}`,
                    sub: `${it.event_date ? dateShort(it.event_date) : "—"} · ${money0(it.grand_total)}${it.venue ? ` · ${it.venue}` : ""}`,
                    search: [it.subject, it.venue].filter(Boolean).join(" "),
                  }))}
                  value={copyPickerValue}
                  onChange={(id) => { setCopyPickerValue(id); setCopySourceId(id); }}
                  placeholder="חיפוש הצעה להעתקה לפי מספר, לקוח או מקום…"
                  emptyText="לא נמצאו הצעות"
                  ariaLabel="בחירת הצעה להעתקה"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Button type="button" size="sm" className="h-9" disabled={!copySourceId || copyBusy} onClick={requestCopy}>
                  <Copy className="size-3.5" /> {copyBusy ? "מעתיק…" : "העתק פריטים"}
                </Button>
                <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setCopyBarOpen(false)} aria-label="סגירת העתקה"><X className="size-4" /></Button>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">מועתקים הפריטים בלבד — פרטי הלקוח והאירוע למעלה אינם משתנים.</p>
          </div>
        ) : null}

        <div className="border-b border-indigo-200/70 bg-indigo-50/40 px-3 py-2">
          <div className="grid gap-2 sm:grid-cols-12 sm:items-center">
            <div className="sm:col-span-5">
              <Input ref={quickNameRef} value={isolateLtrText(quickDraft.name)} onChange={(e) => setQuickDraft((d) => ({ ...d, name: stripBidiMarks(e.target.value) }))} onKeyDown={onQuickKeyDown} placeholder="הוספה מהירה: הקלד שם פריט ולחץ Enter…" className="h-9 bg-background text-sm" aria-label="שם פריט להוספה מהירה" />
            </div>
            <div className="sm:col-span-3">
              <Input value={isolateLtrText(quickDraft.description)} onChange={(e) => setQuickDraft((d) => ({ ...d, description: stripBidiMarks(e.target.value) }))} onKeyDown={onQuickKeyDown} placeholder="פירוט קצר (אופציונלי)" className="h-9 bg-background text-xs" aria-label="פירוט פריט להוספה מהירה" />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:col-span-4 sm:flex sm:items-center">
              <Input type="number" min="0" step="any" inputMode="decimal" value={quickDraft.unit_price} onChange={(e) => setQuickDraft((d) => ({ ...d, unit_price: e.target.value }))} onKeyDown={onQuickKeyDown} placeholder="מחיר ₪" className="num h-9 bg-background text-sm sm:w-28" aria-label="מחיר יחידה להוספה מהירה" />
              <Input type="number" min="0" step="any" inputMode="decimal" value={quickDraft.qty} onChange={(e) => setQuickDraft((d) => ({ ...d, qty: e.target.value }))} onKeyDown={onQuickKeyDown} placeholder="כמות" className="num h-9 bg-background text-center text-sm sm:w-20" aria-label="כמות להוספה מהירה" />
              <Button type="button" size="sm" className="h-9 shrink-0 px-3" onClick={commitQuickDraft}><Plus className="size-4" /> הוסף</Button>
            </div>
          </div>
        </div>

        {!items.length ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">אין עדיין פריטים בהצעה — הקלד פריט בשורת ההוספה המהירה למעלה או בחר מהמחירון.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-xs font-semibold text-muted-foreground">
                  <th className="w-9 px-2 py-2 text-center">#</th>
                  <th className="px-2 py-2 text-start">שם הפריט</th>
                  <th className="w-32 px-2 py-2 text-start">מחיר יחידה (₪)</th>
                  <th className="w-24 px-2 py-2 text-center">כמות</th>
                  <th className="w-28 px-2 py-2 text-end">סה״כ שורה</th>
                  <th className="w-28 px-2 py-2 text-center">פעולות</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((item, idx) => {
                  const rowSum = lineTotal({ qty: Number(item.qty) || 0, unit_price: Number(item.unit_price) || 0 });
                  const descOpen = Boolean(expandedDescIds[item.id]);
                  const hasDesc = Boolean(item.description.trim());
                  return (
                    <Fragment key={item.id}>
                      <tr className="group hover:bg-muted/25">
                        <td className="num px-2 py-1.5 text-center text-xs font-semibold text-muted-foreground">{idx + 1}</td>
                        <td className="px-2 py-1.5">
                          <Input value={isolateLtrText(item.name)} onChange={(e) => updateItem(item.id, { name: stripBidiMarks(e.target.value).replace(/\s*\n+\s*/g, " ") })} placeholder="שם הפריט" className="h-8 border-transparent bg-transparent px-2 text-sm font-medium hover:border-border focus:border-border focus:bg-background" aria-label={`שם הפריט ${idx + 1}`} />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input id={`price-${item.id}`} type="number" min="0" step="any" inputMode="decimal" value={item.unit_price} onChange={(e) => updateItem(item.id, { unit_price: e.target.value })} className="num h-8 px-2 text-sm" aria-label={`מחיר ליחידה שורה ${idx + 1}`} />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input id={`qty-${item.id}`} type="number" min="0" step="any" inputMode="decimal" value={item.qty} onChange={(e) => updateItem(item.id, { qty: e.target.value })} className="num h-8 px-2 text-center text-sm" aria-label={`כמות שורה ${idx + 1}`} />
                        </td>
                        <td className="num px-2 py-1.5 text-end text-sm font-semibold text-foreground">{money2(rowSum)}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center justify-center gap-0.5">
                            <Button type="button" variant={descOpen || hasDesc ? "secondary" : "ghost"} size="icon" className="size-7" onClick={() => setExpandedDescIds((p) => ({ ...p, [item.id]: !p[item.id] }))} title="פירוט לשורה" aria-label={`פירוט שורה ${idx + 1}`}><FileText className="size-3.5" /></Button>
                            <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => moveInList(setItems, item.id, -1)} disabled={idx === 0} aria-label={`הזזת שורה ${idx + 1} למעלה`}><ChevronUp className="size-3.5" /></Button>
                            <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => moveInList(setItems, item.id, 1)} disabled={idx === items.length - 1} aria-label={`הזזת שורה ${idx + 1} למטה`}><ChevronDown className="size-3.5" /></Button>
                            <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground hover:bg-red-50 hover:text-red-700" onClick={() => setItems((cur) => cur.filter((x) => x.id !== item.id))} aria-label={`מחיקת שורה ${idx + 1}`}><Trash2 className="size-3.5" /></Button>
                          </div>
                        </td>
                      </tr>
                      {descOpen ? (
                        <tr className="bg-muted/20">
                          <td />
                          <td colSpan={5} className="px-2 pb-2 pt-0.5">
                            <Textarea value={isolateLtrText(item.description)} onChange={(e) => updateItem(item.id, { description: stripBidiMarks(e.target.value) })} placeholder="פירוט לפריט (לא חובה — כל שורה תודפס כנקודה מתחת לפריט)" rows={2} className="min-h-12 bg-background text-xs" aria-label={`פירוט פריט ${idx + 1}`} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-12 lg:items-start">
        <div className="space-y-2.5 lg:col-span-7">
          <details className="group rounded-xl border border-border bg-card px-3.5 py-2.5" open={Boolean(form.notes.trim())}>
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-foreground">
              <span>הערות ותנאים להדפסה בהצעה</span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="הערות להצעה" htmlFor="quote-notes" hint="כל שורה תודפס כנקודה"><Textarea id="quote-notes" value={form.notes} onChange={(e) => updateForm({ notes: e.target.value })} rows={4} className="min-h-24 text-xs" /></Field>
              <Field label="תנאים / הסכם" htmlFor="quote-terms" hint="שורה אחת לכל תנאי"><Textarea id="quote-terms" value={form.termsText} onChange={(e) => updateForm({ termsText: e.target.value })} rows={4} className="min-h-24 text-xs" /></Field>
            </div>
          </details>

          <details className="group rounded-xl border border-border bg-card px-3.5 py-2.5" open={Boolean(fieldNotes.trim())}>
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-foreground">
              <span>הערות פנימיות לצוות שטח ומחסנאי <span className="text-xs font-normal text-muted-foreground">(לא מודפס ללקוח)</span></span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3">
              {quoteId && !fieldNotesReady && fieldNotesQ.isError ? (
                <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  לא הצלחנו לטעון את ההערות הקיימות — הן לא יידרסו בשמירה.
                  <Button type="button" variant="outline" size="sm" onClick={() => fieldNotesQ.refetch()}>נסה שוב</Button>
                </div>
              ) : null}
              <Textarea id="quote-field-notes" value={fieldNotes} onChange={(e) => setFieldNotes(e.target.value)} disabled={!fieldNotesReady} placeholder={fieldNotesReady ? "לדוגמה: כניסה מהחניה האחורית, להביא כבל 30 מ׳, פריקה עד 14:00" : "טוען…"} rows={3} className="min-h-20 text-xs" />
            </div>
          </details>

          <details className="group rounded-xl border border-border bg-card px-3.5 py-2.5" open={images.length > 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-foreground">
              <span>תמונות מצורפות להצעה <span className="text-xs font-normal text-muted-foreground">({images.length}/{MAX_QUOTE_IMAGES})</span></span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3 space-y-2.5">
              <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { onImageFiles(e.target.files); e.target.value = ""; }} />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => imageInputRef.current?.click()} disabled={imageBusy || images.length >= MAX_QUOTE_IMAGES}>
                  <ImagePlus className="size-4" /> {imageBusy ? "מעבד…" : "הוספת תמונות"}
                </Button>
                {images.length >= MAX_QUOTE_IMAGES ? <span className="text-xs text-amber-700">הגעת למגבלת {MAX_QUOTE_IMAGES} התמונות.</span> : null}
              </div>
              {imageError ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{imageError}</p> : null}
              {images.length ? (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {images.map((img, idx) => (
                    <div key={img.id} className="rounded-lg border border-border bg-muted/30 p-2">
                      <div className="relative">
                        <img src={img.data_url} alt={img.caption || `תמונה ${idx + 1}`} className="h-24 w-full rounded object-contain" />
                        <Button type="button" variant="ghost" size="icon" className="absolute end-1 top-1 size-7 bg-background/80 text-red-700 hover:bg-red-50" onClick={() => setImages((cur) => cur.filter((x) => x.id !== img.id))} aria-label={`הסרת תמונה ${idx + 1}`}><X className="size-3.5" /></Button>
                      </div>
                      <Input value={img.caption} onChange={(e) => setImages((cur) => cur.map((x) => (x.id === img.id ? { ...x, caption: e.target.value } : x)))} placeholder="כיתוב (לא חובה)" className="mt-1.5 h-8 text-xs" aria-label={`כיתוב לתמונה ${idx + 1}`} />
                      <div className="mt-1 flex items-center justify-between">
                        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => moveInList(setImages, img.id, -1)} disabled={idx === 0} aria-label={`הזזת תמונה ${idx + 1} למעלה`}><ChevronUp className="size-3.5" /></Button>
                        <span className="text-[10px] text-muted-foreground">{idx + 1}</span>
                        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => moveInList(setImages, img.id, 1)} disabled={idx === images.length - 1} aria-label={`הזזת תמונה ${idx + 1} למטה`}><ChevronDown className="size-3.5" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-xs lg:col-span-5">
          <div className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted-foreground">סך הכול לפני הנחה</span><span className="num font-medium">{money2(totals.subtotal)}</span></div>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">הנחה</span>
              <div className="flex items-center gap-1.5">
                <Select id="discount-type" value={form.discount_type} onChange={(e) => updateForm({ discount_type: e.target.value as DiscountType })} className="h-8 w-24 text-xs" aria-label="סוג הנחה">
                  <option value="percent">אחוז %</option>
                  <option value="amount">סכום ₪</option>
                </Select>
                <Input id="discount-value" type="number" min="0" step="any" inputMode="decimal" value={form.discount_value} onChange={(e) => updateForm({ discount_value: e.target.value })} className="num h-8 w-24 text-sm" aria-label="ערך הנחה" />
              </div>
            </div>
            {totals.discountAmount > 0 ? <div className="flex items-center justify-between text-xs text-amber-800"><span>סכום הנחה</span><span className="num font-medium">-{money2(totals.discountAmount)}</span></div> : null}
            <div className="flex items-center justify-between border-t border-border/60 pt-2"><span className="text-muted-foreground">מחיר לפני מע״מ</span><span className="num font-medium">{money2(totals.afterDiscount)}</span></div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label htmlFor="vat-rate" className="text-xs text-muted-foreground">מע״מ %</label>
                <Input id="vat-rate" type="number" min="0" step="any" inputMode="decimal" value={form.vat_rate} onChange={(e) => updateForm({ vat_rate: e.target.value })} className="num h-7 w-16 px-2 text-center text-xs" />
              </div>
              <span className="num font-medium">{money2(totals.vatAmount)}</span>
            </div>
            <div className="flex items-center justify-between border-t-2 border-border pt-2.5 text-base">
              <span className="font-bold text-foreground">סה״כ לתשלום</span>
              <span className="num text-lg font-bold text-primary">{money0(totals.grandTotal)}</span>
            </div>
          </div>
          <Button type="button" className="mt-3.5 h-10 w-full text-sm font-semibold" onClick={() => save(nextSaveStatus(form.status))} disabled={saving}>
            <Save className="size-4" /> {saving ? "שומר…" : "עדכון ושמירה"}
          </Button>
        </div>
      </div>

      <Dialog open={contactDialogOpen} onOpenChange={(o) => { if (!contactSaving) setContactDialogOpen(o); }} title="איש קשר חדש" description={form.client_id ? "יתווסף לרשימת אנשי הקשר של הלקוח וייבחר לאירוע" : "יישמר בהצעה זו (לא נבחר לקוח מהרשימה)"} size="sm" footer={<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setContactDialogOpen(false)} disabled={contactSaving}>ביטול</Button><Button type="button" onClick={addContact} disabled={contactSaving}>{contactSaving ? "שומר…" : "הוספה"}</Button></div>}>
        <div className="grid gap-3">
          <Field label="שם מלא" htmlFor="new-contact-name"><Input id="new-contact-name" value={newContact.full_name} onChange={(e) => setNewContact((c) => ({ ...c, full_name: e.target.value }))} className="h-11" /></Field>
          <Field label="טלפון" htmlFor="new-contact-phone"><Input id="new-contact-phone" type="tel" dir="ltr" inputMode="tel" value={newContact.phone} onChange={(e) => setNewContact((c) => ({ ...c, phone: e.target.value }))} className="h-11 text-start" /></Field>
          <Field label="תפקיד" htmlFor="new-contact-role"><Input id="new-contact-role" value={newContact.role} onChange={(e) => setNewContact((c) => ({ ...c, role: e.target.value }))} placeholder="לדוגמה: מנהל שטח" className="h-11" /></Field>
          <Field label="אימייל" htmlFor="new-contact-email"><Input id="new-contact-email" type="email" dir="ltr" value={newContact.email} onChange={(e) => setNewContact((c) => ({ ...c, email: e.target.value }))} className="h-11 text-start" /></Field>
        </div>
      </Dialog>

      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen} title="בחירה מהמחירון" description="פריטים עם מחיר ברירת מחדל" size="lg">
        <div className="space-y-3">
          <Input value={catalogSearch} onChange={(e) => setCatalogSearch(e.target.value)} placeholder="חיפוש פריט, סעיף או תיאור" className="h-11" />
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {filteredCatalog.map((it) => (
              <button key={it.id} type="button" onClick={() => insertCatalogItem(it)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-start hover:bg-muted/50">
                <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{it.name}</p><p className="truncate text-xs text-muted-foreground">{it.section || "כללי"} · {it.unit || "יח׳"}</p></div>
                <span className="num shrink-0 text-sm font-semibold text-foreground">{money2(it.default_price)}</span>
              </button>
            ))}
            {!filteredCatalog.length ? <p className="py-6 text-center text-sm text-muted-foreground">לא נמצאו פריטים במחירון.</p> : null}
          </div>
        </div>
      </Dialog>

      <Dialog open={versionsOpen} onOpenChange={(o) => { setVersionsOpen(o); if (!o) setPreviewVersion(null); }} title="היסטוריית גרסאות" description="נשמרת אוטומטית לפני כל עדכון של ההצעה" size="lg">
        <div className="space-y-3">
          {versionsQ.isLoading ? <p className="py-6 text-center text-sm text-muted-foreground">טוען גרסאות…</p> : versionsQ.error ? <p className="py-6 text-center text-sm text-red-700">לא הצלחנו לטעון את הגרסאות. נסה שוב.</p> : !(versionsQ.data ?? []).length ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
              <History className="mx-auto mb-2 size-6 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">אין עדיין גרסאות</p>
              <p className="mt-1 text-sm text-muted-foreground">ברגע שתעדכנו את ההצעה, המצב הקודם יישמר כאן אוטומטית.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {(versionsQ.data ?? []).map((v) => (
                <li key={v.id}>
                  <button type="button" onClick={() => setPreviewVersion(v)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-start hover:bg-muted/50">
                    <div className="min-w-0"><p className="text-sm font-medium text-foreground">גרסה {v.version_number}</p><p className="truncate text-xs text-muted-foreground">{dateTime(v.created_at)}{v.label ? ` · ${v.label}` : ""}</p></div>
                    <span className="num shrink-0 text-sm font-semibold text-foreground">{money0(v.total)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      <Dialog open={!!previewVersion} onOpenChange={(o) => { if (!o) setPreviewVersion(null); }} title={previewVersion ? `גרסה ${previewVersion.version_number} — תצוגה מקדימה` : "תצוגה מקדימה"} description={previewVersion ? dateTime(previewVersion.created_at) : undefined} size="lg" footer={previewVersion ? <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setPreviewVersion(null)}>סגירה</Button><Button type="button" onClick={() => setRestoreTarget(previewVersion)}>שחזר גרסה זו</Button></div> : null}>
        {previewVersion ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium text-foreground">{previewVersion.snapshot?.quote?.client_name || "ללא לקוח"}</p>
              <p className="text-muted-foreground">הצעה {previewVersion.snapshot?.quote?.quote_number || "—"}{previewVersion.snapshot?.quote?.event_date ? ` · ${previewVersion.snapshot.quote.event_date}` : ""}</p>
            </div>
            <div className="space-y-2">
              {(previewVersion.snapshot?.items ?? []).map((it) => (
                <div key={it.id} className="flex items-start justify-between gap-3 border-b border-border pb-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground"><LtrText>{it.name}</LtrText></p>
                    {it.description ? <p className="truncate text-xs text-muted-foreground"><LtrText>{it.description}</LtrText></p> : null}
                    <p className="text-xs text-muted-foreground">{it.qty} × {money2(it.unit_price)}</p>
                  </div>
                  <span className="num shrink-0 font-medium text-foreground">{money2(it.line_total ?? it.qty * it.unit_price)}</span>
                </div>
              ))}
              {!(previewVersion.snapshot?.items ?? []).length ? <p className="py-4 text-center text-sm text-muted-foreground">אין פריטים בגרסה זו.</p> : null}
            </div>
            <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">סך הכול לפני הנחה</span><span className="num">{money2(previewVersion.snapshot?.quote?.subtotal)}</span></div>
              {Number(previewVersion.snapshot?.quote?.discount_amount) > 0 ? <div className="flex justify-between"><span className="text-muted-foreground">הנחה</span><span className="num">{money2(previewVersion.snapshot?.quote?.discount_amount)}</span></div> : null}
              <div className="flex justify-between"><span className="text-muted-foreground">מע״מ</span><span className="num">{money2(previewVersion.snapshot?.quote?.vat_amount)}</span></div>
              <div className="flex justify-between border-t border-border pt-1.5 text-base"><span className="font-semibold">סה״כ לתשלום</span><span className="num font-bold text-primary">{money0(previewVersion.snapshot?.quote?.grand_total ?? previewVersion.total)}</span></div>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={!!restoreTarget} onOpenChange={(o) => { if (!o && !restoring) setRestoreTarget(null); }} title="שחזור גרסה" description={restoreTarget ? `גרסה ${restoreTarget.version_number}` : undefined} size="sm" footer={<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setRestoreTarget(null)} disabled={restoring}>ביטול</Button><Button type="button" onClick={confirmRestore} disabled={restoring}>{restoring ? "משחזר…" : "שחזר גרסה זו"}</Button></div>}>
        <p className="text-sm text-foreground">המצב הנוכחי של ההצעה יישמר אוטומטית כגרסה חדשה, ואז תוחל הגרסה הנבחרת. הפעולה אינה מוחקת נתונים.</p>
      </Dialog>

      <ConfirmDialog
        open={copyConfirmOpen}
        onOpenChange={(o) => { setCopyConfirmOpen(o); if (!o) setPendingCopyId(null); }}
        title="להחליף את התוכן הקיים?"
        description="בהצעה הזו כבר יש פריטים. ההעתקה תחליף אותם בפריטים של ההצעה הנבחרת. ההצעה המקורית לא משתנה."
        confirmLabel="החלף תוכן"
        busy={copyBusy}
        onConfirm={() => {
          const sid = pendingCopyId;
          setCopyConfirmOpen(false);
          setPendingCopyId(null);
          if (sid) void applyCopy(sid);
        }}
      />
    </div>
  );
}
// END OF FILE
