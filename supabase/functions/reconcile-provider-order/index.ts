// Wama-Pay – Edge Function "reconcile-provider-order"
//
// Sicherheitsnetz für den Fall, dass die Webhook-Zustellung eines
// Zahlungsanbieters ausbleibt (SumUp garantiert Zustellung nicht -- siehe
// Vorfall: echte Zahlung erfolgreich, aber payment-webhook nie aufgerufen).
//
// Wird kurz nach Ablauf des Reservierungsfensters aufgerufen (siehe
// Migration 0024, schedule_reservation_expiry_check() -- derselbe
// einmalige, selbst-entfernende pg_cron-Job-Mechanismus wie zuvor, ruft
// jetzt diese Function statt nur expire_stale_reservations() direkt).
//
// Ablauf: Order laden -> falls noch nicht final verarbeitet -> AKTIV beim
// Provider nachfragen (adapter.getStatusByRef) -> denselben idempotenten
// Bestätigungs-Ablauf wie der echte Webhook durchlaufen
// (confirmProviderOrder). Meldet der Provider immer noch "pending" (oder
// schlägt die Abfrage fehl), gilt die Reservierung als abgelaufen -- Order
// wird auf 'failed' gesetzt, Gerät wieder freigegeben, exakt wie bisher
// expire_stale_reservations() das für liegengebliebene Reservierungen tat.
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";
import { createSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { PROVIDER_ADAPTERS } from "../_shared/paymentProviderAdapter.ts";
import { confirmProviderOrder, markOrderFailed } from "../_shared/orderLifecycle.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const orderId = body.order_id;
  if (!orderId) {
    return jsonResponse({ error: "missing_order_id" }, 400);
  }

  const supabase = createSupabaseAdminClient();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, project_id, device_id, status, provider_id, provider_ref")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    console.error(`reconcile-provider-order: Order '${orderId}' nicht gefunden.`);
    return jsonResponse({ error: "order_not_found" }, 404);
  }

  if (order.status !== "reserved" && order.status !== "payment_pending") {
    // Längst final -- z.B. weil der echte Webhook doch noch rechtzeitig kam.
    return jsonResponse({ ok: true, outcome: "already_processed" });
  }

  const adapter = order.provider_id ? PROVIDER_ADAPTERS[order.provider_id] : undefined;

  if (adapter && order.provider_ref) {
    try {
      const payload = await adapter.getStatusByRef(order.provider_ref);
      const outcome = await confirmProviderOrder(supabase, order, { status: payload.status });
      console.log(`reconcile-provider-order: Order '${order.id}' -> ${outcome} (Provider meldet: ${payload.status}).`);
      if (outcome !== "no_action") {
        return jsonResponse({ ok: true, outcome });
      }
      // Provider meldet weiterhin 'pending' -- Reservierungsfenster ist
      // trotzdem abgelaufen, fällt unten auf denselben Timeout-Pfad wie
      // expire_stale_reservations() zurück.
    } catch (err) {
      console.error(`reconcile-provider-order: Aktive Statusabfrage bei Provider '${order.provider_id}' fehlgeschlagen:`, err);
      // fällt ebenfalls auf den Timeout-Pfad unten zurück.
    }
  }

  await markOrderFailed(supabase, order, "reservation_timeout_after_reconcile");
  return jsonResponse({ ok: true, outcome: "expired" });
});
