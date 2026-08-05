// Wama-Pay – Supabase-Projektkonfiguration.
//
// TODO: Nach Anlage des Supabase-Projekts (EU-Region) hier die echten Werte
// eintragen. Die anon-Key ist laut Supabase-Design für den Client bestimmt
// (Zugriff wird ausschließlich über RLS eingeschränkt, siehe
// supabase/migrations/0009_rls_policies.sql) und ist daher kein Geheimnis,
// das versteckt werden müsste – ABER: solange hier Platzhalter stehen,
// funktioniert keine Verbindung. Siehe README.md ("Setup").
window.WAMA_PAY_CONFIG = {
  supabaseUrl: "TODO_SUPABASE_PROJECT_URL",
  supabaseAnonKey: "TODO_SUPABASE_ANON_KEY",
  projectKey: "waschsalon"
};
