-- Wama-Pay Schema · Migration 0001
-- Multi-Tenant-Grundgerüst: projects, locations, devices
-- Jedes weitere Projekt (Anhängerverleih, Kartenspender, ...) wird als
-- zusätzliche Zeile in `projects` ergänzt, ohne Schema-Änderung.

create extension if not exists "pgcrypto";

create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,        -- z.B. 'waschsalon', 'anhaengerverleih', 'kartenspender'
  name          text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table public.projects is
  'Mandanten-/Projekt-Ebene. Referenzprojekt: waschsalon. Alle projektgebundenen Tabellen referenzieren project_id.';

create table public.locations (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete restrict,
  name          text not null,               -- z.B. "Waschküche Musterstraße 12"
  address       text,
  timezone      text not null default 'Europe/Berlin',
  created_at    timestamptz not null default now()
);

create index locations_project_id_idx on public.locations(project_id);

create type public.device_type as enum ('washer', 'dryer', 'trailer', 'card_dispenser');
create type public.device_status as enum ('free', 'busy', 'offline', 'maintenance');

create table public.devices (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete restrict,
  location_id       uuid not null references public.locations(id) on delete restrict,
  type              public.device_type not null,
  label             text not null,           -- z.B. "Waschmaschine 2"
  qr_code_token     text not null unique,     -- eindeutiges Token im QR-Code, kein Rückschluss auf id nötig
  status            public.device_status not null default 'free',
  current_order_id  uuid,                     -- FK wird in Migration 0003 ergänzt (orders existiert erst danach)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index devices_project_id_idx on public.devices(project_id);
create index devices_location_id_idx on public.devices(location_id);
create index devices_status_idx on public.devices(status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger devices_set_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();
