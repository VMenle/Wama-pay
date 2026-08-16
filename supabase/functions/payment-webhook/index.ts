// Wama-Pay – Edge Function "payment-webhook"
//
// Providerunabhängiger Einstiegspunkt für Zahlungsbestätigungen (siehe
// docs/payment-provider-adapter.md). Welcher Adapter genutzt wird, steuert
// der Query-Parameter "provider" in der beim Provider hinterlegten
// Webhook-URL, z.B.:
//   https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=sumup
//   https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=paypal
//
// Zwei grundverschiedene Abläufe (siehe UnifiedWebhookMode in
// _shared/paymentProviderAdapter.ts):
//   - "confirm_existing_order" (SumUp): create-checkout hat die Order
//     bereits vorher angelegt, hier wird sie nur noch bestätigt/freigegeben.
//   - "create_order_for_device" (PayPal): statisches Zahlungsmittel direkt
//     am Gerät, keine vorherige Order -- wird beim Zahlungseingang
//     rückwirkend angelegt.
//
// In beiden Fällen gilt: Signatur/Secret prüfen -> autoritativen
// Zahlungsstatus (niemals dem Webhook-Body selbst vertrauen, siehe
// jeweiligen Adapter) -> Order idempotent überführen -> n8n-Folgeaufgaben
// anstoßen (Beleg-Mail, "Maschine fertig"-Wächter).
import { jsonResponse } from "../_shared/cors.ts";
import { createSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { PROVIDER_ADAPTERS } from "../_shared/paymentProviderAdapter.ts";
import { createAndReleaseOrderForDevice, markOrderFailed, markOrderPaid, releaseOrder } from "../_shared/orderLifecycle.ts";

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

  // ---------------------------------------------------------------------
  // Zweig 1: statisches Zahlungsmittel direkt am Gerät (z.B. PayPal) --
  // keine vorherige Order, wird jetzt beim Zahlungseingang angelegt.
  // ---------------------------------------------------------------------
  if (payload.mode === "create_order_for_device") {
    if (payload.status !== "paid") {
      // 'pending'/'failed' ohne vorherige Reservierung: nichts zu tun,
      // es gibt keine Order, die abgebrochen werden müsste.
      return jsonResponse({ ok: true, note: "no_action_needed_for_status" });
    }

    try {
      const result = await createAndReleaseOrderForDevice(supabase, {
        deviceId: payload.ref,
        providerId,
        providerRef: payload.providerTransactionId ?? payload.ref,
        amountCents: payload.amountCents,
        currency: payload.currency,
      });
      return jsonResponse({ ok: true, result });
    } catch (err) {
      console.error("payment-webhook: createAndReleaseOrderForDevice fehlgeschlagen:", err);
      return jsonResponse({ error: "processing_failed" }, 500);
    }
  }

  // ---------------------------------------------------------------------
  // Zweig 2: bestehende, von create-checkout angelegte Order bestätigen
  // (SumUp Hosted Checkout).
  // ---------------------------------------------------------------------
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, project_id, device_id, status")
    .eq("id", payload.ref)
    .single();

  if (orderError || !order) {
    console.error(`payment-webhook: Order '${payload.ref}' nicht gefunden.`);
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
