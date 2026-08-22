# Edge Functions

## create-checkout

Reserviert ein Gerät und legt eine Order an. Wird von
`webapp-checkout/bezahlen.html` über `supabase.functions.invoke("create-checkout", ...)`
aufgerufen. Bei `payment_method: "wallet"` läuft die Zahlung synchron
(Guthaben-Abbuchung + sofortige Freigabe), bei `"provider"` wird eine
SumUp-**Hosted-Checkout**-Session erstellt: SumUp stellt eine eigene
Zahlungsseite bereit, wir zeigen dem Kunden nur einen Link + QR-Code dorthin
(siehe `verarbeitung.html`) -- keine Kartendaten berühren unseren Server.
Die Zahlungsbestätigung kommt asynchron über `payment-webhook`.

## pay.html (fest aufgehängter QR-Code)

`webapp-checkout/pay.html?device=<devices.device_code>` (z.B. "AA111", siehe
Migration 0023 -- die interne UUID `devices.id` funktioniert ebenfalls) ist der Ziel-Link für einen
**dauerhaft am Gerät angebrachten, gedruckten** SumUp-QR-Code (im
Unterschied zu `bezahlen.html`, wo der Kunde erst ein Gerät und eine
Zahlweise auswählt). Der Link/QR-Code selbst ändert sich nie -- die Seite
ruft bei jedem Aufruf automatisch `create-checkout` auf und leitet sofort
zur frisch erzeugten SumUp-Zahlungsseite weiter. Löst damit das Problem,
dass eine einzelne Hosted-Checkout-Session nur 30 Minuten gültig ist, ohne
dass je ein neuer QR-Code gedruckt werden müsste.

## payment-webhook

Providerunabhängiger Webhook-Einstiegspunkt (siehe
`docs/payment-provider-adapter.md`), bedient sowohl SumUp als auch PayPal
über denselben Endpunkt (`?provider=`-Query-Parameter entscheidet, welcher
Adapter greift):

```
https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=sumup
https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=paypal
```

**SumUp:** keine einmalige globale Webhook-URL-Konfiguration im Dashboard --
die Ziel-URL wird stattdessen bei **jeder einzelnen** Checkout-Erstellung
als `return_url` mitgeschickt (macht `create-checkout` bereits automatisch,
siehe `_shared/sumupAdapter.ts`). Bestätigt eine von uns vorher angelegte
Order (`UnifiedWebhookMode = "confirm_existing_order"`).

**PayPal:** läuft komplett anders -- kein API-Aufruf unsererseits, sondern
ein statisch am Gerät angebrachter PayPal-Payment-Button/QR-Code (siehe
Abschnitt weiter unten). Da es dafür keine vorherige Order gibt
(`UnifiedWebhookMode = "create_order_for_device"`), wird sie erst beim
Zahlungseingang rückwirkend angelegt (`orderLifecycle.ts::createAndReleaseOrderForDevice`).

## Deployment

### Ohne lokale CLI-Installation (empfohlen)

`.github/workflows/deploy-edge-functions.yml` deployt beide Functions
automatisch bei jedem Push nach `main`, der `supabase/functions/**` ändert
(oder manuell über den "Run workflow"-Button im GitHub-Actions-Tab). Läuft
komplett bei GitHub, keine lokale Installation nötig. Dafür einmalig zwei
Repository-Secrets setzen (GitHub -> Repo -> **Settings** -> **Secrets and
variables** -> **Actions** -> **New repository secret**):

| Name | Wert | Woher |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | persönlicher Zugriffstoken | Supabase-Dashboard -> Account-Icon oben rechts -> **Access Tokens** -> **Generate new token** |
| `SUPABASE_PROJECT_ID` | Projekt-Referenz (z.B. `qhnqselrrawmgcrpuazx`) | steht in der Projekt-URL, siehe auch `assets/config.js` |

**Wichtig:** Diesen Zugriffstoken niemals in einen Chat/eine Konversation
einfügen -- direkt in den GitHub-Secrets-Dialog eintragen, der Wert bleibt
dort verschlüsselt und für niemanden mehr einsehbar.

### Mit lokaler CLI (alternativ)

```bash
supabase functions deploy create-checkout
supabase functions deploy payment-webhook
```

`supabase/config.toml` setzt `verify_jwt = false` für `payment-webhook` (SumUp
schickt kein Supabase-JWT mit) -- die Authentizitätsprüfung übernimmt dort
stattdessen die HMAC-SHA256-Webhook-Signatur im SumUp-Adapter.

## Benötigte Secrets (Function-Umgebungsvariablen)

Diese sind etwas anderes als die beiden GitHub-Repository-Secrets oben --
das hier sind die Secrets, mit denen die Functions selbst laufen (SumUp-
Zugangsdaten etc.).

