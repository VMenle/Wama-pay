// ============================================================================
// Wama-Pay – Shelly-Skript "Waschgang fertig"-Signal (gehärtete Fassung)
//
// Läuft direkt auf einem Shelly Gen2/Gen3-Gerät (z.B. Shelly Plus 1PM /
// Plus Plug S) mit Leistungsmessung. Erkennt per Zustandsautomat, wann ein
// echter Waschgang beendet ist, und meldet das per Webhook an n8n.
//
// Zustände: idle -> running -> debouncing -> idle (dann Webhook gesendet)
//   idle:        Leistung unter der Schwelle, kein aktiver Waschgang bekannt.
//   running:     Leistung ist/war über der Schwelle, Zyklus läuft.
//   debouncing:  Leistung gerade unter die Schwelle gefallen, Countdown läuft,
//                ob das wirklich das Ende ist oder nur eine kurze Pause
//                zwischen Programmschritten.
//
// Entscheidend: Nur ein Gerät, das nachweislich mindestens MIN_RUN_SECONDS
// oberhalb der Schwelle lief, kann ein "fertig"-Signal auslösen. Ein
// dauerhaft ruhendes/nie gestartetes Gerät sendet NIE ein Signal (siehe
// Kommentar am Anfang der Datei-Historie -- das war ein echter Fehler in
// der ersten Fassung).
//
// Installation: Shelly-Weboberfläche -> Scripts -> Add Script -> Inhalt
// hier einfügen -> Konfiguration unten anpassen -> Save -> Enable -> Start.
//
// WICHTIG für Dauerbetrieb ohne Zutun: Im Script-Editor unten rechts
// "Run on startup" / "Enable at boot" aktivieren -- sonst startet das
// Skript nach einem Stromausfall/Neustart des Shelly NICHT von selbst neu.
// ============================================================================

// ---- Konfiguration: hier alle Parameter anpassen --------------------------
var CONFIG = {
  // Nur zur Beschriftung der Log-Ausgaben, keine Funktion. Frei wählbar.
  LOCATION_NAME: "Heubach",
  DEVICE_LABEL: "23001",

  // Shelly-Kanal (Switch-ID), der die Maschine misst. Bei Einkanal-Geräten
  // (z.B. Plus 1PM) ist das 0.
  SWITCH_ID: 0,

  // Schwelle in Watt. Leistung darunter gilt als "Maschine läuft nicht mehr
  // aktiv" (z.B. nur noch Standby-/Anzeige-Verbrauch).
  POWER_THRESHOLD_W: 100,

  // Wie viele Sekunden die Leistung ununterbrochen unter der Schwelle
  // bleiben muss, bevor der Waschgang als beendet gilt.
  DEBOUNCE_SECONDS: 30,

  // Mindestlaufzeit oberhalb der Schwelle, bevor überhaupt ein "fertig"
  // möglich ist. Verhindert, dass ein kurzes Antippen des Programmwahl-
  // schalters oder ein kurzer Test fälschlich als abgeschlossener
  // Waschgang gemeldet wird.
  MIN_RUN_SECONDS: 60,

  // Ignoriert Messwerte für diese Zeit direkt nach Skriptstart/Neustart,
  // bis sich Messwerte/Zustand stabilisiert haben.
  STARTUP_GRACE_SECONDS: 15,

  // Wie oft der aktuelle Leistungswert abgefragt wird.
  POLL_INTERVAL_MS: 5000,

  // n8n-Webhook-URL des Workflows "device-finished-signal"
  // (siehe n8n/workflows/device-finished-signal.json).
  WEBHOOK_URL: "https://REPLACE-WITH-N8N-HOST/webhook/wama-pay/device-finished",

  // Wama-Pay devices.id (UUID) dieser physischen Maschine, siehe
  // Supabase-Tabelle "devices". Ein Shelly = ein Gerät = eine feste ID.
  DEVICE_ID: "REPLACE-WITH-WAMA-PAY-DEVICE-ID",

  // Geteiltes Geheimnis, das im Header X-Wama-Pay-Signal-Key mitgeschickt
  // wird. Muss exakt mit dem Wert übereinstimmen, der im n8n-Workflow
  // "device-finished-signal" im Node "Signal-Key gültig?" hinterlegt ist.
  SIGNAL_SECRET: "9847cbcf7306a429707b76470879c6f9e771e83be69430535f30da6ff7702353",

  // Timeout für den einzelnen HTTP-Aufruf in Sekunden.
  HTTP_TIMEOUT_S: 10,

  // Wie oft ein fehlgeschlagener Webhook-Aufruf wiederholt wird, bevor
  // aufgegeben wird (der n8n-seitige 2h-Timeout greift ohnehin als
  // allerletztes Sicherheitsnetz, siehe n8n/README.md).
  MAX_WEBHOOK_RETRIES: 5,
  RETRY_DELAYS_S: [5, 15, 60, 180, 300],

  // Schlüssel im Shelly-internen Key-Value-Store, unter dem der Zustand
  // gespeichert wird, damit ein Neustart des Shelly (Stromausfall,
  // Firmware-Update) mitten in einem Waschgang nicht den Überblick verliert.
  KVS_KEY: "wama_pay_cycle_state"
};
// ----------------------------------------------------------------------------

var state = "idle"; // "idle" | "running" | "debouncing"
var runStartedAt = null;
var debounceStartedAt = null;
var scriptStartedAt = Date.now();

