// Wama-Pay – Edge Function "payment-webhook"
//
// Providerunabhängiger Einstiegspunkt für Zahlungsbestätigungen (siehe
// docs/payment-provider-adapter.md). Welcher Adapter genutzt wird, steuert
// der Query-Parameter "provider" in der beim Provider hinterlegten
// Webhook-URL, z.B.:
//   https://<project-ref>.functions.supabase.co/payment-webhook?provider=sumup
//
// Ablauf: Signatur/Secret prüfen -> autoritativen Zahlungsstatus beim
// Provider abrufen (niemals dem Webhook-Body selbst vertrauen) -> Order
// idempotent auf 'paid'/'released'/'failed' überführen -> n8n-Folgeaufgaben
// anstoßen (Beleg-Mail, "Maschine fertig"-Wächter).
import { jsonResponse } from "../_shared/cors.ts";
import { createSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { PROVIDER_ADAPTERS } from "../_shared/paymentProviderAdapter.ts";
import { markOrderFailed, markOrderPaid, releaseOrder } from "../_shared/orderLifecycle.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const providerId = url.searchParams.get("provider");
  const adapter = providerId ? PROVIDER_ADAPTERS[providerId] : undefined;

  if (!providerId || !adapter) {
    console.error(`payment-webhook: unbekannter/fehlender Provider '${providerId}'.`);
    return jsonResponse({ error: "unknown_provider" }, 400);
  }

  const rawBody = await req.text();

  const verified = await adapter.verifyWebhookRequest(rawBody, req.headers);
  if (!verified) {
    console.error(`payment-webhook: Verifikation für Provider '${providerId}' fehlgeschlagen.`);
    return jsonResponse({ error: "verification_failed" }, 401);
  }

  const supabase = createSupabaseAdminClient();

  let payload;
  try {
    payload = await adapter.resolveWebhookPayload(rawBody);
  } catch (err) {
    console.error("payment-webhook: resolveWebhookPayload fehlgeschlagen:", err);
    return jsonResponse({ error: "payload_resolution_failed" }, 502);
  }

  // orderRef entspricht orders.id (siehe createCheckout: checkout_reference
  // wird beim Anlegen der SumUp-Session auf die Order-Id gesetzt).
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, project_id, device_id, status")
    .eq("id", payload.orderRef)
    .single();

  if (orderError || !order) {
    console.error(`payment-webhook: Order '${payload.orderRef}' nicht gefunden.`);
    return jsonResponse({ error: "order_not_found" }, 404);
  }

  // Idempotenz: bereits final verarbeitete Orders werden ignoriert, egal
  // wie oft der Provider den Webhook erneut zustellt.
  if (order.status === "released" || order.status === "failed" || order.status === "refunded") {
    return jsonResponse({ ok: true, status: order.status, note: "already_processed" });
  }

  try {
    if (payload.status === "paid") {
      if (order.status === "reserved" || order.status === "payment_pending") {
        await markOrderPaid(supabase, order);
      }
      // Erneutes Laden, falls markOrderPaid gerade erst übergeführt hat.
      await releaseOrder(supabase, { id: order.id, project_id: order.project_id, device_id: order.device_id });
    } else if (payload.status === "failed") {
      if (order.status === "reserved" || order.status === "payment_pending") {
        await markOrderFailed(supabase, order, "provider_reported_failed");
      }
    }
    // status === 'pending': keine Aktion, auf nächsten Webhook warten.
  } catch (err) {
    console.error("payment-webhook: Verarbeitung fehlgeschlagen:", err);
    return jsonResponse({ error: "processing_failed" }, 500);
  }

  return jsonResponse({ ok: true });
});
