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

export interface UnifiedWebhookPayload {
  orderRef: string; // korrespondiert mit orders.provider_ref bzw. orders.id
  status: UnifiedPaymentStatus;
  amountCents: number;
  currency: string;
  paidAt: string; // ISO 8601
}

export interface PaymentProviderAdapter {
  /** Erstellt beim Provider eine Zahlungs-/Checkout-Session für eine Order. */
  createCheckout(params: {
    orderId: string;
    amountCents: number;
    currency: string;
    description: string;
  }): Promise<UnifiedCheckoutResult>;

  /** Prüft die Signatur/Authentizität des eingehenden Webhook-Requests. */
  verifyWebhookRequest(rawBody: string, headers: Headers): Promise<boolean>;

  /**
   * Übersetzt den providerspezifischen Webhook-Payload in ein einheitliches
   * Format. Ruft bei Bedarf die Provider-API zur Bestätigung ab (SumUp-
   * Webhooks enthalten selbst keinen vertrauenswürdigen Zahlungsstatus,
   * siehe sumupAdapter.ts).
   */
  resolveWebhookPayload(rawBody: string): Promise<UnifiedWebhookPayload>;
}

// Dispatch-Tabelle: payment_providers.id -> Adapter-Instanz. Wird von
// payment-webhook/index.ts und create-checkout/index.ts genutzt.
import { sumupAdapter } from "./sumupAdapter.ts";

export const PROVIDER_ADAPTERS: Record<string, PaymentProviderAdapter> = {
  sumup: sumupAdapter,
};
