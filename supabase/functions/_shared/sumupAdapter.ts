// Wama-Pay – SumUp-Adapter (implementiert PaymentProviderAdapter).
//
// ⚠ HINWEIS: Diese Anbindung folgt der öffentlich dokumentierten SumUp
// REST-API v0.1 (Checkouts-Ressource), konnte hier aber mangels echtem
// SumUp-Merchant-Zugang NICHT gegen die echte API getestet werden. Vor dem
// Produktivgang bitte gegen einen SumUp-Sandbox-Account verifizieren
// (Endpunkt-Pfade, exakte Feldnamen, Webhook-Payload-Form).
//
// Sicherheitsmodell für den Webhook: SumUp signiert Webhooks nicht
// standardmäßig, und der Webhook-Body selbst ist bewusst NICHT
// vertrauenswürdig für den Zahlungsstatus (könnte gefälscht werden). Daher:
// 1. verifyWebhookRequest prüft ein geteiltes Geheimnis (Query-Parameter
//    ?token=..., beim Einrichten der Webhook-URL im SumUp-Dashboard
//    mitzugeben) als erste Hürde gegen zufällige/böswillige Aufrufe.
// 2. resolveWebhookPayload holt den tatsächlichen Zahlungsstatus IMMER
//    autoritativ per GET von der SumUp-API ab (mit unserem eigenen API-Key),
//    statt Felder aus dem Webhook-Body zu übernehmen. Ein Angreifer, der den
//    Webhook-Endpunkt kennt, kann so höchstens einen (harmlosen) Re-Sync
//    auslösen, aber keinen falschen "paid"-Status erzeugen.

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

function getWebhookSharedSecret(): string | null {
  return Deno.env.get("SUMUP_WEBHOOK_SHARED_SECRET") ?? null;
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

function mapSumupStatus(sumupStatus: unknown): "paid" | "failed" | "pending" {
  const status = String(sumupStatus ?? "").toUpperCase();
  if (status === "PAID") return "paid";
  if (status === "FAILED") return "failed";
  return "pending"; // z.B. PENDING
}

export const sumupAdapter: PaymentProviderAdapter = {
  async createCheckout({ orderId, amountCents, currency, description }): Promise<UnifiedCheckoutResult> {
    const body = await sumupRequest("/v0.1/checkouts", {
      method: "POST",
      body: JSON.stringify({
        checkout_reference: orderId,
        amount: amountCents / 100,
        currency,
        merchant_code: getMerchantCode(),
        description,
      }),
    });

    const checkoutId = body.id;
    if (typeof checkoutId !== "string") {
      throw new Error(`SumUp-Antwort ohne Checkout-Id: ${JSON.stringify(body)}`);
    }

    // TODO: Prüfen, ob für den gewählten Checkout-UX-Weg (gehostete
    // SumUp-Seite vs. eingebettetes Card-Widget mit dieser Checkout-Id)
    // zusätzlich eine redirectUrl aus der Antwort übernommen werden muss.
    return { providerRef: checkoutId };
  },

  async verifyWebhookRequest(_rawBody: string, headers: Headers): Promise<boolean> {
    const expected = getWebhookSharedSecret();
    if (!expected) {
      // Kein Secret konfiguriert -> Verifikation kann nicht durchgeführt
      // werden. Bewusst FEHLSCHLAGEN statt stillschweigend zu akzeptieren.
      console.error("SUMUP_WEBHOOK_SHARED_SECRET nicht gesetzt -- Webhook wird abgelehnt.");
      return false;
    }
    const provided = headers.get("x-wama-pay-webhook-token");
    return provided === expected;
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
