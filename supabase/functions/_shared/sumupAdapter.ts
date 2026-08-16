// Wama-Pay – SumUp-Adapter (implementiert PaymentProviderAdapter).
//
// Nutzt SumUps "Hosted Checkout": SumUp stellt eine eigene Zahlungsseite
// bereit (inkl. dortiger QR-Code-Anzeige/Wallet-Support), wir zeigen dem
// Kunden nur einen Link/QR-Code zu dieser Seite -- keine Kartendaten
// berühren je unseren Server (kein PCI-Scope bei uns).
// Quelle (offizielle SumUp-Doku, Stand der Recherche):
// https://developer.sumup.com/online-payments/checkouts/hosted-checkout
// https://developer.sumup.com/online-payments/webhooks
//
// Ablauf:
// 1. createCheckout() erstellt bei SumUp einen Checkout mit
//    hosted_checkout.enabled=true. Response enthält hosted_checkout_url --
//    das ist die URL, die wir dem Kunden als Link UND als QR-Code zeigen
//    (siehe webapp-checkout/verarbeitung.html).
// 2. "return_url" (server-seitig, NICHT das kundenseitige "redirect_url")
//    ist unser payment-webhook-Endpunkt -- ohne dieses Feld schickt SumUp
//    überhaupt keinen Webhook.
// 3. Der Webhook-Body selbst gilt nicht als vertrauenswürdig für den
//    Zahlungsstatus (SumUp-Webhooks sind bewusst "dünn"); autoritativ ist
//    immer ein GET auf die Checkout-Ressource (siehe resolveWebhookPayload).
// 4. Webhook-Authentizität wird per HMAC-SHA256-Signatur geprüft (Header
//    "x-payload-signature", Secret aus dem SumUp-Dashboard) -- echte
//    kryptographische Prüfung, kein Platzhalter-Mechanismus mehr.
//
// ⚠ Trotz offizieller Doku-Recherche mangels SumUp-Sandbox-Zugang nicht
// gegen die echte API getestet. Vor Produktivgang gegen einen echten
// SumUp-Account verifizieren (insbesondere: exakter Wert/Ort des
// Webhook-Signing-Secrets im SumUp-Dashboard).

import type { PaymentProviderAdapter, UnifiedCheckoutResult, UnifiedWebhookPayload } from "./paymentProviderAdapter.ts";

const SUMUP_API_BASE = "https://api.sumup.com";

function getApiKey(): string {
  const key = Deno.env.get("SUMUP_API_KEY");
  if (!key) throw new Error("SUMUP_API_KEY nicht gesetzt (Edge Function Secret fehlt).");
  return key;
}

function getMerchantCode(): string {
  const code = Deno.env.get("SUMUP_MERCHANT_CODE");
  if (!code) throw new Error("SUMUP_MERCHANT_CODE nicht gesetzt (Edge Function Secret fehlt).");
  return code;
}

function getWebhookSigningSecret(): string | null {
  return Deno.env.get("SUMUP_WEBHOOK_SIGNING_SECRET") ?? null;
}

function getCheckoutBaseUrl(): string {
  const url = Deno.env.get("WAMA_PAY_CHECKOUT_BASE_URL");
  if (!url) throw new Error("WAMA_PAY_CHECKOUT_BASE_URL nicht gesetzt (Edge Function Secret fehlt), z.B. https://vmenle.github.io/wama-pay/webapp-checkout");
  return url.replace(/\/$/, "");
}

function getOwnWebhookUrl(): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) throw new Error("SUPABASE_URL nicht gesetzt (sollte automatisch vorhanden sein).");
  return `${supabaseUrl}/functions/v1/payment-webhook?provider=sumup`;
}

async function sumupRequest(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUMUP_API_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`SumUp-API-Fehler (${res.status}) bei ${path}: ${JSON.stringify(body)}`);
  }

  return body as Record<string, unknown>;
}

// Offizielle Status-Werte lt. SumUp-Checkout-Schema: PENDING | EXPIRED | SUCCESSFUL.
function mapSumupStatus(sumupStatus: unknown): "paid" | "failed" | "pending" {
  const status = String(sumupStatus ?? "").toUpperCase();
  if (status === "SUCCESSFUL") return "paid";
  if (status === "EXPIRED") return "failed";
  return "pending"; // PENDING
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const sumupAdapter: PaymentProviderAdapter = {
  async createCheckout({ orderId, amountCents, currency, description }): Promise<UnifiedCheckoutResult> {
    const base = getCheckoutBaseUrl();

    const body = await sumupRequest("/v0.1/checkouts", {
      method: "POST",
      body: JSON.stringify({
        checkout_reference: orderId,
        amount: amountCents / 100,
        currency,
        merchant_code: getMerchantCode(),
        description,
        hosted_checkout: { enabled: true },
        // Wohin der Kunde NACH der Zahlung auf der SumUp-Seite zurückgeleitet wird.
        redirect_url: `${base}/verarbeitung.html?order=${encodeURIComponent(orderId)}`,
        // Server-zu-Server-Benachrichtigung -- ohne dieses Feld sendet SumUp
        // KEINEN Webhook.
        return_url: getOwnWebhookUrl(),
      }),
    });

    const checkoutId = body.id;
    const hostedCheckoutUrl = body.hosted_checkout_url;
    if (typeof checkoutId !== "string") {
      throw new Error(`SumUp-Antwort ohne Checkout-Id: ${JSON.stringify(body)}`);
    }
    if (typeof hostedCheckoutUrl !== "string") {
      throw new Error(`SumUp-Antwort ohne hosted_checkout_url (hosted_checkout.enabled evtl. nicht unterstützt für diesen Account?): ${JSON.stringify(body)}`);
    }

    return { providerRef: checkoutId, redirectUrl: hostedCheckoutUrl };
  },

  async verifyWebhookRequest(rawBody: string, headers: Headers): Promise<boolean> {
    const secret = getWebhookSigningSecret();
    if (!secret) {
      console.error("SUMUP_WEBHOOK_SIGNING_SECRET nicht gesetzt -- Webhook wird abgelehnt.");
      return false;
    }
    const provided = headers.get("x-payload-signature");
    if (!provided) {
      console.error("payment-webhook: Header x-payload-signature fehlt.");
      return false;
    }
    const expected = await hmacSha256Hex(secret, rawBody);
    return constantTimeEquals(provided.toLowerCase(), expected.toLowerCase());
  },

  async resolveWebhookPayload(rawBody: string): Promise<UnifiedWebhookPayload> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error("SumUp-Webhook-Body ist kein valides JSON.");
    }

    // SumUp-Webhooks enthalten typischerweise nur eine Checkout-Id, nicht
    // den vertrauenswürdigen Status selbst (siehe Datei-Kommentar oben).
    const checkoutId = (parsed.id ?? parsed.checkout_id ?? (parsed.resource as Record<string, unknown> | undefined)?.id) as string | undefined;
    if (!checkoutId) {
      throw new Error(`SumUp-Webhook ohne erkennbare Checkout-Id: ${rawBody}`);
    }

    const checkout = await sumupRequest(`/v0.1/checkouts/${checkoutId}`, { method: "GET" });

    return {
      orderRef: String(checkout.checkout_reference ?? checkoutId),
      status: mapSumupStatus(checkout.status),
      amountCents: Math.round(Number(checkout.amount ?? 0) * 100),
      currency: String(checkout.currency ?? "EUR"),
      paidAt: new Date().toISOString(),
    };
  },
};
