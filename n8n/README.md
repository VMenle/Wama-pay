# n8n-Workflows (Teil c)

Diese Workflows übernehmen die Folgeaufgaben, die bewusst **nicht** in der
Edge Function `payment-webhook` liegen (siehe
`docs/payment-provider-adapter.md`, Abschnitt "Was bewusst NICHT
providerspezifisch ist"): Beleg-Mail, Erkennung "Waschgang fertig" (Gerät
wieder freigeben + optionale Benachrichtigung) und das Aufräumen abgelaufener,
unbezahlter Reservierungen.

Die Edge Function `payment-webhook` (siehe `supabase/functions/`) ruft die
Webhook-Workflows per HTTP POST auf, nachdem sie den Order-Status
serverseitig geändert hat.

## Workflows

| Datei | Trigger | Zweck |
|---|---|---|
| `workflows/order-paid-receipt.json` | Webhook `POST /wama-pay/order-paid` | Zahlungsbeleg per E-Mail, nur wenn ein Kundenkonto mit hinterlegter E-Mail existiert (anonymer Checkout erhält seinen Beleg von SumUp direkt). |
| `workflows/order-released-notify-fertig.json` | Webhook `POST /wama-pay/order-released` | Wartet **entweder** auf ein externes "Waschgang fertig"-Signal (siehe unten) **oder** maximal 2 Stunden (Timeout-Fallback), gibt danach das Gerät wieder frei und verschickt — sofern der Kunde eingeloggt war **und** `customer_notification_settings.notify_on_release = true` — die "Maschine fertig"-E-Mail. |
| `workflows/device-finished-signal.json` | Webhook `POST /wama-pay/device-finished` (statischer Endpunkt, z.B. vom Shelly-Skript aufgerufen) | Weckt die zu diesem Gerät wartende Ausführung von `order-released-notify-fertig` vorzeitig auf, statt auf den 2h-Timeout zu warten. |
| `workflows/reservation-timeout-guard.json` | Schedule (alle 5 Minuten) | Ruft `expire_stale_reservations()` (Migration 0011) auf: setzt abgelaufene, nie bezahlte Reservierungen auf `expired` und gibt das Gerät wieder frei, statt es dauerhaft als `busy` hängen zu lassen. |

### Wie das Fertig-Signal funktioniert

Es gibt aktuell **keine** Rückmeldung von den Geräten selbst (dumme
Freigabe-Relais ohne Status-Feedback). `order-released-notify-fertig`
hinterlegt deshalb beim Start eine n8n-interne "Resume-URL" pro Gerät in der
Tabelle `device_finish_signals` (Migration 0012) und pausiert dann an einem
Wait-Node im Webhook-Resume-Modus mit **2h-Zeitlimit**. Ein separates,
physisches Signal (z.B. das Shelly-Skript in `shelly/`, das per
Leistungsmessung erkennt, wenn die Maschine fertig ist) ruft den statischen
Endpunkt `device-finished-signal` auf; dieser schlägt die passende Resume-URL
nach und ruft sie auf, wodurch die wartende Ausführung sofort fortgesetzt
wird. Kommt kein Signal, läuft nach 2 Stunden automatisch der Timeout ab —
so bleibt kein Gerät dauerhaft als "belegt" hängen, falls das Signal
ausbleibt oder gar kein Sensor angeschlossen ist.

## Setup

Die Supabase-URL (`https://qhnqselrrawmgcrpuazx.supabase.co`) und das
Signal-Secret sind direkt in den vier JSON-Dateien fest eingetragen (keine
Umgebungsvariablen nötig) -- Setup läuft also komplett über die n8n-
Weboberfläche, kein Server-/Terminal-Zugriff nötig:

1. **Supabase-Zugangsdaten als n8n-Credential anlegen**: In n8n unter
   *Credentials* einen generischen "Header Auth"-Credential mit Namen
   **`Supabase Service Role`** anlegen:
   - Header-Name: `apikey` → Wert: der Supabase **Service-Role-Key** (niemals
     der anon-Key, da die RPCs/REST-Calls hier absichtlich RLS umgehen müssen;
     zu finden im Supabase-Dashboard unter Project Settings → API)
   - Zusätzlich einen zweiten Header `Authorization: Bearer <service-role-key>`
     (falls das genutzte HTTP-Request-Node nur einen Header-Auth-Slot erlaubt,
     stattdessen zwei "Header Auth"-Credentials verwenden).
2. **SMTP-Credential** mit Namen **`Wama-Pay SMTP`** anlegen (Absenderadresse
   z. B. `info@energy-leisure.de`) — wird von den "Send Email"-Nodes genutzt.
3. Alle vier JSON-Dateien in n8n importieren (*Import from File*), die
   Credentials in den jeweiligen Nodes zuweisen, Webhook-Workflows aktivieren
   und die erzeugten Produktions-Webhook-URLs notieren — `order-paid` und
   `order-released` werden von der Edge Function `payment-webhook`
   aufgerufen, `device-finished` vom Shelly-Skript.

Das Signal-Secret (im Node "Signal-Key gültig?" in `device-finished-signal.json`
sowie in `shelly/wama-pay-finish-signal.js` als `SIGNAL_SECRET`) ist bereits
in beiden Dateien identisch fest eingetragen -- bei Bedarf (z.B. falls dieses
Repo öffentlich einsehbar ist) durch einen eigenen Wert ersetzen, dann aber
an **beiden** Stellen gleichzeitig ändern.

## Bewusste Design-Entscheidungen

- **Kein Client-seitiges Secret:** Alle drei Workflows sprechen mit Supabase
  ausschließlich über den Service-Role-Key, niemals über den anon-Key. Die
  RPC `expire_stale_reservations()` ist deshalb in Migration 0011 explizit
  für `anon`/`authenticated` gesperrt (`revoke all ... from public, anon,
  authenticated`).
- **Anonymer Checkout bekommt keine "Maschine fertig"-Mail:** Ohne
  Kundenkonto gibt es keine E-Mail-Adresse, an die zuverlässig zugestellt
  werden könnte — das Feature ist bewusst an ein Konto gebunden (siehe
  `webapp-customer/benachrichtigungen.html`).
- **`products.avg_cycle_minutes` wird durch das Fertig-Signal NICHT mehr für
  die Wartezeit genutzt** (Migration 0010 bleibt aber bestehen, z.B. als
  Anzeige-/Planungswert oder Fallback, falls das 2h-Zeitlimit selbst einmal
  angepasst werden soll). Die tatsächliche Wartezeit ist jetzt entweder das
  externe Signal oder das feste 2h-Zeitlimit im Wait-Node.
- **Abgerechnet wird weiterhin ausschließlich pro Nutzung** (siehe
  `products.price_cents`), nicht nach Zeit — das Fertig-Signal hat keinerlei
  Einfluss auf den Preis.
- **Timeout-Wächter greift nur bei nie bestätigter Zahlung:** Orders, die erst
  nach Ablauf des Zeitfensters doch noch als bezahlt gemeldet werden, laufen
  über den separaten Refund-Pfad (`orders.status = 'refund_pending'`), den die
  Edge Function (Task 6) behandelt — der n8n-Wächter fasst solche Orders nicht an.
