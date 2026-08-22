# n8n-Workflows (Teil c)

Diese Workflows übernehmen die Folgeaufgaben, die bewusst **nicht** in der
Edge Function `payment-webhook` liegen (siehe
`docs/payment-provider-adapter.md`, Abschnitt "Was bewusst NICHT
providerspezifisch ist"): Beleg-Mail und Erkennung "Waschgang fertig" (Gerät
wieder freigeben + optionale Benachrichtigung).

Das Aufräumen abgelaufener, unbezahlter Reservierungen läuft **nicht** über
n8n, sondern direkt in der Datenbank per `pg_cron` (Migration 0022) -- kein
Webhook-Umweg nötig, siehe `supabase/migrations/0022_reservation_timeout_pg_cron.sql`.

Die Edge Function `payment-webhook` (siehe `supabase/functions/`) ruft die
Webhook-Workflows per HTTP POST auf, nachdem sie den Order-Status
serverseitig geändert hat.

## Workflows

| Datei | Trigger | Zweck |
|---|---|---|
| `workflows/order-paid-receipt.json` | Webhook `POST /wama-pay/order-paid` | Zahlungsbeleg per E-Mail, nur wenn ein Kundenkonto mit hinterlegter E-Mail existiert (anonymer Checkout erhält seinen Beleg von SumUp direkt). |
| `workflows/order-released-notify-fertig.json` | Webhook `POST /wama-pay/order-released` | Wartet **entweder** auf ein externes "Waschgang fertig"-Signal (siehe unten) **oder** maximal 2 Stunden (Timeout-Fallback), gibt danach das Gerät wieder frei und verschickt — sofern der Kunde eingeloggt war **und** `customer_notification_settings.notify_on_release = true` — die "Maschine fertig"-E-Mail. |
| `workflows/device-finished-signal.json` | Webhook `POST /wama-pay/device-finished` (statischer Endpunkt, z.B. vom Shelly-Skript aufgerufen) | Weckt die zu diesem Gerät wartende Ausführung von `order-released-notify-fertig` vorzeitig auf, statt auf den 2h-Timeout zu warten. |

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
Signal-Secret sind direkt in den drei JSON-Dateien fest eingetragen (keine
Umgebungsvariablen nötig) -- Setup läuft also komplett über die n8n-
Weboberfläche, kein Server-/Terminal-Zugriff nötig:

1. **Supabase-Zugangsdaten als n8n-Credential anlegen**: In n8n unter
   *Credentials* → *Add Credential* → **"Header Auth"** einen Credential mit
   Namen **`Supabase Service Role`** anlegen, mit genau diesen zwei Feldern:
   - **Name**: `apikey`
   - **Value**: der Supabase **Service-Role-Key** (niemals der anon-Key, da
     die RPCs/REST-Calls hier absichtlich RLS umgehen müssen -- zu finden im
     Supabase-Dashboard unter **Project Settings → API Keys**, Zeile
     `service_role` mit dem roten "secret"-Badge)

   Ein einzelner `apikey`-Header genügt -- Supabase leitet daraus
   automatisch die passende Berechtigung ab, ein zusätzlicher
   `Authorization`-Header ist nicht nötig. Die HTTP-Request-Nodes in den drei
   JSON-Dateien sind bereits so vorkonfiguriert, dass sie diesen Credential
   automatisch verwenden (Feld "Authentication" → "Predefined Credential
   Type" ist absichtlich NICHT gesetzt, sondern der generische "Header Auth"
   -- beim Import muss lediglich der oben angelegte Credential in jedem
   HTTP-Request-Node ausgewählt werden, falls n8n ihn nicht automatisch
   zuordnet).
2. **SMTP-Credential** mit Namen **`Wama-Pay SMTP`** anlegen (Absenderadresse
   z. B. `info@energy-leisure.de`) — wird von den "Send Email"-Nodes genutzt.
3. Alle drei JSON-Dateien in n8n importieren (*Import from File*), die
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

- **Kein Client-seitiges Secret:** Die verbliebenen n8n-Workflows sprechen mit
  Supabase ausschließlich über den Service-Role-Key, niemals über den
  anon-Key.
- **Reservierungs-Timeout läuft bewusst nicht über n8n:** anders als
  "Waschgang fertig" (das auf ein externes, physisches Signal wartet) hat das
  Reservierungs-Timeout keinen externen Auslöser -- es ist reine
  Zeitablauf-Logik innerhalb der Datenbank. Dafür pg_cron zu nutzen (Migration
  0022) ist einfacher und robuster als ein n8n-Umweg: kein Webhook, kein
  Credential, kein zusätzlicher Ausfallpunkt.
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
- **pg_cron greift nur bei nie bestätigter Zahlung:** Orders, die erst
  nach Ablauf des Zeitfensters doch noch als bezahlt gemeldet werden, laufen
  über den separaten Refund-Pfad (`orders.status = 'refund_pending'`), den die
  Edge Function (Task 6) behandelt — `expire_stale_reservations()` fasst
  solche Orders nicht an.
