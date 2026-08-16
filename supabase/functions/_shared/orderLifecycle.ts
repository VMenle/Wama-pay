// Wama-Pay – gemeinsame Order-Zustandsübergänge, genutzt von create-checkout
// (Wallet-Zahlung: synchron, kein Webhook nötig) und payment-webhook
// (Provider-Zahlung: asynchron nach SumUp-Bestätigung). Hält Freigabelogik,
// Audit-Log und n8n-Trigger an einer Stelle, damit beide Zahlwege exakt
// denselben Ablauf durchlaufen (siehe docs/payment-provider-adapter.md,
// Abschnitt "Was bewusst NICHT providerspezifisch ist").
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

function n8nBaseUrl(): string | null {
  return Deno.env.get("WAMA_PAY_N8N_BASE_URL");
}

async function triggerN8n(path: string, body: Record<string, unknown>) {
  const base = n8nBaseUrl();
  if (!base) {
    console.warn(`WAMA_PAY_N8N_BASE_URL nicht gesetzt -- n8n-Trigger '${path}' wird übersprungen.`);
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`n8n-Trigger '${path}' fehlgeschlagen: HTTP ${res.status}`);
    }
  } catch (err) {
    // n8n-Ausfall darf den Zahlungs-/Freigabe-Ablauf selbst nicht blockieren
    // (Beleg-Mail/Benachrichtigung sind Folgeaufgaben, keine Voraussetzung
    // für die Geräte-Freigabe). Fehler wird geloggt, nicht geworfen.
    console.error(`n8n-Trigger '${path}' fehlgeschlagen:`, err);
  }
}

async function writeAuditLog(
  supabase: SupabaseClient,
  params: { projectId: string | null; action: string; orderId: string; metadata?: Record<string, unknown> },
) {
  const { error } = await supabase.from("audit_log").insert({
    project_id: params.projectId,
    actor_type: "service_role",
    action: params.action,
    entity_table: "orders",
    entity_id: params.orderId,
    metadata: params.metadata ?? {},
  });
  if (error) console.error("audit_log-Insert fehlgeschlagen:", error);
}

/** Markiert eine Order als bezahlt und löst die Beleg-Mail (n8n) aus. */
export async function markOrderPaid(
  supabase: SupabaseClient,
  order: { id: string; project_id: string },
): Promise<void> {
  const { error } = await supabase
    .from("orders")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", "reserved"); // Idempotenz: nur aus 'reserved' heraus, kein doppelter Übergang

  if (error) throw new Error(`Order konnte nicht auf 'paid' gesetzt werden: ${error.message}`);

  await writeAuditLog(supabase, { projectId: order.project_id, action: "order.paid", orderId: order.id });
  await triggerN8n("wama-pay/order-paid", { order_id: order.id });
}

/**
 * Gibt das Gerät physisch frei (Freigabe-Relais/Signal) und markiert die
 * Order als 'released'. Setzt devices.status NICHT auf 'free' -- das Gerät
 * bleibt während des laufenden Waschgangs 'busy'; erst der n8n-Workflow
 * "order-released" (Fertig-Signal oder 2h-Timeout) gibt es wieder frei.
 */
export async function releaseOrder(
  supabase: SupabaseClient,
  order: { id: string; project_id: string; device_id: string },
): Promise<void> {
  const { error: orderError } = await supabase
    .from("orders")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", "paid"); // Idempotenz: nur aus 'paid' heraus

  if (orderError) throw new Error(`Order konnte nicht auf 'released' gesetzt werden: ${orderError.message}`);

  const { error: releaseEventError } = await supabase.from("release_events").insert({
    order_id: order.id,
    device_id: order.device_id,
    triggered_by: "payment_webhook",
    success: true,
  });
  if (releaseEventError) console.error("release_events-Insert fehlgeschlagen:", releaseEventError);

  await writeAuditLog(supabase, { projectId: order.project_id, action: "device.released", orderId: order.id });
  await triggerN8n("wama-pay/order-released", { order_id: order.id, device_id: order.device_id });
}

/**
 * Bricht eine noch nicht bezahlte Order ab (z.B. Zahlung beim Provider
 * fehlgeschlagen) und gibt das reservierte Gerät sofort wieder frei --
 * anders als expire_stale_reservations() (Migration 0011), die nur beim
 * Zeitfenster-Timeout greift, ist das hier eine explizite Fehlermeldung
 * des Providers.
 */
