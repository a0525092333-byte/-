import { db } from "@/integrations/neon/client";
import type { ClientContact } from "./types";

export type ClientContactInput = {
  full_name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** Read a client's additional contacts. A missing table/error degrades to []. */
export async function listContacts(clientId: string): Promise<ClientContact[]> {
  if (!clientId) return [];
  const { data, error } = await db
    .from<ClientContact[]>("client_contacts")
    .select("*")
    .eq("client_id", clientId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Replace a client's additional contacts (delete-then-insert). */
export async function saveContacts(
  clientId: string,
  rows: ClientContactInput[],
): Promise<{ error: { message: string; code?: string } | null }> {
  if (!clientId) return { error: null };
  const clean = rows
    .map((row, index) => ({
      id: crypto.randomUUID(),
      client_id: clientId,
      full_name: row.full_name.trim(),
      role: row.role?.trim() || null,
      email: row.email?.trim() || null,
      phone: row.phone?.trim() || null,
      sort_order: index,
    }))
    .filter((row) => row.full_name);
  // Insert the new rows first, then delete the old ones: a failed insert must
  // never wipe the client's existing contacts.
  const existing = await db.from<{ id: string }[]>("client_contacts").select("id").eq("client_id", clientId);
  if (existing.error) return { error: existing.error };
  const oldIds = (existing.data ?? []).map((row) => row.id);
  if (clean.length) {
    const inserted = await db.from("client_contacts").insert(clean);
    if (inserted.error) return { error: inserted.error };
  }
  if (oldIds.length) {
    const removed = await db.from("client_contacts").delete().in("id", oldIds);
    if (removed.error) return { error: removed.error };
  }
  return { error: null };
}