function logPrefixed(msg) {
  print("Wama-Pay [" + CONFIG.LOCATION_NAME + "/" + CONFIG.DEVICE_LABEL + "]: " + msg);
}

function validateConfig() {
  var problems = [];
  if (CONFIG.WEBHOOK_URL.indexOf("REPLACE-WITH") >= 0) problems.push("WEBHOOK_URL");
  if (CONFIG.DEVICE_ID.indexOf("REPLACE-WITH") >= 0) problems.push("DEVICE_ID");
  if (problems.length > 0) {
    logPrefixed("WARNUNG -- CONFIG unvollständig (" + problems.join(", ") + "). Skript läuft weiter, kann aber KEIN gültiges Signal senden, bis das behoben ist.");
  }
}

function persistState() {
  Shelly.call(
    "KVS.Set",
    { key: CONFIG.KVS_KEY, value: JSON.stringify({ state: state, runStartedAt: runStartedAt }) },
    function () {}
  );
}

function restoreState() {
  Shelly.call("KVS.Get", { key: CONFIG.KVS_KEY }, function (result, error_code) {
    if (error_code !== 0 || !result || !result.value) return;
    var saved;
    try {
      saved = JSON.parse(result.value);
    } catch (e) {
      return;
    }
    if (saved && (saved.state === "running" || saved.state === "debouncing")) {
      // Nach einem Neustart konservativ auf "running" zurückfallen -- der
      // nächste Poll bewertet Debounce/Fertig-Erkennung ganz normal neu,
      // sodass kein Zustand verloren geht, aber auch kein verfrühtes
      // "fertig" allein durch den Neustart ausgelöst wird.
      state = "running";
      runStartedAt = saved.runStartedAt || Date.now();
      logPrefixed("Zustand nach Neustart wiederhergestellt (Waschgang lief bereits).");
    }
  });
}

function clearPersistedState() {
  Shelly.call("KVS.Delete", { key: CONFIG.KVS_KEY }, function () {});
}

function sendFinishedSignalWithRetry(attempt) {
  attempt = attempt || 0;
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
      if (error_code === 0) {
        logPrefixed("'Waschgang fertig'-Signal erfolgreich gesendet (Versuch " + (attempt + 1) + ").");
        return;
      }
      logPrefixed("Webhook-Aufruf fehlgeschlagen (Versuch " + (attempt + 1) + "): " + error_message);
      if (attempt < CONFIG.MAX_WEBHOOK_RETRIES - 1) {
        var delayIdx = attempt < CONFIG.RETRY_DELAYS_S.length ? attempt : CONFIG.RETRY_DELAYS_S.length - 1;
        var delaySeconds = CONFIG.RETRY_DELAYS_S[delayIdx];
        Timer.set(delaySeconds * 1000, false, function () {
          sendFinishedSignalWithRetry(attempt + 1);
        });
      } else {
        logPrefixed(
          "Webhook endgültig fehlgeschlagen nach " + CONFIG.MAX_WEBHOOK_RETRIES +
          " Versuchen. Der n8n-seitige 2h-Timeout gibt das Gerät als Sicherheitsnetz trotzdem frei."
        );
      }
    }
  );
}

function evaluatePower(power) {
  if (Date.now() - scriptStartedAt < CONFIG.STARTUP_GRACE_SECONDS * 1000) return;

  if (power >= CONFIG.POWER_THRESHOLD_W) {
    if (state === "idle") {
      state = "running";
      runStartedAt = Date.now();
      persistState();
      logPrefixed("Waschgang erkannt, Leistung " + power + " W.");
    } else if (state === "debouncing") {
      // Kurze Pause zwischen Programmschritten, kein echtes Ende.
      state = "running";
      debounceStartedAt = null;
      persistState();
    }
    return;
  }

  // power < Schwelle
  if (state === "running") {
    var ranLongEnough = Date.now() - runStartedAt >= CONFIG.MIN_RUN_SECONDS * 1000;
    if (ranLongEnough) {
      state = "debouncing";
      debounceStartedAt = Date.now();
      persistState();
    }
    // sonst: zu kurz gelaufen (z.B. kurzer Test) -- bleibt "running",
    // wird beim nächsten Poll neu bewertet.
    return;
  }

  if (state === "debouncing") {
    if (Date.now() - debounceStartedAt >= CONFIG.DEBOUNCE_SECONDS * 1000) {
      state = "idle";
      runStartedAt = null;
      debounceStartedAt = null;
      clearPersistedState();
      logPrefixed("Waschgang als beendet erkannt, sende Signal…");
      sendFinishedSignalWithRetry(0);
    }
    return;
  }
  // state === "idle" und Leistung unter Schwelle: nichts zu tun.
}

function pollPower() {
  Shelly.call("Switch.GetStatus", { id: CONFIG.SWITCH_ID }, function (result, error_code, error_message) {
    if (error_code !== 0 || !result || typeof result.apower === "undefined") {
      logPrefixed("Switch.GetStatus fehlgeschlagen: " + error_message);
      return;
    }
    evaluatePower(result.apower);
  });
}

validateConfig();
restoreState();
Timer.set(CONFIG.POLL_INTERVAL_MS, true, pollPower);

logPrefixed(
  "Überwachung gestartet (Schwelle " + CONFIG.POWER_THRESHOLD_W + " W, Debounce " +
  CONFIG.DEBOUNCE_SECONDS + " s, Mindestlaufzeit " + CONFIG.MIN_RUN_SECONDS + " s)."
);
