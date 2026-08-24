-- Wama-Pay Schema · Migration 0024
-- Sicherheitsnetz gegen ausbleibende Webhook-Zustellung: der einmalige,
-- selbst-entfernende pg_cron-Job pro Reservierung (Migration 0022/0023)
-- ruft jetzt statt direkt expire_stale_reservations() die neue Edge
-- Function reconcile-provider-order auf -- die fragt zuerst AKTIV beim
-- Zahlungsanbieter nach, ob die Zahlung inzwischen doch erfolgreich war
-- (falls der Webhook z.B. verloren ging), und räumt erst danach ab, falls
-- der Anbieter immer noch "pending" meldet.
--
-- Anlass: eine echte Testzahlung bei SumUp war erfolgreich, aber
-- payment-webhook wurde nie aufgerufen -- die Order blieb dauerhaft auf
-- 'payment_pending' hängen, ohne dass wir das automatisch bemerkt hätten.
create extension if not exists pg_net with schema extensions;

drop function if exists public.schedule_reservation_expiry_check(timestamptz);

create or replace function public.schedule_reservation_expiry_check(p_run_at timestamptz, p_order_id uuid)
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
    to_char(p_run_at, 'MI HH24 DD MM') || ' *',
    format(
      $cmd$
      select net.http_post(
        url := %L,
        body := jsonb_build_object('order_id', %L),
        headers := jsonb_build_object('Content-Type', 'application/json')
      );
      select cron.unschedule(%L);
      $cmd$,
      v_function_url, p_order_id, v_job_name
    )
  );
end;
$$;

grant execute on function public.schedule_reservation_expiry_check(timestamptz, uuid) to service_role;

comment on function public.schedule_reservation_expiry_check(timestamptz, uuid) is
  'Plant einen einmaligen, sich selbst entfernenden pg_cron-Job exakt zum uebergebenen Zeitpunkt, der reconcile-provider-order fuer genau diese Order aufruft (aktive Nachfrage beim Zahlungsanbieter + Timeout-Abwicklung, falls weiterhin unbezahlt). Wird von create-checkout pro Reservierung aufgerufen (Provider-Zahlweg).';
