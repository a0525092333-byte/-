import { getAccessToken } from "@/integrations/neon/auth";

export async function sendInviteEmail(
  inviteId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch("/api/invites/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ invite_id: inviteId }),
    });
    const text = await res.text();
    let data: { ok?: boolean; message?: string } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      return { ok: false, message: data?.message || "שליחת ההזמנה נכשלה" };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "לא הצלחנו לשלוח את ההזמנה — בדוק את החיבור ונסה שוב" };
  }
}
