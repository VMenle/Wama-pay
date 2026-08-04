-- Wama-Pay Schema · Migration 0006
-- Kunden-Guthabenkonto ("Wallet") in Anzahl Waschgänge, NICHT in Euro.
--
-- ⚠ RECHTLICHER HINWEIS (nicht rechtlich verifiziert, siehe Auftragskontext):
-- Das Wallet-Modell wird aktuell als Eigenbetrieb OHNE externen E-Geld-Partner
-- umgesetzt, in der (bislang nicht verifizierten) Arbeitsannahme, dass die
-- ZAG-Ausnahme "begrenztes Netzwerk" (§ 2 Abs. 1 Nr. 10 ZAG) greift.
-- Diese Einschätzung stammt vom Auftraggeber und wurde von Claude Code NICHT
-- rechtlich bewertet oder geprüft. Jede technische Entscheidung, die von
-- dieser Annahme abhängt, referenziert diesen Hinweis (siehe unten:
-- projektgebundenes statt projektübergreifendes Wallet).
--
-- Konkrete Konsequenz für dieses Schema: wallet_balances ist bewusst pro
-- (customer_id, project_id) statt global pro Kunde geführt, um im Sinne der
-- "begrenztes Netzwerk"-Annahme kein projektübergreifend nutzbares
-- Zahlungsmittel zu schaffen. Sollte sich die rechtliche Einschätzung ändern,
-- muss diese Entscheidung neu bewertet werden.

create table public.wallet_balances (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete restrict,
  balance_washes    integer not null default 0 check (balance_washes >= 0),
  updated_at        timestamptz not null default now(),
  unique (customer_id, project_id)
);

create index wallet_balances_customer_id_idx on public.wallet_balances(customer_id);

create type public.wallet_transaction_type as enum (
  'topup',        -- Aufladung durch Kunde
  'consumption',  -- Verbrauch (Bezahlung eines Waschgangs vom Guthaben)
  'bonus',        -- Gutschrift durch Betreiber (z.B. Aktion)
  'refund'        -- Rückerstattung auf das Guthaben (z.B. bei Freigabe-Fehler)
);

create table public.wallet_transactions (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete restrict,
  type              public.wallet_transaction_type not null,
  -- Vorzeichenbehaftet: positiv bei topup/bonus/refund, negativ bei consumption.
  amount_washes     integer not null check (amount_washes <> 0),
  related_order_id  uuid references public.orders(id) on delete set null,
  note              text,
  created_at        timestamptz not null default now()
);

create index wallet_transactions_customer_id_idx on public.wallet_transactions(customer_id);
create index wallet_transactions_project_id_idx on public.wallet_transactions(project_id);
create index wallet_transactions_related_order_idx on public.wallet_transactions(related_order_id);

-- Guthabenstand wird ausschließlich über wallet_transactions fortgeschrieben
-- (kein direktes Schreiben auf wallet_balances.balance_washes durch Clients,
-- siehe RLS-Migration). Das hält Kontostand und Transaktionsverlauf immer
-- konsistent und macht consumption-Aufrufe atomar inkl. Unterdeckungsschutz.
create or replace function public.apply_wallet_transaction()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.wallet_balances (customer_id, project_id, balance_washes)
  values (new.customer_id, new.project_id, new.amount_washes)
  on conflict (customer_id, project_id)
  do update set
    balance_washes = public.wallet_balances.balance_washes + excluded.balance_washes,
    updated_at = now();
  return new;
end;
$$;

create trigger wallet_transactions_apply
  after insert on public.wallet_transactions
  for each row execute function public.apply_wallet_transaction();
