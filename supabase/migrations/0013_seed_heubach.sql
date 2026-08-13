-- Wama-Pay – Testdaten: Standort Heubach mit einer Waschmaschine.
-- Einmalig im SQL-Editor ausführen (wie bei den vorherigen Migrationen).

with proj as (
  select id as project_id from public.projects where key = 'waschsalon'
),
loc as (
  insert into public.locations (project_id, name)
  select project_id, 'Heubach' from proj
  returning id as location_id, project_id
),
dev as (
  insert into public.devices (project_id, location_id, type, label, qr_code_token, status)
  select project_id, location_id, 'washer', '23001', gen_random_uuid()::text, 'free'
  from loc
  returning id as device_id, project_id, location_id
)
insert into public.products (project_id, device_type, location_id, name, price_cents, currency)
select project_id, 'washer', location_id, 'Waschgang', 89, 'EUR'
from dev;
