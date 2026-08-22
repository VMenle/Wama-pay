// Wama-Pay – Edge Function "create-checkout"
//
// Wird von der Checkout-Webapp (webapp-checkout/bezahlen.html) aufgerufen,
// wenn der Kunde eine Zahlweise wählt. Reserviert das Gerät atomar, legt die
// Order an und startet je nach Zahlweise entweder direkt die
// Wallet-Abbuchung (synchron, kein Webhook nötig) oder eine
// Provider-Checkout-Session (SumUp) -- deren Bestätigung dann asynchron über
// payment-webhook hereinkommt.
//
// POST-Body: { device_id: string, payment_method: 'provider' | 'wallet' }
// Authorization-Header (optional): Bearer <Supabase-User-JWT> -- nötig für
// payment_method 'wallet', optional bei 'provider' (Order wird dann trotzdem
// dem Kundenkonto zugeordnet, falls eingeloggt).
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";
import { createSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { PROVIDER_ADAPTERS } from "../_shared/paymentProviderAdapter.ts";
import { markOrderFailed, markOrderPaid, releaseOrder, triggerN8n } from "../_shared/orderLifecycle.ts";

// Wie lange eine Reservierung ohne Zahlungsbestätigung gültig bleibt, bevor
// der n8n-Cron-Workflow "reservation-timeout-guard" sie aufräumt (siehe
// supabase/migrations/0011_reservation_timeout_guard.sql).
const RESERVATION_WINDOW_MINUTES = 15;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body: { device_id?: string; payment_method?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const deviceId = body.device_id;
  const paymentMethod = body.payment_method;

  if (!deviceId || (paymentMethod !== "provider" && paymentMethod !== "wallet")) {
    return jsonResponse({ error: "invalid_request", detail: "device_id und payment_method ('provider'|'wallet') erforderlich." }, 400);
  }

  const supabase = createSupabaseAdminClient();

  // Optionaler eingeloggter Kunde: Authorization-Header enthält das
  // User-JWT aus der Browser-Session (nicht den anon-Key).
  let customerId: string | null = null;
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (!userError && userData?.user) {
      customerId = userData.user.id;
    }
  }

  if (paymentMethod === "wallet" && !customerId) {
    return jsonResponse({ error: "login_required", detail: "Guthaben-Zahlung erfordert ein eingeloggtes Kundenkonto." }, 401);
  }

  // Gerät + Produkt (Preis) laden.
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, type, label, status, project_id, location_id")
    .eq("id", deviceId)
    .single();

  if (deviceError || !device) {
    return jsonResponse({ error: "device_not_found" }, 404);
  }
  if (device.status !== "free") {
    return jsonResponse({ error: "device_not_available", detail: `Gerät ist aktuell '${device.status}'.` }, 409);
  }

  const { data: products, error: productError } = await supabase
    .from("products")
    .select("id, name, price_cents, currency, location_id")
    .eq("project_id", device.project_id)
    .eq("device_type", device.type)
    .eq("is_active", true)
    .or(`location_id.eq.${device.location_id},location_id.is.null`);

  if (productError || !products || products.length === 0) {
    return jsonResponse({ error: "no_active_product", detail: "Kein aktiver Preis für dieses Gerät konfiguriert." }, 500);
  }
  // Standortspezifischer Preis hat Vorrang vor einem projektweiten Preis.
  const product = products.find((p) => p.location_id === device.location_id) ?? products[0];

  let providerId: string | null = null;
  if (paymentMethod === "provider") {
    const { data: provider, error: providerError } = await supabase
      .from("payment_providers")
      .select("id")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (providerError || !provider) {
      return jsonResponse({ error: "no_active_payment_provider" }, 500);
    }
    providerId = provider.id;
  }

  // Order anlegen (Status 'reserved'), danach Gerät ATOMAR beanspruchen
  // (nur wenn es zwischenzeitlich nicht von einem anderen Checkout
  // übernommen wurde). Reihenfolge ist bewusst so: die Order braucht keine
  // device.current_order_id-Referenz, um zu existieren, das Gerät aber eine
  // gültige order.id.
  const reservationExpiresAt = new Date(Date.now() + RESERVATION_WINDOW_MINUTES * 60_000).toISOString();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      project_id: device.project_id,
      device_id: device.id,
      product_id: product.id,
      customer_id: customerId,
      payment_method: paymentMethod,
      provider_id: providerId,
      amount_cents: product.price_cents,
      currency: product.currency,
      status: "reserved",
      reservation_expires_at: reservationExpiresAt,
    })
    .select("id, project_id, device_id")
    .single();

  if (orderError || !order) {
    return jsonResponse({ error: "order_creation_failed", detail: orderError?.message }, 500);
  }

  const { data: claimedDevice, error: claimError } = await supabase
    .from("devices")
    .update({ status: "busy", current_order_id: order.id })
    .eq("id", device.id)
    .eq("status", "free")
    .select("id")
    .maybeSingle();

  if (claimError || !claimedDevice) {
    // Gerät wurde zwischen dem SELECT oben und diesem UPDATE von einem
    // anderen Checkout übernommen -- Order wieder verwerfen, sie hat noch
    // keine Nebenwirkungen (keine Zahlung, keine Wallet-Buchung) ausgelöst.
    await supabase.from("orders").delete().eq("id", order.id);
    return jsonResponse({ error: "device_not_available", detail: "Gerät wurde soeben anderweitig reserviert." }, 409);
  }

  if (paymentMethod === "wallet") {
    const { error: walletError } = await supabase.from("wallet_transactions").insert({
      customer_id: customerId,
      project_id: device.project_id,
      type: "consumption",
      amount_washes: -1,
      related_order_id: order.id,
      note: `Bezahlung: ${product.name} (${device.label})`,
    });

    if (walletError) {
      await markOrderFailed(supabase, order, `wallet_debit_failed: ${walletError.message}`);
      return jsonResponse({ error: "insufficient_wallet_balance" }, 402);
    }

    await markOrderPaid(supabase, order);
    await releaseOrder(supabase, order);

    return jsonResponse({ order_id: order.id, status: "released" });
  }

  // payment_method === 'provider': SumUp-Checkout-Session erstellen.
  const adapter = PROVIDER_ADAPTERS[providerId as string];
  if (!adapter) {
    await markOrderFailed(supabase, order, `unknown_provider_adapter: ${providerId}`);
    return jsonResponse({ error: "unknown_payment_provider" }, 500);
  }

  try {
    const checkout = await adapter.createCheckout({
      orderId: order.id,
      amountCents: product.price_cents,
      currency: product.currency,
      description: `${product.name} – ${device.label}`,
    });

    await supabase
      .from("orders")
      .update({ status: "payment_pending", provider_ref: checkout.providerRef })
      .eq("id", order.id);

    // Löst sofort (statt per Dauer-Abfrage) den n8n-Timeout-Wächter für
    // GENAU diese Reservierung aus -- n8n wartet bis reservationExpiresAt
    // und räumt dann auf, falls die Zahlung bis dahin nicht bestätigt
    // wurde (siehe n8n/workflows/reservation-timeout-immediate.json). Der
    // separate Zeitplan-Workflow (reservation-timeout-guard.json) bleibt
    // zusätzlich als Sicherheitsnetz bestehen, falls dieser einzelne
    // Trigger-Aufruf selbst fehlschlägt.
    await triggerN8n("wama-pay/reservation-created", {
      order_id: order.id,
      reservation_expires_at: reservationExpiresAt,
    });

    return jsonResponse({
      order_id: order.id,
      status: "payment_pending",
      checkout_id: checkout.providerRef,
      redirect_url: checkout.redirectUrl ?? null,
    });
  } catch (err) {
    await markOrderFailed(supabase, order, `provider_checkout_creation_failed: ${(err as Error).message}`);
    return jsonResponse({ error: "provider_checkout_creation_failed" }, 502);
  }
});
