-- Wama-Pay Schema · Migration 0008
-- Benachrichtigungsverwaltung "Maschine fertig" (Teil c/d): der Kunde
-- steuert in der Kunden-Webapp, ob und wie er benachrichtigt werden möchte.
-- n8n-Workflow "Maschine fertig" liest diese Einstellung, bevor er eine
-- Benachrichtigung auslöst.

create table public.customer_notification_settings (
  customer_id           uuid primary key references public.customers(id) on delete cascade,
  notify_on_release     boolean not null default true,
  channel               text not null default 'email' check (channel in ('email')), -- TODO: weitere Kanäle (push/sms) bei Bedarf ergänzen
  updated_at            timestamptz not null default now()
);

create trigger customer_notification_settings_set_updated_at
  before update on public.customer_notification_settings
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user_notification_defaults()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.customer_notification_settings (customer_id)
  values (new.id);
  return new;
end;
$$;

create trigger on_customer_created_notification_defaults
  after insert on public.customers
  for each row execute function public.handle_new_user_notification_defaults();
