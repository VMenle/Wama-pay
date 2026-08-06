-- Wama-Pay Schema · Migration 0011
-- RPC für den n8n-Workflow "Reservation-Timeout-Wächter" (Teil c): läuft auf
-- einem Cron-Trigger und räumt Reservierungen auf, für die keine
-- Zahlungsbestätigung eintraf (siehe orders.reservation_expires_at). Setzt
-- die Order auf 'expired' und gibt das Gerät wieder frei ('free'), damit es
-- nicht dauerhaft als 'busy' hängen bleibt, nur weil ein Checkout abgebrochen
-- wurde. Betrifft ausschließlich noch unbezahlte Orders ('reserved',
-- 'payment_pending') -- eine bereits verifizierte Zahlung nach Ablauf des
-- Zeitfensters läuft über den separaten Refund-Pfad (orders.status
-- 'refund_pending'/'refunded'), den Migration 0004 dafür vorsieht.
--
-- SECURITY DEFINER, da devices/orders keine Client-Schreibrechte haben
-- (siehe Migration 0009); Aufruf ist ausschließlich für die Service-Role
-- vorgesehen (n8n ruft dies über die Service-Role, nicht über anon/authenticated
-- Client-Keys, auf).

create or replace function public.expire_stale_reservations()
returns table (expired_order_id uuid, device_id uuid)
language plpgsql
security definer set search_path = public
as $$
begin
  -- Mehrere datenverändernde CTEs werden hintereinandergehängt (orders ->
  -- devices -> audit_log). Damit Postgres jede davon tatsächlich ausführt,
  -- muss die abschließende SELECT-Klausel alle referenzieren -- eine nicht
  -- im finalen FROM/JOIN erwähnte datenverändernde CTE würde sonst
  -- stillschweigend übersprungen.
  return query
  with stale as (
    select o.id as order_id, o.device_id as device_id, o.project_id as project_id
    from public.orders o
    where o.status in ('reserved', 'payment_pending')
      and o.reservation_expires_at < now()
    for update of o skip locked
  ),
  updated_orders as (
    update public.orders o
    set status = 'expired'
    from stale s
    where o.id = s.order_id
    returning o.id as order_id, o.device_id as device_id, o.project_id as project_id
  ),
  updated_devices as (
    update public.devices d
    set status = 'free', current_order_id = null
    from updated_orders uo
    where d.id = uo.device_id
      and d.current_order_id = uo.order_id
    returning d.id
  ),
  logged as (
    insert into public.audit_log (project_id, actor_type, action, entity_table, entity_id, metadata)
    select uo.project_id, 'system', 'order.expired', 'orders', uo.order_id,
           jsonb_build_object('reason', 'reservation_timeout', 'device_id', uo.device_id)
    from updated_orders uo
    returning entity_id
  )
  select uo.order_id, uo.device_id
  from updated_orders uo
  left join updated_devices ud on ud.id = uo.device_id
  left join logged lg on lg.entity_id = uo.order_id;
end;
$$;

comment on function public.expire_stale_reservations() is
  'Wird vom n8n-Cron-Workflow "Reservation-Timeout-Waechter" aufgerufen (Service-Role). Setzt abgelaufene, unbezahlte Reservierungen auf expired und gibt das Geraet frei.';

revoke all on function public.expire_stale_reservations() from public, anon, authenticated;
