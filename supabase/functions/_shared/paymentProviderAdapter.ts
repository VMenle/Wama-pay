// Wama-Pay – providerunabhängiges Adapter-Interface.
// Siehe docs/payment-provider-adapter.md für den vollständigen Kontext.
// Ein neuer Provider bedeutet: neue Zeile in payment_providers + neues
// Modul, das dieses Interface implementiert + Eintrag in der
// PROVIDER_ADAPTERS-Dispatch-Tabelle unten. Datenbankschema, Freigabelogik,
// Idempotenz-Prüfung und restlicher Ablauf bleiben unverändert.

export type UnifiedPaymentStatus = "paid" | "failed" | "pending";

export interface UnifiedCheckoutResult {
  providerRef: string;
  redirectUrl?: string;
}

// Zwei grundverschiedene Abläufe, je nachdem ob der Provider eine
// dynamisch von uns angelegte Order bestätigt (SumUp Hosted Checkout:
// create-checkout legt zuerst die Order an) oder ob die Zahlung von einem
// statisch am Gerät angebrachten, provider-eigenen Zahlungsmittel kommt,
// für das es vorher gar keine Order gibt (PayPal-Payment-Button/QR-Code
// direkt am Gerät, IPN-basiert -- die Order wird erst beim Zahlungseingang
// rückwirkend angelegt).
export type UnifiedWebhookMode = "confirm_existing_order" | "create_order_for_device";

export interface UnifiedWebhookPayload {
  mode: UnifiedWebhookMode;
  // Bei "confirm_existing_order": entspricht orders.id (== provider_ref,
  // von create-checkout beim Anlegen als checkout_reference gesetzt).
  // Bei "create_order_for_device": entspricht devices.id -- die Referenz,
  // die beim statischen Zahlungsmittel als "Verwendungszweck"/"custom
  // field" hinterlegt wurde.
  ref: string;
  status: UnifiedPaymentStatus;
  amountCents: number;
  currency: string;
  paidAt: string; // ISO 8601
  // Nur bei "create_order_for_device" relevant: eindeutige
  // Provider-Transaktions-Id, wird als orders.provider_ref für Idempotenz
  // genutzt (siehe orders_provider_ref_unique_idx, Migration 0004) --
  // verhindert doppeltes Anlegen/Freigeben bei wiederholter Zustellung.
  providerTransactionId?: string;
}

export interface PaymentProviderAdapter {
  /**
   * Erstellt beim Provider eine Zahlungs-/Checkout-Session für eine Order.
   * Nur für Provider mit "confirm_existing_order"-Ablauf relevant; ein
   * reiner "create_order_for_device"-Provider (z.B. paypalAdapter) wirft
   * hier bewusst einen Fehler, siehe dortigen Kommentar.
   */
  createCheckout(params: {
    orderId: string;
    amountCents: number;
    currency: string;
    description: string;
  }): Promise<UnifiedCheckoutResult>;

  /** Prüft die Signatur/Authentizität des eingehenden Webhook-Requests. */
  verifyWebhookRequest(rawBody: string, headers: Headers): Promise<boolean>;

  /**
   * Übersetzt den providerspezifischen Webhook-/IPN-Payload in ein
   * einheitliches Format. Ruft bei Bedarf die Provider-API zur Bestätigung
   * ab (SumUp-Webhooks enthalten selbst keinen vertrauenswürdigen
   * Zahlungsstatus, siehe sumupAdapter.ts).
   */
  resolveWebhookPayload(rawBody: string): Promise<UnifiedWebhookPayload>;

  /**
   * Fragt den aktuellen Zahlungsstatus AKTIV beim Provider ab, ohne dass
   * vorher ein Webhook eingegangen sein muss -- Sicherheitsnetz, falls die
   * Webhook-Zustellung ausbleibt (siehe reconcile-provider-order/index.ts,
   * wird kurz nach Ablauf des Reservierungsfensters aufgerufen). Nur für
   * "confirm_existing_order"-Provider relevant; ein reiner
   * "create_order_for_device"-Provider (z.B. paypalAdapter) hat keinen
   * vergleichbaren Einzelabruf und wirft hier bewusst einen Fehler.
   */
  getStatusByRef(providerRef: string): Promise<UnifiedWebhookPayload>;
}

// Dispatch-Tabelle: payment_providers.id -> Adapter-Instanz. Wird von
// payment-webhook/index.ts und create-checkout/index.ts genutzt.
import { sumupAdapter } from "./sumupAdapter.ts";
import { paypalAdapter } from "./paypalAdapter.ts";

export const PROVIDER_ADAPTERS: Record<string, PaymentProviderAdapter> = {
  sumup: sumupAdapter,
  paypal: paypalAdapter,
};
