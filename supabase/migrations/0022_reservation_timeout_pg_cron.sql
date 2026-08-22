-- Wama-Pay Schema · Migration 0022
-- Ersetzt die n8n-Workflows für das Reservierungs-Timeout
-- (reservation-timeout-immediate.json / reservation-timeout-guard.json)
-- durch pg_cron: expire_stale_reservations() (Migration 0011) läuft jetzt
-- direkt in der Datenbank auf Zeitplan -- kein Webhook-Umweg über n8n mehr
-- nötig, damit entfällt auch die gesamte Service-Role-Header-/
-- Berechtigungsproblematik für diesen einen Ablauf.
create extension if not exists pg_cron with schema extensions;

-- Alle 2 Minuten prüfen -- die Funktion selbst ist eine einzelne, schnelle
-- Abfrage (kein spürbarer Ressourcenverbrauch), 2 Minuten sind bewusst kurz
-- gewählt, damit ein Gerät nach einer abgebrochenen Zahlung zügig wieder
-- für andere Kunden freigegeben wird.
select cron.schedule(
  'wama-pay-expire-stale-reservations',
  '*/2 * * * *',
  $$select public.expire_stale_reservations();$$
);
