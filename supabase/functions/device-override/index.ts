// Wama-Pay – Edge Function "device-override"
//
// Notfreigabe (Task 11): Hausmeister/Techniker schaltet ein Gerät ohne
// Bezahlung frei. Zwei Faktoren nötig, beide werden hier geprüft:
//   1. device_id + override_token -- kommen aus dem gerätespezifischen,
//      geheimen QR-Code/Link (webapp-checkout/override.html), der NICHT
//      für Kunden sichtbar am Gerät angebracht ist.
//   2. pin -- vom Betreiber im Admin-Dashboard gesetzter, projektweiter
//      PIN (siehe Migration 0018, set_override_pin()).
//
// Absichtlich generische Fehlermeldung bei jedem Fehlschlag (falscher
// Token, falscher PIN, gesperrt) -- verrät niemandem, welcher der beiden
// Faktoren falsch war (kein Enumeration-Vorteil für Angreifer).
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";
import { createSupabaseAdminClient } from "../_shared/supabaseAdmin.ts";
import { createAndReleaseOverrideOrder } from "../_shared/orderLifecycle.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body: { device_id?: string; override_token?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const { device_id, override_token, pin } = body;
  if (!device_id || !override_token || !pin) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const supabase = createSupabaseAdminClient();

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, project_id, override_token")
    .eq("id", device_id)
    .maybeSingle();

  if (deviceError || !device || !device.override_token || device.override_token !== override_token) {
    return jsonResponse({ error: "invalid" }, 401);
  }

  const { data: pinOk, error: pinError } = await supabase.rpc("verify_override_pin", {
    p_project_id: device.project_id,
    p_pin: pin,
  });

  if (pinError || !pinOk) {
    return jsonResponse({ error: "invalid" }, 401);
  }

  try {
    const result = await createAndReleaseOverrideOrder(supabase, { deviceId: device.id });
    return jsonResponse({ ok: true, result });
  } catch (err) {
    console.error("device-override: Verarbeitung fehlgeschlagen:", err);
    return jsonResponse({ error: "processing_failed" }, 500);
  }
});
