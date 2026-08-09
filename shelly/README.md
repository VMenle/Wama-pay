# Shelly-Integration: "Waschgang fertig"-Signal

`wama-pay-finish-signal.js` läuft direkt auf einem Shelly Gen2/Gen3-Gerät mit
Leistungsmessung (z.B. Shelly Plus 1PM, Shelly Plus Plug S) und ersetzt die
reine Zeitschätzung durch ein echtes Signal, sobald die Maschine fertig ist.

## Funktionsweise

- Überwacht laufend die Wirkleistung (`apower`) am konfigurierten Kanal.
- Sinkt die Leistung unter `POWER_THRESHOLD_W` und bleibt **ununterbrochen**
  `DEBOUNCE_SECONDS` lang darunter, gilt der Waschgang als beendet.
- Jede Überschreitung von `POWER_THRESHOLD_W` (z.B. Schleudergang) setzt den
  Timer zurück — es wird nicht verfrüht ausgelöst.
- Beim Erreichen der Debounce-Zeit ruft das Skript den n8n-Webhook
  `POST /webhook/wama-pay/device-finished`
  (siehe `n8n/workflows/device-finished-signal.json`) mit
  `{ "device_id": "<Wama-Pay devices.id>" }` auf.

## Installation

1. Shelly-Weboberfläche → **Scripts** → **Add Script**.
2. Inhalt von `wama-pay-finish-signal.js` einfügen.
3. Im `CONFIG`-Block am Anfang des Skripts anpassen:
   - `SWITCH_ID` — nur bei Mehrkanal-Geräten relevant
   - `POWER_THRESHOLD_W`, `DEBOUNCE_SECONDS` — je nach Maschine ggf. per
     Testlauf feinjustieren (Waschmaschinen haben oft kurze Leistungs-Nullen
     zwischen Programmschritten, die durch den Debounce abgefangen werden)
   - `WEBHOOK_URL` — die produktive n8n-Webhook-URL
   - `DEVICE_ID` — die `devices.id` (UUID) dieser Maschine aus Supabase
   - `SIGNAL_SECRET` — muss mit `WAMA_PAY_DEVICE_SIGNAL_SECRET` in n8n
     übereinstimmen (siehe `n8n/README.md`)
4. Speichern, aktivieren, starten. Die Log-Ausgabe (`print(...)`) ist im
   Skript-Log der Shelly-Oberfläche sichtbar.

## Ein Shelly pro Gerät

Jede physische Maschine braucht ein eigenes Shelly mit eigener `DEVICE_ID` —
es gibt keine zentrale Zuordnung, die Zuordnung Shelly ↔ `devices.id` erfolgt
ausschließlich über die feste Konfiguration im Skript selbst.
