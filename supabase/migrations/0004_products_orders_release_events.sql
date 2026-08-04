-- Wama-Pay Schema · Migration 0003
-- Produkte (Preis pro Waschgang, NICHT zeitbasiert), Orders, Freigabe-Events.

create table public.products (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete restrict,
  device_type   public.device_type not null,   -- Preis gilt je Gerätetyp (z.B. alle Waschmaschinen an einem Standort)
  location_id   uuid references public.locations(id) on delete restrict,
  name          text not null,                 -- z.B. "Waschgang", "Trocknergang"
  price_cents   integer not null check (price_cents > 0),
  currency      text not null default 'EUR',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index products_project_id_idx on public.products(project_id);
create index products_location_id_idx on public.products(location_id);

comment on table public.products is
  'Preis pro Nutzung (ein Waschgang = ein Preis), nicht zeitbasiert.';

create type public.order_status as enum (
  'reserved',        -- Reservierungs-Lock gesetzt, Zahlung noch nicht gestartet/bestätigt
  'payment_pending',  -- Zahlung beim Provider gestartet, Bestätigung ausstehend
  'paid',             -- Zahlung serverseitig verifiziert
  'released',         -- Gerät wurde freigegeben
  'failed',           -- Zahlung fehlgeschlagen
  'expired',          -- Zeitfenster überschritten, keine Zahlungsbestätigung erhalten
  'refund_pending',   -- Rückerstattung ausgelöst (z.B. nach Timeout mit bereits erfolgter Zahlung)
  'refunded'
);

create type public.payment_method as enum ('provider', 'wallet');

create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects(id) on delete restrict,
  device_id           uuid not null references public.devices(id) on delete restrict,
  product_id          uuid not null references public.products(id) on delete restrict,
  customer_id         uuid references public.customers(id) on delete set null, -- null = anonymer Checkout ohne Login
  payment_method      public.payment_method not null,
  provider_id         text references public.payment_providers(id),           -- nur bei payment_method = 'provider'
  provider_ref         text,                                                   -- externe Checkout-/Transaktions-ID des Providers
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null default 'EUR',
  status               public.order_status not null default 'reserved',
  reserved_at          timestamptz not null default now(),
  reservation_expires_at timestamptz not null,   -- Timeout-Schutz: keine Rückmeldung -> Rückerstattung statt stillem Fehler
  paid_at              timestamptz,
  released_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint orders_provider_fields_check check (
    (payment_method = 'provider' and provider_id is not null)
    or (payment_method = 'wallet' and provider_id is null)
  )
);

-- Idempotenz: pro Provider darf eine externe Transaktions-Referenz nur einmal
-- einer Order zugeordnet sein. Der Webhook-Handler prüft zusätzlich per
-- order_id (Primärschlüssel), dass eine Order nur EINMAL den Übergang
-- nach 'paid' durchläuft (siehe Edge Function payment-webhook).
create unique index orders_provider_ref_unique_idx
  on public.orders(provider_id, provider_ref)
  where provider_ref is not null;

create index orders_project_id_idx on public.orders(project_id);
create index orders_device_id_idx on public.orders(device_id);
create index orders_customer_id_idx on public.orders(customer_id);
create index orders_status_idx on public.orders(status);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

alter table public.devices
  add constraint devices_current_order_id_fkey
  foreign key (current_order_id) references public.orders(id) on delete set null;

create table public.release_events (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete restrict,
  device_id       uuid not null references public.devices(id) on delete restrict,
  triggered_by    text not null default 'payment_webhook', -- 'payment_webhook' | 'admin_override'
  success         boolean not null,
  error_detail    text,
  created_at      timestamptz not null default now()
);

create index release_events_order_id_idx on public.release_events(order_id);
create index release_events_device_id_idx on public.release_events(device_id);
