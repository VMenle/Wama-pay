-- Wama-Pay Schema · Migration 0021
-- Fix: expire_stale_reservations() (Migration 0011) wurde per
-- `revoke all ... from public, anon, authenticated` gesperrt, aber nie
-- explizit für service_role wieder freigegeben. Da service_role seine
-- Ausführungsrechte hier nur über die implizite PUBLIC-Berechtigung hatte
-- (die durch "revoke ... from public" mit entzogen wurde), konnte
-- anschließend NIEMAND mehr die Funktion aufrufen -- auch n8n mit dem
-- Service-Role-Key nicht ("permission denied for function
-- expire_stale_reservations").
--
-- verify_override_pin() (Migration 0019) hat denselben Revoke-Befehl, hat
-- den Fehler in der Praxis aber nicht gezeigt -- hier trotzdem vorsorglich
-- dieselbe explizite Freigabe ergänzt, um keine unterschiedliche
-- Berechtigungslogik zwischen beiden Funktionen zu haben.
grant execute on function public.expire_stale_reservations() to service_role;
grant execute on function public.verify_override_pin(uuid, text) to service_role;
