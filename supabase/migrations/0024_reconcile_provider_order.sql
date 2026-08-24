-- Wama-Pay Schema · Migration 0024
-- Sicherheitsnetz gegen ausbleibende Webhook-Zustellung: mehrere einmalige,
-- selbst-entfernende pg_cron-Jobs pro Reservierung rufen die neue Edge
-- Function reconcile-provider-order auf -- die fragt AKTIV beim
-- Zahlungsanbieter nach, ob die Zahlung inzwischen doch erfolgreich war
-- (falls der Webhook z.B. verloren ging).
--
-- Zwei Arten von Checks (siehe create-checkout/index.ts):
-- - Frühe, NICHT-finale Checks (1/2/3 Minuten nach der Reservierung):
--   erkennen nur eine bereits erfolgreiche Zahlung vorzeitig -- melden
--   "pending" weiterhin, wird NICHTS abgebrochen, die Reservierung bleibt
--   bestehen (der Kunde könnte noch mitten in der Karteneingabe sein).
-- - Ein finaler Check exakt am Ende des 15-Minuten-Reservierungsfensters:
--   meldet der Anbieter dann immer noch nichts Endgültiges, wird die
--   Reservierung abgebrochen und das Gerät wieder freigegeben.
--
-- Anlass: eine echte Testzahlung bei SumUp war erfolgreich, aber
-- payment-webhook wurde nie aufgerufen -- die Order blieb dauerhaft auf
-- 'payment_pending' hängen, ohne dass wir das automatisch bemerkt hätten.
create extension if not exists pg_net with schema extensions;

drop function if exists public.schedule_reservation_expiry_check(timestamptz);
drop function if exists public.schedule_reservation_expiry_check(timestamptz, uuid);

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
    to_char(p_run_at, 'MI HH24 DD MM') || ' *',
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

grant execute on function public.schedule_reservation_expiry_check(timestamptz, uuid, boolean) to service_role;

comment on function public.schedule_reservation_expiry_check(timestamptz, uuid, boolean) is
  'Plant einen einmaligen, sich selbst entfernenden pg_cron-Job exakt zum uebergebenen Zeitpunkt, der reconcile-provider-order fuer genau diese Order aufruft (aktive Nachfrage beim Zahlungsanbieter). p_is_final=false: erkennt nur eine bereits erfolgreiche Zahlung vor, bricht bei "pending" nichts ab. p_is_final=true: bricht bei weiterhin unbestaetigter Zahlung die Reservierung ab (Timeout). Wird von create-checkout mehrfach pro Reservierung aufgerufen (Provider-Zahlweg).';