**Ohne CLI:** Supabase-Dashboard -> **Edge Functions** -> **Secrets** (bzw.
**Manage secrets**) -> dort die folgenden Namen/Werte eintragen:

| Name | Beschreibung |
|---|---|
| `SUMUP_API_KEY` | SumUp-API-Schlüssel |
| `SUMUP_MERCHANT_CODE` | SumUp-Merchant-Code |
| `SUMUP_WEBHOOK_SIGNING_SECRET` | Signing-Secret aus dem SumUp-Dashboard (für die HMAC-SHA256-Webhook-Signaturprüfung, Header `x-payload-signature`) |
| `WAMA_PAY_CHECKOUT_BASE_URL` | Basis-URL der Checkout-Webapp, z.B. `https://wamapay.netlify.app/webapp-checkout` (wird für die Rückleitungs-URL nach der SumUp-Zahlung gebraucht) |
| `WAMA_PAY_N8N_BASE_URL` | z.B. `https://<n8n-host>/webhook` |
| `WAMA_PAY_ALLOWED_ORIGIN` | Domain der Checkout-Webapp (für CORS) |

**Mit CLI (alternativ):**

```bash
supabase secrets set SUMUP_API_KEY=...
supabase secrets set SUMUP_MERCHANT_CODE=...
supabase secrets set SUMUP_WEBHOOK_SIGNING_SECRET=...
supabase secrets set WAMA_PAY_CHECKOUT_BASE_URL=https://wamapay.netlify.app/webapp-checkout
supabase secrets set WAMA_PAY_N8N_BASE_URL=https://<n8n-host>/webhook
supabase secrets set WAMA_PAY_ALLOWED_ORIGIN=https://wamapay.netlify.app
```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` werden von der Supabase-
Laufzeit automatisch bereitgestellt, dafür ist kein manuelles Setzen nötig.
Diese Secrets sind unabhängig von SumUp erforderlich -- solange
`SUMUP_API_KEY`/`SUMUP_MERCHANT_CODE` fehlen, funktioniert nur die
Wallet-Zahlung, nicht die Kartenzahlung.

**Wo kommt das Webhook-Signing-Secret her?** SumUp erzeugt/zeigt dieses
Secret im Dashboard beim Einrichten der Webhook-Benachrichtigung für einen
Merchant (nicht pro einzelnem Checkout). Genauer Ort im Dashboard war zum
Zeitpunkt der Recherche nicht mit letzter Sicherheit zu verifizieren, und
im getesteten Account (Stand 20.08.2026) unter "Entwicklereinstellungen"
(Tabs: Sandboxes, Zahlungs-Wallets, API-Schlüssel, OAuth2-Anwendungen,
Affiliate Keys) nicht auffindbar -- im Zweifel den SumUp-Support fragen.
**Fehlt dieses Secret, funktioniert die SumUp-Zahlung trotzdem:**
`SUMUP_WEBHOOK_SIGNING_SECRET` ist optional -- ist es nicht gesetzt,
verarbeitet `payment-webhook` eingehende SumUp-Webhooks weiterhin (nur mit
einer Log-Warnung statt Signaturprüfung), weil der tatsächliche
Zahlungsstatus ohnehin nie aus dem Webhook-Body übernommen wird, sondern
immer zusätzlich per eigenem, authentifiziertem GET-Aufruf direkt bei
SumUp verifiziert wird (siehe `resolveWebhookPayload` in
`sumupAdapter.ts`). Die Signatur ist also nur zusätzliche Absicherung,
keine Voraussetzung für die eigentliche Sicherheit.

## Wie die SumUp-Anbindung funktioniert (Hosted Checkout)

Recherchiert gegen die offizielle SumUp-Entwicklerdokumentation
([Hosted Checkout](https://developer.sumup.com/online-payments/checkouts/hosted-checkout),
[Webhooks](https://developer.sumup.com/online-payments/webhooks)):

1. `create-checkout` erstellt bei SumUp einen Checkout mit
   `hosted_checkout.enabled = true`. Die Antwort enthält `hosted_checkout_url`
   (SumUps eigene Zahlungsseite, Format z.B.
   `https://checkout.sumup.com/pay/<id>`, 30 Minuten gültig) -- die zeigen
   wir dem Kunden als Link **und** als QR-Code (`verarbeitung.html`).
2. `return_url` (im Request an SumUp, server-seitig) wird auf unsere eigene
   `payment-webhook`-URL gesetzt -- **ohne dieses Feld sendet SumUp gar
   keinen Webhook**. `redirect_url` ist davon getrennt: die
   Browser-Rückleitung des Kunden nach der Zahlung auf SumUps Seite, zurück
   zu `verarbeitung.html`.
