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
    // Idempotenz: kein doppelter Übergang. Zwei Ausgangsstatus sind gültig --
    // 'reserved' (Wallet-Zahlung: markOrderPaid direkt nach dem Anlegen der
    // Order aufgerufen, siehe create-checkout) und 'payment_pending'
    // (Provider-Zahlung: create-checkout setzt die Order nach dem Erstellen
    // der SumUp-Checkout-Session auf 'payment_pending', BEVOR eine
    // Bestätigung eintrifft -- das ist der Status, den confirmProviderOrder
    // hier praktisch immer vorfindet). Ein Filter nur auf 'reserved' hätte
    // bei jeder Kartenzahlung null Zeilen getroffen, ohne Fehler zu werfen --
    // die Order blieb dann trotz erfolgreicher Zahlung für immer auf
    // 'payment_pending' hängen, während releaseOrder() das Gerät trotzdem
    // freischaltete (kein Statuscheck dort).
    .in("status", ["reserved", "payment_pending"]);

  if (error) throw new Error(`Order konnte nicht auf 'paid' gesetzt werden: ${error.message}`);

  await writeAuditLog(supabase, { projectId: order.project_id, action: "order.paid", orderId: order.id });
  await triggerN8n("wama-pay/order-paid", { order_id: order.id });
}

/**
 * Ruft den pro Gerät hinterlegten Einschalt-Link auf (Admin-Webapp ->
 * devices.switch_webhook_url). Bewusst ein simpler GET-Aufruf ohne Body --
 * passt direkt zu einem Shelly-Cloud-Schaltlink (fertiger Link inkl. aller
 * nötigen Parameter, einfach aufzurufen wie im Browser). Fehlt die URL,
 * bleibt die Freigabe rein digital (nur Datenbank-Status), das ist bewusst
 * kein Fehlerzustand.
 */
