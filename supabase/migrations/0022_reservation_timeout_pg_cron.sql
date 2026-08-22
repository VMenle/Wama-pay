-- Wama-Pay Schema · Migration 0022
-- Ersetzt die n8n-Workflows für das Reservierungs-Timeout
-- (reservation-timeout-immediate.json / reservation-timeout-guard.json)
-- durch pg_cron -- läuft komplett innerhalb der Datenbank, kein
-- Webhook-Umweg über n8n mehr nötig.
--
-- Bewusst KEIN dauerhaft wiederkehrender Job (z.B. "alle 2 Minuten"): pro
-- Reservierung wird stattdessen genau EIN einmaliger pg_cron-Job exakt zum
-- Ablaufzeitpunkt eingeplant, der sich nach der Ausführung selbst wieder
-- entfernt (cron.unschedule). Kein Dauerlauf, kein Polling -- nur ein
-- einziger, gezielter Check pro Reservierung.
create extension if not exists pg_cron with schema extensions;

-- Wird von create-checkout unmittelbar nach dem Anlegen einer Reservierung
-- aufgerufen (nur beim Provider-Zahlweg -- Wallet-Zahlungen lösen sich
-- synchron im selben Request auf, brauchen also kein Timeout).
create or replace function public.schedule_reservation_expiry_check(p_run_at timestamptz)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_job_name text := 'wama_pay_expiry_' || replace(gen_random_uuid()::text, '-', '');
begin
  -- pg_cron kennt kein natives "einmalig zu einem Zeitpunkt" -- wird
  -- deshalb über ein Cron-Muster nachgebaut, das exakt auf p_run_at passt
  -- (Minute/Stunde/Tag/Monat fest, Wochentag offen), und der Job entfernt
  -- sich in seinem eigenen Befehl gleich wieder selbst.
  perform cron.schedule(
    v_job_name,
    to_char(p_run_at, 'MI HH24 DD MM') || ' *',
    format(
      $cmd$select public.expire_stale_reservations(); select cron.unschedule(%L);$cmd$,
      v_job_name
    )
  );
end;
$$;

grant execute on function public.schedule_reservation_expiry_check(timestamptz) to service_role;

comment on function public.schedule_reservation_expiry_check(timestamptz) is
  'Plant einen einmaligen, sich selbst entfernenden pg_cron-Job exakt zum uebergebenen Zeitpunkt, der expire_stale_reservations() aufruft. Wird von create-checkout pro Reservierung aufgerufen (Provider-Zahlweg).';

-- Sicherheitsnetz: falls das Einplanen des Jobs oben in Einzelfällen selbst
-- fehlschlägt (z.B. kurzer Datenbank-Aussetzer im Moment der Reservierung),
-- bleibt sonst nichts übrig, das eine liegengebliebene Reservierung je
-- aufräumt. Deshalb zusätzlich ein einzelner, stündlicher Rückfall-Job --
-- bewusst selten, nur als letztes Netz, kein Ersatz für den gezielten
-- Job oben.
select cron.schedule(
  'wama_pay_expiry_hourly_backup',
  '0 * * * *',
  $$select public.expire_stale_reservations();$$
);
