-- Wama-Pay Schema · Migration 0003
-- Kundenkonten (Teil d, Kunden-Webapp). customer.id = auth.users.id
-- (Supabase Auth, E-Mail-Anmeldung mit Verifizierung).

create table public.customers (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  full_name     text,
  phone         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- Legt bei Registrierung automatisch einen customers-Datensatz an,
-- verknüpft mit dem neuen auth.users-Eintrag.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.customers (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
