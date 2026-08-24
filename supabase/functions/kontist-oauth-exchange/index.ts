// Wama-Pay – Edge Function "kontist-oauth-exchange"
//
// Einmaliger Setup-Schritt (Task: Echtzeitüberweisung/Wallet-Aufladung via
// Kontist-Kontoauszug-Abfrage): tauscht den Autorisierungscode, den Kontist
// nach der Anmeldung an oauth-callback.html im "code"-Query-Parameter
// mitschickt, gegen ein dauerhaftes Zugriffstoken-Paar (access_token +
// refresh_token) ein.
//
// Nur einmalig manuell im Browser aufzurufen -- KEIN Teil des laufenden
// Betriebs. Das Client-Secret bleibt dabei ausschließlich serverseitig
// (Supabase Edge-Function-Secret), landet nie im Git-Repo oder im Browser.
//
// Aufruf: GET .../functions/v1/kontist-oauth-exchange?code=<code-aus-der-url>
// Antwort (JSON): { access_token, refresh_token, expires_in, ... }
// -- den Wert von "refresh_token" bitte als Supabase-Secret
// KONTIST_REFRESH_TOKEN eintragen, danach ist dieser Setup-Schritt erledigt.
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const KONTIST_TOKEN_URL = "https://api.kontist.com/api/oauth/token";

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return jsonResponse({ error: "missing_code", detail: "Query-Parameter 'code' fehlt." }, 400);
  }

  const clientId = Deno.env.get("KONTIST_CLIENT_ID");
  const clientSecret = Deno.env.get("KONTIST_CLIENT_SECRET");
  const redirectUri = Deno.env.get("KONTIST_OAUTH_REDIRECT_URI") ?? "https://wamapay.netlify.app/oauth-callback.html";
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: "missing_config", detail: "KONTIST_CLIENT_ID/KONTIST_CLIENT_SECRET nicht gesetzt." }, 500);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(KONTIST_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return jsonResponse({ error: "token_exchange_failed", detail: data }, 502);
  }

  return jsonResponse(data);
});
