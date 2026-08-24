-- Wama-Pay Schema · Migration 0025
-- Absicherung gegen einen möglichen Zeitzonen-Bug in
-- schedule_reservation_expiry_check() (Migration 0024): to_char() auf einem
-- timestamptz interpretiert den Wert immer in der SESSION-Zeitzone der
-- aktuellen Verbindung, nicht zwingend in UTC. pg_cron wertet die geplanten
-- cron-Ausdrücke standardmäßig in UTC aus (cron.timezone). Sollte die
-- Datenbank-Session hier jemals mit einer anderen Zeitzone als UTC laufen
-- (z.B. durch eine künftige Konfigurationsänderung), würden die
-- eingeplanten Checks zur falschen Uhrzeit feuern -- bei einer
-- Zeitzonen-Differenz von 1-2 Stunden könnte das dazu führen, dass der
-- "finale" 15-Minuten-Check viel zu früh oder zu spät läuft.
--
-- Vorbeugende Absicherung (bisher nicht als tatsächlich falsch beobachtet,
-- aber im Kontext des gesamten Timing-lastigen Reservierungs-Features
-- billige Zusatzsicherheit): p_run_at wird jetzt explizit über
-- "AT TIME ZONE 'UTC'" in UTC-Wanduhrzeit umgewandelt, BEVOR to_char()
-- darauf angewendet wird -- unabhängig von der jeweiligen Session-Zeitzone.
create or replace function public.schedule_reservation_expiry_check(p_run_at timestamptz, p_order_id uuid, p_is_final boolean)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_job_name text := 'wama_pay_reconcile_' || replace(gen_random_uuid()::text, '-', '');
  v_function_url text := 'https://qhnqselrrawmgcrpuazx.supabase.co/functions/v1/reconcile-provider-order';
begin
  perform cron.schedule(
    v_job_name,
    to_char(p_run_at at time zone 'UTC', 'MI HH24 DD MM') || ' *',
    format(
      $cmd$
      select net.http_post(
        url := %L,
        body := jsonb_build_object('order_id', %L, 'is_final', %L),
        headers := jsonb_build_object('Content-Type', 'application/json')
      );
      select cron.unschedule(%L);
      $cmd$,
      v_function_url, p_order_id, p_is_final, v_job_name
    )
  );
end;
$$;
