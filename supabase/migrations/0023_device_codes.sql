-- Wama-Pay Schema · Migration 0023
-- Menschenlesbarer, strukturierter Gerätecode zusätzlich zur internen UUID
-- (devices.id bleibt der eigentliche Primärschlüssel, ändert sich nicht).
-- Grund: die UUID ist unpraktisch für ein manuell bei PayPal einzutragendes
-- verstecktes Feld -- ein kurzer Code wie "AA111" lässt sich leicht ablesen
-- und abtippen.
--
-- Format: <Standort-Kürzel><Gerätenummer>, z.B. "AA111".
-- - Standort-Kürzel: 2 Großbuchstaben, automatisch fortlaufend vergeben
--   (erster angelegter Standort = AA, zweiter = AB, ...).
-- - Gerätenummer: 3-stellig, je Standort fortlaufend, beginnend bei 111.
--
-- Bewusst KEIN sicherheitskritischer Code (anders als devices.override_token
-- für die Notfreigabe) -- Erraten des Codes ermöglicht bestenfalls eine
-- ECHTE Zahlung für ein falsches/fremdes Gerät, kein kostenloses
-- Freischalten. Deshalb reicht ein einfaches, vorhersehbares Schema.

alter table public.locations add column short_code text unique;
alter table public.devices add column device_code text unique;

create sequence public.location_short_code_seq minvalue 0 start with 0;

create or replace function public.assign_location_short_code()
returns trigger
language plpgsql
as $$
declare
  v_n integer;
begin
  if new.short_code is null then
    v_n := nextval('public.location_short_code_seq');
    -- 0->AA, 1->AB, ..., 25->AZ, 26->BA, ... (wie Tabellenspalten-Namen).
    new.short_code := chr(65 + (v_n / 26)) || chr(65 + (v_n % 26));
  end if;
  return new;
end;
$$;

create trigger locations_assign_short_code
before insert on public.locations
for each row execute function public.assign_location_short_code();

create or replace function public.assign_device_code()
returns trigger
language plpgsql
as $$
declare
  v_location_short_code text;
  v_next_seq integer;
begin
  if new.device_code is null then
    select short_code into v_location_short_code
    from public.locations where id = new.location_id;

    if v_location_short_code is null then
      raise exception 'Standort % hat kein short_code -- device_code kann nicht automatisch vergeben werden.', new.location_id;
    end if;

    -- Höchste bisherige Gerätenummer an diesem Standort +1, Start bei 111.
    -- Kein Lock gegen gleichzeitige Inserts -- bei einer Admin-Oberfläche
    -- mit sehr geringer Nebenläufigkeit vernachlässigbares Risiko, und der
    -- unique-Constraint auf device_code würde einen echten Konflikt ohnehin
    -- hart abfangen statt ihn still durchzulassen.
    select coalesce(max(substring(device_code from '[0-9]+$')::integer), 110) + 1
      into v_next_seq
      from public.devices
      where location_id = new.location_id;

    new.device_code := v_location_short_code || v_next_seq::text;
  end if;
  return new;
end;
$$;

create trigger devices_assign_device_code
before insert on public.devices
for each row execute function public.assign_device_code();

-- Bestehende Standorte/Geräte (bereits vor dieser Migration angelegt)
-- nachträglich mit Codes versehen, in Anlage-Reihenfolge -- per UPDATE statt
-- INSERT, deshalb greifen die obigen Trigger hier nicht automatisch.
do $$
declare
  v_loc_id uuid;
  v_dev_id uuid;
  v_n integer;
  v_code text;
begin
  for v_loc_id in select id from public.locations where short_code is null order by created_at loop
    v_n := nextval('public.location_short_code_seq');
    v_code := chr(65 + (v_n / 26)) || chr(65 + (v_n % 26));
    update public.locations set short_code = v_code where id = v_loc_id;
  end loop;

  for v_dev_id in select id from public.devices where device_code is null order by created_at loop
    update public.devices d
    set device_code = (select short_code from public.locations where id = d.location_id)
                       || (
                         select coalesce(max(substring(device_code from '[0-9]+$')::integer), 110) + 1
                         from public.devices where location_id = d.location_id
                       )
    where d.id = v_dev_id;
  end loop;
end;
$$;

alter table public.locations alter column short_code set not null;
alter table public.devices alter column device_code set not null;
