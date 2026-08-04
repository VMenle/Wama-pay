-- Wama-Pay Schema · Migration 0007
-- Verschlüsselte Bankdaten (IBAN/BIC) via Supabase Vault / pgsodium.
--
-- Ansatz (mit Auftraggeber bestätigt): Ein dedizierter Verschlüsselungs-
-- Schlüssel wird über pgsodium verwaltet (Supabase Vault-Unterbau). IBAN/BIC
-- werden nie im Klartext gespeichert; Ver-/Entschlüsselung läuft ausschließlich
-- über SECURITY DEFINER-Funktionen, die nur von der Service-Role aufgerufen
-- werden dürfen. Das Frontend liest ausschließlich die maskierte View
-- `customer_bank_details_masked` (nur letzte 4 Ziffern der IBAN sichtbar).

create extension if not exists pgsodium;

-- Ein Schlüssel für alle Bankdaten-Verschlüsselungen dieser Tabelle.
-- Der Schlüssel selbst verlässt pgsodium/Vault nie im Klartext.
select pgsodium.create_key(name := 'wama_pay_bank_details_key')
where not exists (
  select 1 from pgsodium.valid_key where name = 'wama_pay_bank_details_key'
);

create table public.customer_bank_details (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null unique references public.customers(id) on delete cascade,
  account_holder      text not null,
  iban_encrypted      bytea not null,
  iban_country        char(2) not null,  -- unverschlüsselt für UI-Maskierung (z.B. 'DE')
  iban_last4          text not null,     -- unverschlüsselt für UI-Maskierung, kein Rückschluss auf volle IBAN
  bic_encrypted       bytea,
  key_id              uuid not null,     -- pgsodium key id, mit dem verschlüsselt wurde
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger customer_bank_details_set_updated_at
  before update on public.customer_bank_details
  for each row execute function public.set_updated_at();

-- Schreibfunktion: verschlüsselt IBAN/BIC serverseitig, nimmt Klartext nur
-- als Parameter entgegen (Client sendet Klartext einmalig über TLS an eine
-- Edge Function / RPC, niemals als direktes Tabellen-Insert).
-- SECURITY DEFINER umgeht RLS auf der Tabelle, daher wird die Berechtigung
-- hier explizit geprüft: ein eingeloggter Kunde darf ausschließlich seine
-- eigenen Bankdaten schreiben (p_customer_id muss auth.uid() entsprechen).
create or replace function public.upsert_customer_bank_details(
  p_customer_id uuid,
  p_account_holder text,
  p_iban text,
  p_bic text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_key_id uuid;
  v_iban_clean text;
  v_country char(2);
  v_last4 text;
begin
  if auth.uid() is null or auth.uid() <> p_customer_id then
    raise exception 'not authorized to modify bank details for this customer';
  end if;

  select id into v_key_id from pgsodium.valid_key where name = 'wama_pay_bank_details_key';
  v_iban_clean := upper(regexp_replace(p_iban, '\s', '', 'g'));
  v_country := left(v_iban_clean, 2);
  v_last4 := right(v_iban_clean, 4);

  insert into public.customer_bank_details (
    customer_id, account_holder, iban_encrypted, iban_country, iban_last4, bic_encrypted, key_id
  )
  values (
    p_customer_id,
    p_account_holder,
    pgsodium.crypto_aead_det_encrypt(convert_to(v_iban_clean, 'utf8'), convert_to(p_customer_id::text, 'utf8'), v_key_id),
    v_country,
    v_last4,
    case when p_bic is not null
      then pgsodium.crypto_aead_det_encrypt(convert_to(p_bic, 'utf8'), convert_to(p_customer_id::text, 'utf8'), v_key_id)
      else null end,
    v_key_id
  )
  on conflict (customer_id) do update set
    account_holder = excluded.account_holder,
    iban_encrypted = excluded.iban_encrypted,
    iban_country = excluded.iban_country,
    iban_last4 = excluded.iban_last4,
    bic_encrypted = excluded.bic_encrypted,
    key_id = excluded.key_id,
    updated_at = now();
end;
$$;

-- Lesefunktion für vollen Klartext: NUR für Service-Role-Kontexte gedacht
-- (z.B. SumUp SEPA-Anbindung), niemals für Client-Aufrufe freigeben.
create or replace function public.decrypt_customer_bank_details(p_customer_id uuid)
returns table (account_holder text, iban text, bic text)
language plpgsql
security definer set search_path = public
as $$
begin
  return query
  select
    b.account_holder,
    convert_from(pgsodium.crypto_aead_det_decrypt(b.iban_encrypted, convert_to(b.customer_id::text, 'utf8'), b.key_id), 'utf8'),
    case when b.bic_encrypted is not null
      then convert_from(pgsodium.crypto_aead_det_decrypt(b.bic_encrypted, convert_to(b.customer_id::text, 'utf8'), b.key_id), 'utf8')
      else null end
  from public.customer_bank_details b
  where b.customer_id = p_customer_id;
end;
$$;

-- Maskierte View für das Frontend (Kunden-Webapp zeigt nur letzte 4 Stellen).
-- security_invoker: die View läuft mit den Rechten des abfragenden Clients
-- (nicht des View-Eigentümers), zusätzlich als zweite Sicherheitsebene direkt
-- auf auth.uid() gefiltert, damit ein Kunde nie fremde Datensätze sieht,
-- selbst falls RLS auf der Basistabelle künftig verändert werden sollte.
create view public.customer_bank_details_masked
with (security_invoker = true)
as
select
  id,
  customer_id,
  account_holder,
  (iban_country || '** **** **** **** **' || iban_last4) as iban_masked,
  created_at,
  updated_at
from public.customer_bank_details
where customer_id = auth.uid();

-- Berechtigungen: Tabelle bleibt für anon/authenticated ohne jede Policy
-- (siehe Migration 0009) gesperrt; nur die Funktionen und die maskierte
-- View sind der kontrollierte Zugriffsweg.
revoke all on public.customer_bank_details from anon, authenticated;
revoke execute on function public.decrypt_customer_bank_details(uuid) from public, anon, authenticated;
grant execute on function public.upsert_customer_bank_details(uuid, text, text, text) to authenticated;
grant select on public.customer_bank_details_masked to authenticated;
