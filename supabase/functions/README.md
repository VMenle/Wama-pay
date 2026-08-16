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

## payment-webhook

Providerunabhängiger Webhook-Einstiegspunkt (siehe
`docs/payment-provider-adapter.md`). Anders als bei vielen anderen Anbietern
gibt es bei SumUp **keine einmalige globale Webhook-URL-Konfiguration im
Dashboard** -- die Ziel-URL wird stattdessen bei **jeder einzelnen**
Checkout-Erstellung als `return_url` mitgeschickt (macht `create-checkout`
bereits automatisch, siehe `_shared/sumupAdapter.ts`):

```
https://<project-ref>.supabase.co/functions/v1/payment-webhook?provider=sumup
```

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
| `WAMA_PAY_CHECKOUT_BASE_URL` | Basis-URL der Checkout-Webapp, z.B. `https://vmenle.github.io/wama-pay/webapp-checkout` (wird für die Rückleitungs-URL nach der SumUp-Zahlung gebraucht) |
| `WAMA_PAY_N8N_BASE_URL` | z.B. `https://<n8n-host>/webhook` |
| `WAMA_PAY_ALLOWED_ORIGIN` | Domain der Checkout-Webapp (für CORS) |

**Mit CLI (alternativ):**

```bash
supabase secrets set SUMUP_API_KEY=...
supabase secrets set SUMUP_MERCHANT_CODE=...
supabase secrets set SUMUP_WEBHOOK_SIGNING_SECRET=...
supabase secrets set WAMA_PAY_CHECKOUT_BASE_URL=https://vmenle.github.io/wama-pay/webapp-checkout
supabase secrets set WAMA_PAY_N8N_BASE_URL=https://<n8n-host>/webhook
supabase secrets set WAMA_PAY_ALLOWED_ORIGIN=https://<checkout-webapp-domain>
```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` werden von der Supabase-
Laufzeit automatisch bereitgestellt, dafür ist kein manuelles Setzen nötig.
Diese Secrets sind unabhängig von SumUp erforderlich -- solange
`SUMUP_API_KEY`/`SUMUP_MERCHANT_CODE` fehlen, funktioniert nur die
Wallet-Zahlung, nicht die Kartenzahlung.

**Wo kommt das Webhook-Signing-Secret her?** SumUp erzeugt/zeigt dieses
Secret im Dashboard beim Einrichten der Webhook-Benachrichtigung für einen
Merchant (nicht pro einzelnem Checkout). Genauer Ort im Dashboard war zum
Zeitpunkt der Recherche nicht mit letzter Sicherheit zu verifizieren (siehe
Hinweis unten) -- im Zweifel im SumUp-Dashboard unter "Entwickler"/"API"/
"Webhooks" suchen oder den SumUp-Support fragen.

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

## Bekannte offene Punkte (vor Produktivgang zu prüfen)

- Trotz Recherche gegen die offizielle Doku mangels SumUp-Sandbox-Zugang
  **nicht gegen die echte API getestet** -- vor dem ersten echten Zahlungs-
  test insbesondere prüfen: exakter Ort/Name des Webhook-Signing-Secrets im
  Dashboard, ob `hosted_checkout.enabled` für den konkreten SumUp-Account/
  -Vertrag verfügbar ist.
- **PayPal als Ausweichlösung:** Falls sich SumUp Hosted Checkout für den
  vorhandenen Account nicht eignet, ist PayPal als zweiter Provider über
  dieselbe `PaymentProviderAdapter`-Abstraktion nachrüstbar (neue Zeile in
  `payment_providers` + neues `paypalAdapter.ts`, ohne Schema-Änderung) --
  noch nicht umgesetzt, nur vorbereitet.
