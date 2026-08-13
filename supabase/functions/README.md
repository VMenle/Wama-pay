# Edge Functions

## create-checkout

Reserviert ein Gerät und legt eine Order an. Wird von
`webapp-checkout/bezahlen.html` über `supabase.functions.invoke("create-checkout", ...)`
aufgerufen. Bei `payment_method: "wallet"` läuft die Zahlung synchron
(Guthaben-Abbuchung + sofortige Freigabe), bei `"provider"` wird eine
SumUp-Checkout-Session erstellt und die Bestätigung kommt asynchron über
`payment-webhook`.

## payment-webhook

Providerunabhängiger Webhook-Einstiegspunkt (siehe
`docs/payment-provider-adapter.md`). SumUp muss im SumUp-Dashboard auf
folgende URL konfiguriert werden:

```
https://<project-ref>.functions.supabase.co/payment-webhook?provider=sumup
```

## Deployment

```bash
supabase functions deploy create-checkout
supabase functions deploy payment-webhook
```

`supabase/config.toml` setzt `verify_jwt = false` für `payment-webhook` (SumUp
schickt kein Supabase-JWT mit) -- die Authentizitätsprüfung übernimmt dort
stattdessen das geteilte Webhook-Secret im SumUp-Adapter.

## Benötigte Secrets

```bash
supabase secrets set SUMUP_API_KEY=...
supabase secrets set SUMUP_MERCHANT_CODE=...
supabase secrets set SUMUP_WEBHOOK_SHARED_SECRET=...   # selbst gewähltes, langes Zufalls-Secret
supabase secrets set WAMA_PAY_N8N_BASE_URL=https://<n8n-host>/webhook
supabase secrets set WAMA_PAY_ALLOWED_ORIGIN=https://<checkout-webapp-domain>
```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` werden von der Supabase-
Laufzeit automatisch bereitgestellt, dafür ist kein manuelles Setzen nötig.

Beim Einrichten der Webhook-URL im SumUp-Dashboard muss
`SUMUP_WEBHOOK_SHARED_SECRET` als Header `X-Wama-Pay-Webhook-Token` mit
jedem Webhook-Aufruf mitgeschickt werden -- falls SumUp das nicht direkt als
konfigurierbaren Header unterstützt, ersatzweise als Query-Parameter an die
Webhook-URL anhängen und `sumupAdapter.ts::verifyWebhookRequest` entsprechend
anpassen (TODO, siehe Kommentar dort -- **nicht gegen echtes SumUp-Dashboard
verifiziert**, siehe Hinweis in `_shared/sumupAdapter.ts`).

## Bekannte offene Punkte (vor Produktivgang zu prüfen)

- **SumUp-Checkout-UX:** `sumupAdapter.createCheckout` liefert aktuell keine
  `redirectUrl` zurück. Es muss geklärt werden, ob SumUp eine gehostete
  Zahlungsseite (Redirect) oder ein einbettbares Card-Widget mit der
  Checkout-Id bereitstellt, und `verarbeitung.html`/der Adapter entsprechend
  ergänzt werden -- ohne das fehlt aktuell die eigentliche Karteneingabe-UI.
- **Webhook-Signatur:** siehe oben, Shared-Secret-Mechanismus ist ein
  Platzhalter-Ansatz, keine kryptographische Signaturprüfung. Falls SumUp
  echte Signaturen anbietet, `verifyWebhookRequest` darauf umstellen.
- Alle SumUp-API-Aufrufe folgen der öffentlich dokumentierten REST-API v0.1,
  wurden aber mangels Sandbox-Zugang nicht gegen die echte API getestet.