3. Der Webhook-Body selbst gilt nicht als vertrauenswürdig für den
   Zahlungsstatus -- `payment-webhook` holt sich den tatsächlichen Status
   immer per GET direkt von SumUp (`resolveWebhookPayload`).
4. Die Webhook-Authentizität wird per echter HMAC-SHA256-Signaturprüfung
   sichergestellt (Header `x-payload-signature`), nicht mehr über ein
   Platzhalter-Secret.
5. Offizielle SumUp-Status-Werte für einen Checkout: `PENDING`, `EXPIRED`,
   `SUCCESSFUL` (nicht `PAID`/`FAILED`, wie in einer früheren Fassung dieses
   Adapters fälschlich angenommen).

## Wie die PayPal-Anbindung funktioniert (statischer Payment-Button + IPN)

Anders als SumUp läuft PayPal **nicht** über die Webapp/`create-checkout`,
sondern über einen einmalig im PayPal-Business-Account angelegten,
dauerhaft am Gerät angebrachten **Payment Button** (mit QR-Code):

1. Im PayPal-Business-Account einen Payment Button pro Gerät anlegen, dabei:
   - **Betrag fest** auf den Preis des jeweiligen Geräts einstellen
   - Verstecktes Feld **`custom`** (oder `item_number`) auf den Wama-Pay
     `devices.device_code` **dieser** Maschine setzen (z.B. "AA111", siehe
     Migration 0023 -- NICHT die interne UUID) -- darüber ordnen wir die
     eingehende Zahlung dem richtigen Gerät zu
   - Unter Account-Einstellungen -> **"Instant Payment Notifications"** die
     Benachrichtigungs-URL auf `.../payment-webhook?provider=paypal` setzen
   - QR-Code für den Button erzeugen (PayPal bietet das direkt an), drucken,
     am Gerät anbringen
2. Kunde scannt, bezahlt direkt auf PayPals Seite -- unser Server ist an
   diesem Schritt gar nicht beteiligt.
3. PayPal schickt danach eine klassische **IPN** (POST,
   `application/x-www-form-urlencoded`) an `payment-webhook?provider=paypal`.
4. Authentizität wird über PayPals offiziellen Postback-Mechanismus geprüft
   (Body unverändert + `cmd=_notify-validate` zurück an PayPal senden,
   Antwort muss `VERIFIED` sein) -- kein API-Key/Secret nötig.
5. Da es für diese Zahlung keine vorherige Order gibt, wird sie jetzt erst
   angelegt (Status direkt `paid`) und das Gerät freigegeben -- sofern es
   gerade frei ist. Ist es belegt, wird die Zahlung trotzdem verbucht
   (Geld ist geflossen), aber **nicht** freigegeben -- das braucht manuelle
   Nachbearbeitung (siehe `audit_log`-Eintrag `order.paid_but_device_busy`).
6. Idempotenz (falls PayPal dieselbe IPN mehrfach zustellt, was laut
   PayPal-Doku vorkommen kann) läuft über die eindeutige `txn_id` als
   `orders.provider_ref` (nutzt die bestehende
   `orders_provider_ref_unique_idx`, keine Schema-Änderung nötig).

**Keine Secrets nötig** für die PayPal-Anbindung selbst (IPN-Verifikation
braucht keinen API-Key) -- nur die korrekte Einrichtung des Payment Buttons
im PayPal-Dashboard.

## Bekannte offene Punkte (vor Produktivgang zu prüfen)

- Trotz Recherche gegen die offizielle Doku mangels SumUp-Sandbox-Zugang
  **nicht gegen die echte API getestet** -- vor dem ersten echten Zahlungs-
  test insbesondere prüfen: exakter Ort/Name des Webhook-Signing-Secrets im
  Dashboard, ob `hosted_checkout.enabled` für den konkreten SumUp-Account/
  -Vertrag verfügbar ist.
- PayPal-Anbindung ebenfalls **nicht gegen einen echten Payment Button
  getestet** (kein PayPal-Account-Zugang) -- vor Produktivgang unbedingt
  einmal mit einem echten Testbetrag durchspielen, insbesondere: kommt das
  `custom`-Feld tatsächlich unverändert in der IPN an, funktioniert die
  Postback-Verifikation wie erwartet.
- Race Condition beim PayPal-Weg: zahlen theoretisch zwei Kunden kurz
  hintereinander auf denselben Button, während das Gerät noch frei ist,
  gewinnt nur die zuerst verarbeitete Zahlung die Geräte-Freigabe: der
  zweite Zahlungseingang wird als `paid_device_busy` verbucht (Geld korrekt
  vereinnahmt, aber keine zweite Freigabe) und braucht manuelle
  Nachbearbeitung -- ein prinzipbedingter Kompromiss des reservierungslosen
  statischen QR-Modells.
