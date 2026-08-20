-- Wama-Pay Schema · Migration 0019
-- Notfreigabe (Task 11), Fortsetzung von Migration 0018.
--
-- Muss NACH 0018 in einer eigenen Transaktion laufen, weil hier der in
-- 0018 neu hinzugefügte Enum-Wert 'override' tatsächlich verwendet wird
-- (im CHECK-Constraint unten) -- das geht in Postgres nicht in derselben
-- Transaktion, in der der Enum-Wert hinzugefügt wurde.

-- ---------------------------------------------------------------------------
-- orders_provider_fields_check um 'override' erweitern.
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint orders_provider_fields_check;
alter table public.orders add constraint orders_provider_fields_check check (
  (payment_method = 'provider' and provider_id is not null)
  or (payment_method = 'wallet' and provider_id is null)
  or (payment_method = 'override' and provider_id is null)
);

-- ---------------------------------------------------------------------------
-- Gerätespezifischer Override-Token (Faktor 1). Getrennt von qr_code_token
-- (das ist für den normalen Bezahl-QR-Code, öffentlich am Gerät sichtbar).
-- ---------------------------------------------------------------------------
alter table public.devices add column override_token text unique;

comment on column public.devices.override_token is
  'Geheimer Token fuer die Notfreigabe-Seite (override.html), Faktor 1 von 2. NICHT fuer Kunden sichtbar anbringen. Vom Admin-Dashboard aus generierbar/erneuerbar.';

-- ---------------------------------------------------------------------------
-- Projektweiter PIN (Faktor 2), gehasht gespeichert, mit einfachem
-- Brute-Force-Schutz (Sperre nach 5 Fehlversuchen für 15 Minuten).
-- ---------------------------------------------------------------------------
create table public.admin_settings (
  project_id          uuid primary key references public.projects(id) on delete cascade,
  override_pin_hash   text,
  failed_attempts     integer not null default 0,
  locked_until        timestamptz,
  updated_at          timestamptz not null default now()
);

alter table public.admin_settings enable row level security;
-- Bewusst keine Policies für anon/authenticated -> nur über die
-- SECURITY DEFINER-Funktionen unten bzw. die Service-Role erreichbar.

-- Setzt/ändert den PIN. Nur für eingeloggte Admins (is_admin()-Prüfung
-- innerhalb der Funktion, analog zu upsert_customer_bank_details).
create or replace function public.set_override_pin(p_project_id uuid, p_pin text)
returns void
language plpgsql
security definer set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Nicht berechtigt.';
  end if;
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN muss aus 4 bis 8 Ziffern bestehen.';
  end if;

  insert into public.admin_settings (project_id, override_pin_hash, failed_attempts, locked_until)
  values (p_project_id, crypt(p_pin, gen_salt('bf')), 0, null)
  on conflict (project_id) do update set
    override_pin_hash = excluded.override_pin_hash,
    failed_attempts = 0,
    locked_until = null,
    updated_at = now();
end;
$$;

grant execute on function public.set_override_pin(uuid, text) to authenticated;

-- Prüft den PIN mit Sperrlogik. Ausschließlich für die Service-Role gedacht
-- (wird von der Edge Function device-override aufgerufen, niemals direkt
-- vom Client) -- der Hausmeister ist nicht eingeloggt, daher kein
-- is_admin()-Bezug hier.
create or replace function public.verify_override_pin(p_project_id uuid, p_pin text)
returns boolean
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_hash          text;
  v_locked_until  timestamptz;
  v_failed        integer;
  v_ok            boolean;
begin
  select override_pin_hash, locked_until, failed_attempts
    into v_hash, v_locked_until, v_failed
  from public.admin_settings
  where project_id = p_project_id
  for update;

  if v_hash is null then
    return false; -- kein PIN gesetzt -> Notfreigabe grundsätzlich gesperrt
  end if;

  if v_locked_until is not null and v_locked_until > now() then
    return false;
  end if;

  v_ok := (crypt(p_pin, v_hash) = v_hash);

  if v_ok then
    update public.admin_settings
    set failed_attempts = 0, locked_until = null, updated_at = now()
    where project_id = p_project_id;
  else
    update public.admin_settings
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
        updated_at = now()
    where project_id = p_project_id;
  end if;

  return v_ok;
end;
$$;

revoke all on function public.verify_override_pin(uuid, text) from public, anon, authenticated;

comment on function public.verify_override_pin(uuid, text) is
  'Nur von der Service-Role aufrufbar (Edge Function device-override). Prueft PIN gegen den Hash, mit Sperre nach 5 Fehlversuchen fuer 15 Minuten.';

-- ---------------------------------------------------------------------------
-- Admins brauchen Einsicht ins Notfreigabe-Protokoll (orders mit
-- payment_method='override'), aber orders hatte bisher nur eine
-- Select-Policy für den jeweiligen eingeloggten Kunden selbst (Migration
-- 0009) -- Notfreigaben haben customer_id = null, wären also unsichtbar.
-- ---------------------------------------------------------------------------
create policy orders_admin_select on public.orders
  for select to authenticated
  using (public.is_admin());
