-- Wama-Pay Schema · Migration 0017
-- Admin-Rolle + Admin-Weboberfläche (webapp-admin/): Standorte, Geräte und
-- Preise verwalten. Zusätzlich der Platzhalter-Mechanismus für die
-- physische Geräte-Freigabe (siehe orderLifecycle.ts::releaseOrder):
-- pro Gerät ein frei konfigurierbarer "Einschalt-Webhook" statt einer fest
-- einprogrammierten Shelly-/Hardware-Anbindung -- kann später durch eine
-- echte Aktor-Integration ersetzt werden, ohne Schema-Änderung.

-- ---------------------------------------------------------------------------
-- admin_users: schlichte Allowlist. Mitgliedschaft wird ausschließlich per
-- SQL (Service-Role/Dashboard) gepflegt, keine Selbstregistrierung möglich.
-- ---------------------------------------------------------------------------
create table public.admin_users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  note        text, -- z.B. Name/Rolle, rein informativ
  created_at  timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create policy admin_users_select_self on public.admin_users
  for select to authenticated
  using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

grant execute on function public.is_admin() to authenticated;

comment on function public.is_admin() is
  'True, wenn der eingeloggte Nutzer in admin_users steht. Genutzt von den *_admin_all-RLS-Policies unten und von der Admin-Webapp selbst zur Zugriffsprüfung.';

-- ---------------------------------------------------------------------------
-- Schreibrechte für Admins auf den Stammdaten-Tabellen. Additiv zu den
-- bestehenden Select-Policies aus Migration 0009 (mehrere permissive
-- Policies werden von Postgres per OR verknüpft).
-- ---------------------------------------------------------------------------
create policy locations_admin_all on public.locations
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy devices_admin_all on public.devices
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy products_admin_all on public.products
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Platzhalter-Mechanismus für die physische Geräte-Freigabe: ein pro Gerät
-- hinterlegter Webhook/Weblink, der beim Freigeben (releaseOrder) mit
-- { device_id, action: "on" } per POST aufgerufen wird. Fehlt er, bleibt
-- die Freigabe -- wie bisher -- rein digital (nur Datenbank-Status), mit
-- einer Warnung im Log. switch_webhook_secret wird als Header mitgeschickt,
-- damit der Empfänger (n8n, ein kleiner Vermittlungsdienst, o.ä.) den
-- Aufruf verifizieren kann.
-- ---------------------------------------------------------------------------
alter table public.devices
  add column switch_webhook_url text,
  add column switch_webhook_secret text;

comment on column public.devices.switch_webhook_url is
  'Platzhalter-Mechanismus fuer die physische Freigabe: wird bei Order-Freigabe per POST mit {device_id, action:"on"} aufgerufen. NULL = keine physische Ansteuerung (nur digitaler Status). Ueber die Admin-Webapp gepflegt.';
comment on column public.devices.switch_webhook_secret is
  'Wird als Header X-Wama-Pay-Switch-Secret beim Aufruf von switch_webhook_url mitgeschickt, damit der Empfaenger den Aufruf verifizieren kann.';
