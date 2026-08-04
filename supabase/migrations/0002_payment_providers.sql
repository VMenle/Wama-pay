-- Wama-Pay Schema · Migration 0002
-- Payment-Provider-Abstraktion: SumUp ist aktuell der einzige, aber
-- austauschbare Provider. Siehe docs/payment-provider-adapter.md für das
-- vollständige Adapter-Pattern (bestätigt mit Auftraggeber vor Umsetzung).

create table public.payment_providers (
  id            text primary key,            -- z.B. 'sumup'
  display_name  text not null,
  is_active     boolean not null default true,
  -- Ausschließlich NICHT-geheime Konfiguration (z.B. Anzeige-Metadaten).
  -- API-Keys/Secrets werden NIE hier gespeichert, sondern ausschließlich
  -- als Supabase Edge Function Secrets / Umgebungsvariablen gehalten.
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

comment on table public.payment_providers is
  'Konfigurierte Zahlungs-Provider. Ein neuer Provider = neue Zeile + neues Adapter-Modul in der Edge Function, ohne Schema-Änderung an orders/release_events.';

comment on column public.payment_providers.config is
  'Nicht-geheime Provider-Konfiguration (Anzeigename, Icon, o.ä.). Secrets ausschließlich über Edge Function Secrets/Env-Vars.';

insert into public.payment_providers (id, display_name, is_active)
values ('sumup', 'SumUp', true);
