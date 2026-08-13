// ============================================================================
// Wama-Pay – Shelly-Skript "Waschgang fertig"-Signal
//
// Läuft direkt auf einem Shelly Gen2/Gen3-Gerät (z.B. Shelly Plus 1PM /
// Plus Plug S) mit Leistungsmessung. Überwacht die Wirkleistung (apower) am
// überwachten Kanal. Sobald die Leistung länger als DEBOUNCE_SECONDS
// ununterbrochen unter POWER_THRESHOLD_W bleibt, gilt der Waschgang als
// beendet und es wird ein Webhook an n8n gesendet. Jede Überschreitung von
// POWER_THRESHOLD_W setzt den Debounce-Timer zurück (Schleuderphasen o.Ä.
// lösen also kein verfrühtes "fertig" aus).
//
// Installation: Shelly-Weboberfläche -> Scripts -> Add Script -> Inhalt
// hier einfügen -> Konfiguration unten anpassen -> Save -> Enable -> Start.
// ============================================================================

// ---- Konfiguration: hier alle Parameter anpassen --------------------------
var CONFIG = {
  // Shelly-Kanal (Switch-ID), der die Maschine misst. Bei Einkanal-Geräten
  // (z.B. Plus 1PM) ist das 0.
  SWITCH_ID: 0,

  // Schwelle in Watt. Leistung darunter gilt als "Maschine läuft nicht mehr
  // aktiv" (z.B. nur noch Standby-/Anzeige-Verbrauch).
  POWER_THRESHOLD_W: 100,

  // Wie viele Sekunden die Leistung ununterbrochen unter der Schwelle
  // bleiben muss, bevor der Waschgang als beendet gilt.
  DEBOUNCE_SECONDS: 30,

  // n8n-Webhook-URL des Workflows "device-finished-signal"
  // (siehe n8n/workflows/device-finished-signal.json).
  WEBHOOK_URL: "https://REPLACE-WITH-N8N-HOST/webhook/wama-pay/device-finished",

  // Wama-Pay devices.id (UUID) dieser physischen Maschine, siehe
  // Supabase-Tabelle "devices". Ein Shelly = ein Gerät = eine feste ID.
  DEVICE_ID: "REPLACE-WITH-WAMA-PAY-DEVICE-ID",

  // Geteiltes Geheimnis, das im Header X-Wama-Pay-Signal-Key mitgeschickt
  // wird. Muss exakt mit dem Wert übereinstimmen, der im n8n-Workflow
  // "device-finished-signal" im Node "Signal-Key gültig?" hinterlegt ist
  // (dort fest eingetragen, siehe n8n/README.md). Für jedes Gerät kann
  // derselbe Wert verwendet werden.
  SIGNAL_SECRET: "9847cbcf7306a429707b76470879c6f9e771e83be69430535f30da6ff7702353",

  // Timeout für den HTTP-Aufruf in Sekunden.
  HTTP_TIMEOUT_S: 10
};
// ----------------------------------------------------------------------------

var debounceTimerHandle = null;
var isBelowThreshold = false;

function sendFinishedSignal() {
  Shelly.call(
    "HTTP.POST",
    {
      url: CONFIG.WEBHOOK_URL,
      body: JSON.stringify({ device_id: CONFIG.DEVICE_ID }),
      content_type: "application/json",
      headers: { "X-Wama-Pay-Signal-Key": CONFIG.SIGNAL_SECRET },
      timeout: CONFIG.HTTP_TIMEOUT_S
    },
    function (result, error_code, error_message) {
      if (error_code !== 0) {
        print("Wama-Pay: Webhook-Aufruf fehlgeschlagen (" + error_code + "): " + error_message);
      } else {
        print("Wama-Pay: 'Waschgang fertig'-Signal fuer Geraet " + CONFIG.DEVICE_ID + " gesendet.");
      }
    }
  );
}

function onDebounceElapsed() {
  debounceTimerHandle = null;
  // Nur auslösen, wenn die Leistung seit dem Start des Timers tatsächlich
  // durchgehend unter der Schwelle geblieben ist (wird über onStatusUpdate
  // sichergestellt, das den Timer bei Überschreitung sofort abbricht).
  isBelowThreshold = false;
  sendFinishedSignal();
}

function onStatusUpdate(status) {
  if (status.name !== "switch" || status.id !== CONFIG.SWITCH_ID) return;
  if (typeof status.delta.apower === "undefined") return;

  var power = status.delta.apower;

  if (power >= CONFIG.POWER_THRESHOLD_W) {
    // Schwelle wieder überschritten -> Debounce-Timer zurücksetzen.
    if (debounceTimerHandle !== null) {
      Timer.clear(debounceTimerHandle);
      debounceTimerHandle = null;
    }
    isBelowThreshold = false;
    return;
  }

  // Leistung unter der Schwelle: Debounce-Timer nur starten, wenn er nicht
  // bereits läuft (verhindert mehrfaches Neustarten bei jedem einzelnen
  // Status-Update während der Debounce-Phase).
  if (!isBelowThreshold) {
    isBelowThreshold = true;
    debounceTimerHandle = Timer.set(CONFIG.DEBOUNCE_SECONDS * 1000, false, onDebounceElapsed);
  }
}

Shelly.addStatusHandler(onStatusUpdate);

print(
  "Wama-Pay: Ueberwachung gestartet - Kanal " + CONFIG.SWITCH_ID +
  ", Schwelle " + CONFIG.POWER_THRESHOLD_W + " W" +
  ", Debounce " + CONFIG.DEBOUNCE_SECONDS + " s."
);
