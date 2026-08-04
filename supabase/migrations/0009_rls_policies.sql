-- Wama-Pay Schema · Migration 0009
-- Row Level Security für alle Tabellen. Grundprinzip:
-- - RLS ist auf JEDER Tabelle aktiv (default-deny).
-- - anon/authenticated bekommen nur die minimal nötigen SELECT-Policies für
--   den öffentlichen Checkout-Flow (Geräte-/Preisübersicht) bzw. eigene Daten.
-- - Alle schreibenden, kritischen Operationen (Order-Erstellung, Statuswechsel,
--   Freigabe, Wallet-Buchungen) laufen ausschließlich über die Service-Role
--   (Edge Functions) oder die oben definierten SECURITY DEFINER-Funktionen.
--   Die Service-Role umgeht RLS grundsätzlich (Supabase-Standardverhalten),
--   braucht also keine expliziten Policies.

-- ---------------------------------------------------------------------------
-- projects / locations / devices / products / payment_providers
-- Öffentlich lesbar (nötig für anonymen QR-Checkout ohne Login), keine
-- Schreibrechte für Clients.
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
create policy projects_select_active on public.projects
  for select to anon, authenticated
  using (is_active = true);

alter table public.locations enable row level security;
create policy locations_select_all on public.locations
  for select to anon, authenticated
  using (true);

alter table public.devices enable row level security;
create policy devices_select_all on public.devices
  for select to anon, authenticated
  using (true);

alter table public.products enable row level security;
create policy products_select_active on public.products
  for select to anon, authenticated
  using (is_active = true);

alter table public.payment_providers enable row level security;
create policy payment_providers_select_active on public.payment_providers
  for select to anon, authenticated
  using (is_active = true);

-- ---------------------------------------------------------------------------
-- orders: kein direkter Client-Zugriff (weder Insert noch Select).
-- Reservierung/Erstellung läuft über eine Edge Function (Service-Role), die
-- Preis, Verfügbarkeit und Lock serverseitig prüft. Status-Polling während
-- des Checkouts läuft über die Funktion get_order_status() unten, die
-- gezielt nur die für die UI nötigen, unkritischen Felder zurückgibt.
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;

create policy orders_select_own_authenticated on public.orders
  for select to authenticated
  using (customer_id = auth.uid());

create or replace function public.get_order_status(p_order_id uuid)
returns table (status public.order_status, device_id uuid, released_at timestamptz)
language sql
security definer set search_path = public
stable
as $$
  select status, device_id, released_at
  from public.orders
  where id = p_order_id;
$$;

grant execute on function public.get_order_status(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- release_events / audit_log: keinerlei Client-Zugriff.
-- ---------------------------------------------------------------------------
alter table public.release_events enable row level security;
alter table public.audit_log enable row level security;
-- Bewusst keine Policies für anon/authenticated -> RLS verweigert per Default.

-- ---------------------------------------------------------------------------
-- customers: Kunde sieht/ändert ausschließlich den eigenen Datensatz.
-- Insert erfolgt nur über den on_auth_user_created-Trigger (SECURITY DEFINER).
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;

create policy customers_select_own on public.customers
  for select to authenticated
  using (id = auth.uid());

create policy customers_update_own on public.customers
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- wallet_balances / wallet_transactions: nur eigene Daten lesen, keine
-- Client-Schreibrechte (Buchungen ausschließlich über Service-Role nach
-- verifizierter Zahlung, siehe apply_wallet_transaction()-Trigger).
-- ---------------------------------------------------------------------------
alter table public.wallet_balances enable row level security;
create policy wallet_balances_select_own on public.wallet_balances
  for select to authenticated
  using (customer_id = auth.uid());

alter table public.wallet_transactions enable row level security;
create policy wallet_transactions_select_own on public.wallet_transactions
  for select to authenticated
  using (customer_id = auth.uid());

-- ---------------------------------------------------------------------------
-- customer_bank_details: RLS aktiv, aber bewusst OHNE Policies für
-- anon/authenticated (siehe Migration 0007 -- Zugriff ausschließlich über
-- upsert_customer_bank_details()/customer_bank_details_masked).
-- ---------------------------------------------------------------------------
alter table public.customer_bank_details enable row level security;

-- ---------------------------------------------------------------------------
-- customer_notification_settings: Kunde verwaltet nur seine eigene
-- Einstellung.
-- ---------------------------------------------------------------------------
alter table public.customer_notification_settings enable row level security;

create policy notification_settings_select_own on public.customer_notification_settings
  for select to authenticated
  using (customer_id = auth.uid());

create policy notification_settings_update_own on public.customer_notification_settings
  for update to authenticated
  using (customer_id = auth.uid())
  with check (customer_id = auth.uid());
