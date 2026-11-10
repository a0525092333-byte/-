import { db } from "@/integrations/neon/client";
import type { Client } from "./types";

const NIQQUD = /[\u0591-\u05C7]/g;

export type NewClientInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  extra_email?: string | null;
  company?: string | null;
  address?: string | null;
  tax_id?: string | null;
  contact_name?: string | null;
  notes?: string | null;
};

/** Lowercase, trim, collapse inner whitespace and strip Hebrew niqqud. */
export function normalizeClientName(name: string | null | undefined): string {
  return (name ?? "")
    .replace(NIQQUD, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function findClientByName(clients: Client[], name: string): Client | undefined {
  const key = normalizeClientName(name);
  if (!key) return undefined;
  return clients.find((client) => normalizeClientName(client.name) === key);
}

async function loadAllClients(): Promise<Client[]> {
  const pageSize = 1000;
  const all: Client[] = [];
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const { data, error } = await db
      .from<Client[]>("clients")
      .select("id,name")
      .order("created_at", { ascending: true })
      .limit(pageSize)
      .offset(offset);
    if (error) break;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/** Update an existing client by id (one shared edit path). */
export async function updateClient(
  id: string,
  input: NewClientInput,
): Promise<{ error: { message: string; code?: string } | null }> {
  const { error } = await db
    .from("clients")
    .update({
      name: input.name.trim(),
      contact_name: input.contact_name?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      extra_email: input.extra_email?.trim() || null,
      company: input.company?.trim() || null,
      address: input.address?.trim() || null,
      tax_id: input.tax_id?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .eq("id", id);
  return { error };
}

/**
 * Create a client, but reuse an existing row when the normalized name already
 * exists. Only non-empty fields are written on reuse, so a quick-add with just
 * a name never blanks the existing phone/email/address/notes.
 */
export async function createClient(input: NewClientInput): Promise<{
  id: string | null;
  error: { message: string; code?: string } | null;
  reused: boolean;
}> {
  const payload = {
    name: input.name.trim(),
    contact_name: input.contact_name?.trim() || null,
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    extra_email: input.extra_email?.trim() || null,
    company: input.company?.trim() || null,
    address: input.address?.trim() || null,
    tax_id: input.tax_id?.trim() || null,
    notes: input.notes?.trim() || null,
  };

  const existing = findClientByName(await loadAllClients(), payload.name);
  if (existing) {
    const patch: Record<string, string> = {};
    for (const key of ["contact_name", "phone", "email", "extra_email", "company", "address", "tax_id", "notes"] as const) {
      const value = payload[key];
      if (value) patch[key] = value;
    }
    if (!Object.keys(patch).length) return { id: existing.id, error: null, reused: true };
    const { error } = await db.from("clients").update(patch).eq("id", existing.id);
    return { id: error ? null : existing.id, error, reused: true };
  }

  const id = crypto.randomUUID();
  const { error } = await db.from("clients").insert({
    id,
    ...payload,
    created_at: new Date().toISOString(),
  });
  return { id: error ? null : id, error, reused: false };
}
