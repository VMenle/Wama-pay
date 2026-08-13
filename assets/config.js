// Wama-Pay – Supabase-Projektkonfiguration.
//
// Der anon-Key ist laut Supabase-Design für den Client bestimmt (Zugriff
// wird ausschließlich über RLS eingeschränkt, siehe
// supabase/migrations/0009_rls_policies.sql) und ist daher kein Geheimnis,
// das versteckt werden müsste. Der service_role-Key gehört NIEMALS hierher
// oder sonst irgendwo ins Frontend/Repo -- er hebelt RLS vollständig aus.
window.WAMA_PAY_CONFIG = {
  supabaseUrl: "https://qhnqselrrawmgcrpuazx.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFobnFzZWxycmF3bWdjcnB1YXp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NDAxNDMsImV4cCI6MjEwMjIxNjE0M30.ll7hfz8agCKYrZIAySceeHOzHrM3pA3f4pe7Cmj8APo",
  projectKey: "waschsalon"
};
