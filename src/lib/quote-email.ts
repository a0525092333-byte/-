import { getAccessToken } from "@/integrations/neon/auth";

export async function sendQuoteEmail(
  quoteId: string,
  to: string,
  message: string,
): Promise<{ ok: true; to: string } | { ok: false; message: string }> {
  try {
    const token = await getAccessToken().catch(() => null);
    const res = await fetch(`/api/quotes/${quoteId}/send-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ to, message }),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      return { ok: false, message: data?.message || "שליחת ההצעה נכשלה" };
    }
    return { ok: true, to: data.to };
  } catch {
    return { ok: false, message: "לא הצלחנו לשלוח את ההצעה — בדוק את החיבור ונסה שוב" };
  }
}
