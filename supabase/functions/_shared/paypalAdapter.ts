// Wama-Pay – PayPal-Adapter (implementiert PaymentProviderAdapter).
//
// Anders als SumUp läuft PayPal bei Wama-Pay NICHT über die Webapp/
// create-checkout, sondern über einen statisch am Gerät angebrachten
// PayPal-"Payment Button" (mit QR-Code), einmalig im PayPal-Business-
// Account des Betreibers angelegt -- kein API-Aufruf unsererseits nötig,
// um ihn zu erstellen. Dafür MUSS beim Anlegen des Buttons ein
// verstecktes Feld "custom" (oder "item_number") auf den Wama-Pay
// devices.device_code dieser Maschine gesetzt werden (kurzer, menschen-
// lesbarer Code wie "AA111", siehe Migration 0023 -- NICHT die interne
// UUID) -- darüber ordnen wir die eingehende Zahlung dem richtigen Gerät zu.
//
// Ablauf: Kunde scannt den QR-Code, zahlt direkt auf PayPals Seite, PayPal
// schickt anschließend eine klassische IPN (Instant Payment Notification)
// -- ein POST mit application/x-www-form-urlencoded-Body -- an
// payment-webhook?provider=paypal. Da es für diese Zahlung noch KEINE
// Order gibt (nichts wurde vorher bei uns reserviert), wird sie beim
// Zahlungseingang rückwirkend angelegt (siehe
// _shared/orderLifecycle.ts::createAndReleaseOrderForDevice und
// payment-webhook/index.ts, Zweig "create_order_for_device").
//
// Sicherheit: IPN-Authentizität wird über den offiziellen PayPal-
// "Postback"-Mechanismus geprüft -- der empfangene Body wird unverändert,
// nur um "cmd=_notify-validate" ergänzt, an PayPal zurückgeschickt; PayPal
// antwortet mit dem reinen Text "VERIFIED" oder "INVALID". Kein API-Key
// nötig, kein Secret zu verwalten.
//
// ⚠ Mangels PayPal-Account-Zugang nicht gegen einen echten Payment Button
// getestet. Vor Produktivgang: Payment Button im PayPal-Business-Account
// anlegen, "custom"-Feld korrekt setzen, IPN-Benachrichtigungs-URL auf
// payment-webhook?provider=paypal zeigen lassen (Account-Einstellungen ->
// "Instant Payment Notifications").

import type { PaymentProviderAdapter, UnifiedCheckoutResult, UnifiedWebhookPayload } from "./paymentProviderAdapter.ts";

function getIpnVerifyUrl(): string {
  // Für Tests gegen die PayPal-Sandbox: PAYPAL_IPN_VERIFY_URL auf
  // https://ipnpb.sandbox.paypal.com/cgi-bin/webscr setzen.
  return Deno.env.get("PAYPAL_IPN_VERIFY_URL") ?? "https://ipnpb.paypal.com/cgi-bin/webscr";
}

export const paypalAdapter: PaymentProviderAdapter = {
  async createCheckout(): Promise<UnifiedCheckoutResult> {
    throw new Error(
      "paypalAdapter.createCheckout ist absichtlich nicht implementiert -- PayPal läuft bei Wama-Pay " +
      "ausschließlich über einen statisch am Gerät angebrachten Payment-Button/QR-Code (IPN-basiert), " +
      "nicht über den dynamischen create-checkout-Ablauf. Siehe Kommentar am Anfang dieser Datei."
    );
  },

  async verifyWebhookRequest(rawBody: string, _headers: Headers): Promise<boolean> {
    const verifyBody = `cmd=_notify-validate&${rawBody}`;
    const res = await fetch(getIpnVerifyUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // PayPal verlangt einen User-Agent im Postback.
        "User-Agent": "Wama-Pay-IPN-Verification",
      },
      body: verifyBody,
    });

    if (!res.ok) {
      console.error(`PayPal-IPN-Verifikation fehlgeschlagen: HTTP ${res.status}`);
      return false;
    }

    const text = await res.text();
    return text.trim() === "VERIFIED";
  },

  async resolveWebhookPayload(rawBody: string): Promise<UnifiedWebhookPayload> {
    const params = new URLSearchParams(rawBody);

    const deviceCode = params.get("custom") || params.get("item_number");
    const txnId = params.get("txn_id");
    const paymentStatus = params.get("payment_status") ?? "";

    if (!deviceCode) {
      throw new Error(`PayPal-IPN ohne 'custom'/'item_number' (Geräte-Referenz fehlt): ${rawBody}`);
    }
    if (!txnId) {
      throw new Error(`PayPal-IPN ohne txn_id (für Idempotenz zwingend nötig): ${rawBody}`);
    }

    let status: "paid" | "failed" | "pending" = "pending";
    if (paymentStatus === "Completed") status = "paid";
    else if (["Failed", "Denied", "Voided", "Expired"].includes(paymentStatus)) status = "failed";

    return {
      mode: "create_order_for_device",
      ref: deviceCode,
      status,
      amountCents: Math.round(Number(params.get("mc_gross") ?? "0") * 100),
      currency: String(params.get("mc_currency") ?? "EUR"),
      paidAt: new Date().toISOString(),
      providerTransactionId: txnId,
    };
  },

  async getStatusByRef(): Promise<UnifiedWebhookPayload> {
    throw new Error(
      "paypalAdapter.getStatusByRef ist absichtlich nicht implementiert -- PayPal legt bei Wama-Pay nie eine " +
      "vorab reservierte Order an (siehe createCheckout-Kommentar), es gibt also nichts, das aktiv nachgefragt " +
      "werden müsste. Die Aufräum-Logik für den PayPal-Weg läuft ausschließlich über die IPN selbst."
    );
  },
};
