# n8n-Workflows (Teil c)

Diese Workflows übernehmen die Folgeaufgaben, die bewusst **nicht** in der
Edge Function `payment-webhook` liegen (siehe
`docs/payment-provider-adapter.md`, Abschnitt "Was bewusst NICHT
providerspezifisch ist"): Beleg-Mail, "Maschine fertig"-Benachrichtigung und
das Aufräumen abgelaufener, unbezahlter Reservierungen.

Die Edge Function selbst (Task 6, noch offen) ruft die Webhook-Workflows per
HTTP POST auf, nachdem sie den Order-Status serverseitig geändert hat. Bis
Task 6 umgesetzt ist, können die Webhooks manuell (z. B. mit curl/Postman)
gegen Testdaten ausgelöst werden.

## Workflows

| Datei | Trigger | Zweck |
|---|---|---|
| `workflows/order-paid-receipt.json` | Webhook `POST /wama-pay/order-paid` | Zahlungsbeleg per E-Mail, nur wenn ein Kundenkonto mit hinterlegter E-Mail existiert (anonymer Checkout erhält seinen Beleg von SumUp direkt). |
| `workflows/order-released-notify-fertig.json` | Webhook `POST /wama-pay/order-released` | Wartet die geschätzte Programmdauer ab (`products.avg_cycle_minutes`, Migration 0010) und verschickt danach die "Maschine fertig"-E-Mail, sofern der Kunde eingeloggt war **und** `customer_notification_settings.notify_on_release = true`. |
| `workflows/reservation-timeout-guard.json` | Schedule (alle 5 Minuten) | Ruft `expire_stale_reservations()` (Migration 0011) auf: setzt abgelaufene, nie bezahlte Reservierungen auf `expired` und gibt das Gerät wieder frei, statt es dauerhaft als `busy` hängen zu lassen. |

## Setup

1. **Supabase-Zugangsdaten als n8n-Credential anlegen** (nicht im Workflow-JSON,
   damit kein Secret im Repo landet): In n8n unter *Credentials* einen
   generischen "Header Auth"-Credential mit Namen
   **`Supabase Service Role`** anlegen:
   - Header-Name: `apikey` → Wert: der Supabase **Service-Role-Key** (niemals
     der anon-Key, da die RPCs/REST-Calls hier absichtlich RLS umgehen müssen)
   - Zusätzlich einen zweiten Header `Authorization: Bearer <service-role-key>`
     (falls das genutzte HTTP-Request-Node nur einen Header-Auth-Slot erlaubt,
     stattdessen zwei "Header Auth"-Credentials verwenden oder die Header
     direkt im Node unter "Header Parameters" mit einer n8n-Credential-Variable
     referenzieren).
   - In allen drei Workflows referenzieren die HTTP-Request-Nodes die Basis-URL
     über die Umgebungsvariable `SUPABASE_URL` (in n8n unter *Settings →
     Environment* oder als n8n-Umgebungsvariable `WAMA_PAY_SUPABASE_URL`
     hinterlegen und die Platzhalter-URL in den Nodes danach anpassen).
2. **SMTP-Credential** mit Namen **`Wama-Pay SMTP`** anlegen (Absenderadresse
   z. B. `info@energy-leisure.de`) — wird von den "Send Email"-Nodes genutzt.
3. Alle drei JSON-Dateien in n8n importieren (*Import from File*), die beiden
   Credentials in den jeweiligen Nodes zuweisen, Webhook-Workflows aktivieren
   und die erzeugten Produktions-Webhook-URLs notieren — diese werden später
   von der Edge Function `payment-webhook` aufgerufen (Task 6).

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
- **Zeitbasierte Wartezeit ist eine Schätzung, keine Abrechnungsgrundlage:**
  `avg_cycle_minutes` steuert ausschließlich, wann die Benachrichtigung
  verschickt wird. Abgerechnet wird weiterhin ausschließlich pro Nutzung
  (siehe `products.price_cents`), nicht nach Zeit.
- **Timeout-Wächter greift nur bei nie bestätigter Zahlung:** Orders, die erst
  nach Ablauf des Zeitfensters doch noch als bezahlt gemeldet werden, laufen
  über den separaten Refund-Pfad (`orders.status = 'refund_pending'`), den die
  Edge Function (Task 6) behandelt — der n8n-Wächter fasst solche Orders nicht an.
