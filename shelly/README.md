# Shelly-Integration: "Waschgang fertig"-Signal

`wama-pay-finish-signal.js` läuft direkt auf einem Shelly Gen2/Gen3-Gerät mit
Leistungsmessung (z.B. Shelly Plus 1PM, Shelly Plus Plug S) und ersetzt die
reine Zeitschätzung durch ein echtes Signal, sobald die Maschine fertig ist.
Für Dauerbetrieb ohne Zutun gehärtet (Zustandsautomat statt reiner
Zeitschwelle, Wiederholungsversuche, Neustart-sicher) — Details unten.

## Funktionsweise

Zustandsautomat statt reiner Zeitmessung: `idle` → `running` → `debouncing`
→ (Signal gesendet) → `idle`.

- Fragt alle `POLL_INTERVAL_MS` aktiv die Wirkleistung (`apower`) am
  konfigurierten Kanal ab (kein Verlass auf Push-Events allein).
- Ein Waschgang gilt erst als **gestartet**, wenn die Leistung über
  `POWER_THRESHOLD_W` liegt.
- Als **beendet** gilt er erst, wenn er mindestens `MIN_RUN_SECONDS` aktiv
  lief **und** danach ununterbrochen `DEBOUNCE_SECONDS` lang unter der
  Schwelle bleibt. Jede Überschreitung der Schwelle dazwischen (z.B.
  Schleudergang) setzt den Debounce zurück, ohne den "läuft"-Zustand zu
  verlieren.
- Ein Gerät, das nie gestartet wurde (dauerhaft im Leerlauf), sendet **nie**
  ein Signal — das war ein Fehler in der ersten Fassung dieses Skripts.
- Beim Erreichen der Debounce-Zeit ruft das Skript den n8n-Webhook
  `POST /webhook/wama-pay/device-finished`
  (siehe `n8n/workflows/device-finished-signal.json`) mit
  `{ "device_id": "<Wama-Pay devices.id>" }` auf.

## Zuverlässigkeit / Sicherheitsfeatures

- **Wiederholungsversuche mit Backoff:** Schlägt der Webhook-Aufruf fehl
  (WLAN-Aussetzer, n8n kurz nicht erreichbar), wird bis zu
  `MAX_WEBHOOK_RETRIES`-mal erneut versucht (`RETRY_DELAYS_S`). Erst wenn
  alle Versuche fehlschlagen, greift der n8n-seitige 2h-Timeout als letztes
  Sicherheitsnetz (siehe `n8n/README.md`).
- **Neustart-sicher:** Der Zustand (`running`/Startzeit) wird im
  Shelly-internen Key-Value-Store gespeichert. Ein Stromausfall oder
  Firmware-Update mitten in einem Waschgang lässt das Skript den Faden nicht
  verlieren.
- **Startup-Grace-Period:** Ignoriert Messwerte kurz nach Skriptstart, bis
  sich die Werte stabilisiert haben.
- **Konfigurationsprüfung:** Warnt im Skript-Log deutlich, falls
  `WEBHOOK_URL`/`DEVICE_ID` noch Platzhalter sind, statt still ins Leere zu
  laufen.

**Wichtig für unbeaufsichtigten Dauerbetrieb:** Im Shelly-Script-Editor
unten rechts **"Run on startup" / "Enable at boot"** aktivieren — sonst
startet das Skript nach einem Neustart des Shelly nicht automatisch neu.

## Installation

1. Shelly-Weboberfläche → **Scripts** → **Add Script**.
2. Inhalt von `wama-pay-finish-signal.js` einfügen.
3. Im `CONFIG`-Block am Anfang des Skripts anpassen:
   - `LOCATION_NAME`, `DEVICE_LABEL` — nur für die Log-Ausgabe, keine Funktion
   - `SWITCH_ID` — nur bei Mehrkanal-Geräten relevant
   - `POWER_THRESHOLD_W`, `DEBOUNCE_SECONDS`, `MIN_RUN_SECONDS` — je nach
     Maschine ggf. per Testlauf feinjustieren
   - `WEBHOOK_URL` — die produktive n8n-Webhook-URL
   - `DEVICE_ID` — die `devices.id` (UUID) dieser Maschine aus Supabase
   - `SIGNAL_SECRET` — muss mit dem Wert im n8n-Workflow
     `device-finished-signal.json` übereinstimmen (siehe `n8n/README.md`)
4. Speichern, **"Run on startup" aktivieren**, starten. Die Log-Ausgabe
   (`print(...)`) ist im Skript-Log der Shelly-Oberfläche sichtbar.

## Ein Shelly pro Gerät

Jede physische Maschine braucht ein eigenes Shelly mit eigener `DEVICE_ID` —
es gibt keine zentrale Zuordnung, die Zuordnung Shelly ↔ `devices.id` erfolgt
ausschließlich über die feste Konfiguration im Skript selbst.
