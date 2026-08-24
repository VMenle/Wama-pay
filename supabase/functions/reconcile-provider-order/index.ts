// Wama-Pay – Edge Function "reconcile-provider-order"
//
// Sicherheitsnetz für den Fall, dass die Webhook-Zustellung eines
// Zahlungsanbieters ausbleibt (SumUp garantiert Zustellung nicht -- siehe
// Vorfall: echte Zahlung erfolgreich, aber payment-webhook nie aufgerufen).
//
// Wird zu mehreren Zeitpunkten pro Reservierung aufgerufen (siehe
// Migration 0024, schedule_reservation_expiry_check(), und
// create-checkout/index.ts):
// - Frühe, NICHT-finale Checks (is_final=false, 1/2/3 Minuten nach der
//   Reservierung): erkennen nur eine bereits erfolgreiche Zahlung vorzeitig
//   vor. Meldet der Provider weiterhin "pending", passiert NICHTS -- die
//   Reservierung bleibt bestehen (der Kunde könnte noch mitten in der
//   Zahlung sein).
// - Ein finaler Check (is_final=true, exakt am Ende des 15-Minuten-
//   Reservierungsfensters): meldet der Provider dann immer noch nichts
//   Endgültiges, wird die Reservierung abgebrochen und das Gerät wieder
//   freigegeben -- exakt wie bisher expire_stale_reservations() das für
//   liegengebliebene Reservierungen tat.
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

  let body: { order_id?: string; is_final?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const orderId = body.order_id;
  const isFinal = body.is_final === true;
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

      // Der Provider-Aufruf oben braucht Zeit (Netzwerk) -- in der
      // Zwischenzeit könnte der echte Webhook die Order längst final
      // verarbeitet haben. Status deshalb unmittelbar vor dem Anwenden
      // NOCHMAL frisch laden, statt mit dem eingangs geladenen (ggf.
      // inzwischen veralteten) Stand weiterzuarbeiten -- sonst könnte
      // die Freigabe (inkl. Schaltlink-Aufruf) doppelt ausgelöst werden.
      const { data: freshOrder, error: freshOrderError } = await supabase
        .from("orders")
        .select("id, project_id, device_id, status")
        .eq("id", order.id)
        .single();

      if (freshOrderError || !freshOrder) {
        console.error(`reconcile-provider-order: Order '${order.id}' beim erneuten Laden nicht gefunden.`);
        return jsonResponse({ error: "order_not_found" }, 404);
      }

      const outcome = await confirmProviderOrder(supabase, freshOrder, { status: payload.status }, "active_reconciliation");
      console.log(`reconcile-provider-order: Order '${order.id}' (is_final=${isFinal}) -> ${outcome} (Provider meldet: ${payload.status}).`);
      if (outcome !== "no_action") {
        return jsonResponse({ ok: true, outcome });
      }
      // Provider meldet weiterhin 'pending'.
    } catch (err) {
      console.error(`reconcile-provider-order: Aktive Statusabfrage bei Provider '${order.provider_id}' fehlgeschlagen:`, err);
    }
  }

  // Weiterhin unbestätigt: bei einem frühen (nicht-finalen) Check ist das
  // normal -- die Reservierung bleibt bestehen, kein Abbruch. Erst der
  // finale Check am Ende des Reservierungsfensters bricht tatsächlich ab.
  if (!isFinal) {
    return jsonResponse({ ok: true, outcome: "still_pending" });
  }

  // Auch hier nochmal frisch laden (siehe Kommentar oben) -- markOrderFailed
  // selbst prüft zwar den Status defensiv (nur aus reserved/payment_pending
  // heraus), ein aktueller Stand vermeidet aber unnötige No-Op-Aufrufe.
  const { data: finalOrder } = await supabase
    .from("orders")
    .select("id, project_id, device_id, status")
    .eq("id", order.id)
    .single();

  if (finalOrder && finalOrder.status !== "reserved" && finalOrder.status !== "payment_pending") {
    return jsonResponse({ ok: true, outcome: "already_processed" });
  }

  await markOrderFailed(supabase, finalOrder ?? order, "reservation_timeout_after_reconcile");
  return jsonResponse({ ok: true, outcome: "expired" });
});
