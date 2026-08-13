// Wama-Pay – gemeinsame CORS-Header für die vom Browser aus aufgerufenen
// Edge Functions (create-checkout). payment-webhook wird ausschließlich
// von SumUp server-seitig aufgerufen und braucht daher kein CORS.
//
// TODO: WAMA_PAY_ALLOWED_ORIGIN als Edge Function Secret auf die
// tatsächliche Domain der Checkout-Webapp setzen (z.B.
// "https://checkout.wama-pay.example"), sobald diese feststeht. Bis dahin
// Wildcard, um lokale Entwicklung/Tests nicht zu blockieren.
const allowedOrigin = Deno.env.get("WAMA_PAY_ALLOWED_ORIGIN") ?? "*";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
