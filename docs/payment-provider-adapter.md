# Payment-Provider-Abstraktion

Bestätigt mit Auftraggeber am 2026-08-04. Ziel: SumUp ist aktuell der einzige
Zahlungs-Provider, soll aber austauschbar sein, ohne Datenbankschema,
Freigabelogik oder restlichen Ablauf anzufassen.

## Bausteine

1. **`payment_providers`-Tabelle** (`supabase/migrations/0002_payment_providers.sql`)
   Enthält je Provider eine Zeile mit `id` (z. B. `sumup`), Anzeigename und
   Aktiv-Status. Ausschließlich nicht-geheime Konfiguration — API-Keys/Secrets
   werden **nie** hier gespeichert, sondern als Edge Function Secrets /
   Umgebungsvariablen.

2. **`orders.provider_id`**
   Jede Order, die per Provider bezahlt wird, referenziert genau einen
   Eintrag aus `payment_providers`. Bei Wallet-Zahlungen bleibt `provider_id`
   `null` (siehe `payment_method`-Unterscheidung).

3. **Austauschbares Verifizierungsmodul** (Edge Function, Teil b)
   Die Webhook-Edge-Function `payment-webhook` hat einen gemeinsamen,
   providerunabhängigen Einstiegspunkt. Für jeden Provider existiert ein
   eigenes Adapter-Modul, das ein gemeinsames Interface implementiert:

   ```ts
   interface PaymentProviderAdapter {
     // Prüft die Signatur/Authentizität des eingehenden Webhook-Requests.
     verifySignature(rawBody: string, headers: Headers, secret: string): boolean;

     // Übersetzt den providerspezifischen Payload in ein einheitliches Format.
     mapPayload(rawBody: string): {
       orderRef: string;      // korrespondiert mit orders.provider_ref bzw. orders.id
       status: 'paid' | 'failed' | 'pending';
       amountCents: number;
       currency: string;
       paidAt: string;        // ISO 8601
     };
   }
   ```

   `sumupAdapter.ts` implementiert dieses Interface für SumUp. Ein neuer
   Provider bedeutet: neue Zeile in `payment_providers` + neues Adapter-Modul
   (`<provider>Adapter.ts`) + Eintrag in der Dispatch-Tabelle der Edge
   Function. Datenbankschema, Freigabelogik, Idempotenz-Prüfung und
   restlicher Ablauf bleiben unverändert.

## Was bewusst NICHT providerspezifisch ist

- Idempotenz-Check über `order_id`
- Statusübergänge der Order (`orders.status`)
- Geräte-Freigabelogik (`release_events`)
- n8n-Trigger für Folgeaufgaben (Beleg-Mail etc.)

Diese Teile kennen nur das einheitliche, providerunabhängige Format aus
`mapPayload()`.
