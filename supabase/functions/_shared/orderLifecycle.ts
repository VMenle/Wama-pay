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
