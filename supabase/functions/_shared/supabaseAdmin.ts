// Wama-Pay – Service-Role-Client für Edge Functions.
//
// SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY werden von der Supabase-Laufzeit
// automatisch als Umgebungsvariablen bereitgestellt (kein manuelles Secret-
// Setzen nötig) -- siehe https://supabase.com/docs/guides/functions/secrets.
// Dieser Client umgeht RLS grundsätzlich (Supabase-Standardverhalten für die
// Service-Role, siehe supabase/migrations/0009_rls_policies.sql).
import { createClient } from "npm:@supabase/supabase-js@2";

export function createSupabaseAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY nicht gesetzt -- Edge-Function-Laufzeit unvollständig konfiguriert.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