export async function markOrderFailed(
  supabase: SupabaseClient,
  order: { id: string; project_id: string; device_id: string },
  reason: string,
): Promise<void> {
  const { error: orderError } = await supabase
    .from("orders")
    .update({ status: "failed" })
    .eq("id", order.id)
    .in("status", ["reserved", "payment_pending"]);

  if (orderError) throw new Error(`Order konnte nicht auf 'failed' gesetzt werden: ${orderError.message}`);

  const { error: deviceError } = await supabase
    .from("devices")
    .update({ status: "free", current_order_id: null })
    .eq("id", order.device_id)
    .eq("current_order_id", order.id);

  if (deviceError) console.error("Gerät konnte nach fehlgeschlagener Zahlung nicht freigegeben werden:", deviceError);

  await writeAuditLog(supabase, {
    projectId: order.project_id,
    action: "order.failed",
    orderId: order.id,
    metadata: { reason },
  });
}

export type CreateOrderForDeviceResult = "released" | "paid_device_busy" | "duplicate";

/**
 * Für Zahlwege ohne vorherige Reservierung (statisches Zahlungsmittel direkt
 * am Gerät, z.B. PayPal-Payment-Button/QR-Code): legt die Order ERST BEIM
 * ZAHLUNGSEINGANG rückwirkend an (Status direkt 'paid', kein 'reserved'/
 * 'payment_pending' davor) und gibt das Gerät frei -- sofern es gerade
 * verfügbar ist.
 *
 * Idempotenz läuft über orders_provider_ref_unique_idx (Migration 0004):
 * providerRef muss die eindeutige Provider-Transaktions-Id sein. Eine
 * doppelt zugestellte Benachrichtigung (z.B. PayPal-IPN-Retry) führt zu
 * einem Unique-Constraint-Fehler (Postgres-Code 23505), der hier als
 * "duplicate" abgefangen wird statt als Fehler durchzuschlagen.
 *
 * Ist das Gerät gerade belegt (jemand anders nutzt es bereits), wird die
 * Zahlung trotzdem verbucht (das Geld ist geflossen, das darf nicht
 * verloren gehen), aber NICHT freigegeben -- das braucht manuelle
 * Nachbearbeitung (Rückerstattung oder Rücksprache mit dem Kunden). Siehe
 * audit_log-Eintrag 'order.paid_but_device_busy'.
 */
export async function createAndReleaseOrderForDevice(
  supabase: SupabaseClient,
  params: {
    deviceId: string;
    providerId: string;
    providerRef: string; // eindeutige Provider-Transaktions-Id
    amountCents: number;
    currency: string;
  },
): Promise<CreateOrderForDeviceResult> {
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, type, location_id, project_id, status")
    .eq("id", params.deviceId)
    .single();

  if (deviceError || !device) {
    throw new Error(`Gerät '${params.deviceId}' nicht gefunden: ${deviceError?.message}`);
  }

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, price_cents, currency, location_id")
    .eq("project_id", device.project_id)
    .eq("device_type", device.type)
    .eq("is_active", true)
    .or(`location_id.eq.${device.location_id},location_id.is.null`);

  if (productsError || !products || products.length === 0) {
    throw new Error(`Kein aktives Produkt für Gerät '${params.deviceId}' konfiguriert.`);
  }
  const product = products.find((p) => p.location_id === device.location_id) ?? products[0];

  // Formalität: reservation_expires_at ist NOT NULL, hat hier aber keine
  // praktische Bedeutung -- die Order geht direkt auf 'paid', durchläuft
  // nie den Reservierungs-Zeitfenster-Mechanismus.
  const reservationExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      project_id: device.project_id,
      device_id: device.id,
      product_id: product.id,
      customer_id: null,
      payment_method: "provider",
      provider_id: params.providerId,
      provider_ref: params.providerRef,
      amount_cents: params.amountCents,
      currency: params.currency,
      status: "paid",
      reservation_expires_at: reservationExpiresAt,
      paid_at: new Date().toISOString(),
    })
    .select("id, project_id, device_id")
    .single();

  if (orderError) {
    if (orderError.code === "23505") return "duplicate"; // orders_provider_ref_unique_idx
    throw new Error(`Order konnte nicht angelegt werden: ${orderError.message}`);
  }

  await writeAuditLog(supabase, { projectId: order.project_id, action: "order.paid", orderId: order.id });
  await triggerN8n("wama-pay/order-paid", { order_id: order.id });

  const { data: claimedDevice, error: claimError } = await supabase
    .from("devices")
    .update({ status: "busy", current_order_id: order.id })
    .eq("id", device.id)
    .eq("status", "free")
    .select("id")
    .maybeSingle();

  if (claimError || !claimedDevice) {
    await writeAuditLog(supabase, {
      projectId: order.project_id,
      action: "order.paid_but_device_busy",
      orderId: order.id,
      metadata: { device_id: device.id },
    });
    return "paid_device_busy";
  }

  await releaseOrder(supabase, { id: order.id, project_id: order.project_id, device_id: order.device_id });
  return "released";
}