async function triggerDeviceActivation(
  supabase: SupabaseClient,
  deviceId: string,
): Promise<{ attempted: boolean; success: boolean; detail?: string }> {
  const { data: device, error } = await supabase
    .from("devices")
    .select("switch_webhook_url, switch_webhook_secret")
    .eq("id", deviceId)
    .single();

  if (error || !device?.switch_webhook_url) {
    console.warn(`Gerät ${deviceId}: kein switch_webhook_url hinterlegt -- Freigabe bleibt rein digital.`);
    return { attempted: false, success: true };
  }

  try {
    // Optionales Secret als Header, für Empfänger, die das auswerten können
    // (ein reiner Shelly-Cloud-Schaltlink ignoriert unbekannte Header
    // einfach, das Secret schadet dort also nicht, wird aber auch nicht
    // gebraucht -- die Sicherheit steckt dort bereits im Link selbst).
    const headers: Record<string, string> = {};
    if (device.switch_webhook_secret) headers["X-Wama-Pay-Switch-Secret"] = device.switch_webhook_secret;

    const res = await fetch(device.switch_webhook_url, {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      const detail = `Einschalt-Webhook antwortete mit HTTP ${res.status}`;
      console.error(detail);
      return { attempted: true, success: false, detail };
    }
    return { attempted: true, success: true };
  } catch (err) {
    const detail = `Einschalt-Webhook fehlgeschlagen: ${(err as Error).message}`;
    console.error(detail);
    return { attempted: true, success: false, detail };
  }
}

/**
 * Gibt das Gerät physisch frei (ruft den Einschalt-Webhook auf, siehe
 * triggerDeviceActivation) und markiert die Order als 'released'. Setzt
 * devices.status NICHT auf 'free' -- das Gerät bleibt während des
 * laufenden Waschgangs 'busy'; erst der n8n-Workflow "order-released"
 * (Fertig-Signal oder 2h-Timeout) gibt es wieder frei.
 */
export async function releaseOrder(
  supabase: SupabaseClient,
  order: { id: string; project_id: string; device_id: string },
  // War zuvor hart auf "payment_webhook" gesetzt -- egal ob die Freigabe
  // wirklich vom echten Webhook, von der aktiven Nachfrage
  // (reconcile-provider-order), von PayPal-IPN oder von der Notfreigabe
  // ausgelöst wurde. Gerade zur Diagnose von Vorfällen wie "kam der Webhook
  // an oder nicht?" (siehe 24.08.2026) ist eine falsche Quellenangabe in den
  // eigenen Log-Daten kontraproduktiv.
  triggeredBy: string = "payment_webhook",
): Promise<void> {
  const { error: orderError } = await supabase
    .from("orders")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", "paid"); // Idempotenz: nur aus 'paid' heraus

  if (orderError) throw new Error(`Order konnte nicht auf 'released' gesetzt werden: ${orderError.message}`);

  const activation = await triggerDeviceActivation(supabase, order.device_id);

  const { error: releaseEventError } = await supabase.from("release_events").insert({
    order_id: order.id,
    device_id: order.device_id,
    triggered_by: triggeredBy,
    success: activation.success,
    error_detail: activation.detail ?? null,
  });
  if (releaseEventError) console.error("release_events-Insert fehlgeschlagen:", releaseEventError);

  await writeAuditLog(supabase, {
    projectId: order.project_id,
    action: "device.released",
    orderId: order.id,
    metadata: { activation_attempted: activation.attempted, activation_success: activation.success },
  });
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

export type ConfirmProviderOrderOutcome = "released" | "failed" | "already_processed" | "no_action";

/**
 * Gemeinsame Bestätigungslogik für "confirm_existing_order"-Provider
 * (aktuell SumUp): wird sowohl vom Webhook (payment-webhook/index.ts) als
 * auch vom aktiven Nachfrage-Sicherheitsnetz
 * (reconcile-provider-order/index.ts) genutzt, damit beide Wege exakt
 * denselben, idempotenten Ablauf durchlaufen.
 */
export async function confirmProviderOrder(
  supabase: SupabaseClient,
  order: { id: string; project_id: string; device_id: string; status: string },
  payload: { status: "paid" | "failed" | "pending" },
  // Woher dieser Aufruf kommt (echter Webhook vs. aktive Nachfrage) --
  // landet unverändert in release_events.triggered_by.
  triggeredBy: string = "payment_webhook",
): Promise<ConfirmProviderOrderOutcome> {
  // Idempotenz: bereits final verarbeitete Orders werden ignoriert, egal
  // wie oft/auf welchem Weg die Bestätigung erneut eintrifft.
  if (order.status === "released" || order.status === "failed" || order.status === "refunded") {
    return "already_processed";
  }

  if (payload.status === "paid") {
    if (order.status === "reserved" || order.status === "payment_pending") {
      await markOrderPaid(supabase, order);
    }
    await releaseOrder(supabase, { id: order.id, project_id: order.project_id, device_id: order.device_id }, triggeredBy);
    return "released";
  }

  if (payload.status === "failed") {
    if (order.status === "reserved" || order.status === "payment_pending") {
      await markOrderFailed(supabase, order, "provider_reported_failed");
      return "failed";
    }
    return "already_processed";
  }

  // status === 'pending': keine Aktion, auf nächste Bestätigung warten.
  return "no_action";
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
    deviceCode: string; // devices.device_code, z.B. "AA111" -- kommt aus dem PayPal-'custom'-Feld
    providerId: string;
    providerRef: string; // eindeutige Provider-Transaktions-Id
    amountCents: number;
    currency: string;
  },
): Promise<CreateOrderForDeviceResult> {
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, type, location_id, project_id, status")
    .eq("device_code", params.deviceCode)
    .single();

  if (deviceError || !device) {
    throw new Error(`Gerät mit Code '${params.deviceCode}' nicht gefunden: ${deviceError?.message}`);
  }

  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, price_cents, currency, location_id")
    .eq("project_id", device.project_id)
    .eq("device_type", device.type)
    .eq("is_active", true)
    .or(`location_id.eq.${device.location_id},location_id.is.null`);

  if (productsError || !products || products.length === 0) {
    throw new Error(`Kein aktives Produkt für Gerät '${params.deviceCode}' konfiguriert.`);
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

  await releaseOrder(supabase, { id: order.id, project_id: order.project_id, device_id: order.device_id }, "paypal_ipn");
  return "released";
}

export type OverrideOrderResult = "released" | "device_busy";

/**
 * Notfreigabe (Task 11): legt eine Order mit payment_method='override' an
 * (keine Bezahlung, aber vollständig protokolliert -- amount_cents zeigt
 * weiterhin den regulären Preis zu Dokumentationszwecken) und gibt das
 * Gerät frei. Wird von der Edge Function device-override NACH erfolgreicher
 * Prüfung von Geräte-Token UND PIN aufgerufen (siehe Migration 0018).
 */
export async function createAndReleaseOverrideOrder(
  supabase: SupabaseClient,
  params: { deviceId: string },
): Promise<OverrideOrderResult> {
  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, type, location_id, project_id")
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

  const reservationExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      project_id: device.project_id,
      device_id: device.id,
      product_id: product.id,
      customer_id: null,
      payment_method: "override",
      provider_id: null,
      amount_cents: product.price_cents,
      currency: product.currency,
      status: "paid",
      reservation_expires_at: reservationExpiresAt,
      paid_at: new Date().toISOString(),
    })
    .select("id, project_id, device_id")
    .single();

  if (orderError) {
    throw new Error(`Order konnte nicht angelegt werden: ${orderError.message}`);
  }

  await writeAuditLog(supabase, {
    projectId: order.project_id,
    action: "order.paid",
    orderId: order.id,
    metadata: { payment_method: "override" },
  });
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
      metadata: { device_id: device.id, payment_method: "override" },
    });
    return "device_busy";
  }

  await releaseOrder(supabase, { id: order.id, project_id: order.project_id, device_id: order.device_id }, "admin_override");
  return "released";
}
