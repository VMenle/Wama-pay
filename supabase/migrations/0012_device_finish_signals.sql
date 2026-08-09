-- Wama-Pay Schema · Migration 0012
-- Unterstützt den n8n-Workflow "order-released-notify-fertig": speichert
-- pro Gerät die n8n-Resume-URL der wartenden Ausführung, damit ein externes
-- "Waschgang fertig"-Signal (z.B. vom Shelly-Skript, siehe
-- shelly/wama-pay-finish-signal.js) diese Ausführung gezielt aufwecken kann,
-- statt nur auf den 2h-Timeout zu warten.
--
-- Bewusst kein Zeitfeld für "Fertig" hier -- das eigentliche "fertig"-Ereignis
-- (Gerät wieder frei, ggf. Benachrichtigung) wird ausschließlich vom
-- n8n-Workflow nach dem Aufwecken verarbeitet, nicht von dieser Tabelle.
--
-- Ausschließlich Service-Role-Zugriff (RLS aktiv, keine Policies für
-- anon/authenticated), analog zu release_events/audit_log in Migration 0009.

create table public.device_finish_signals (
  device_id     uuid primary key references public.devices(id) on delete cascade,
  order_id      uuid not null references public.orders(id) on delete cascade,
  resume_url    text not null,
  created_at    timestamptz not null default now()
);

comment on table public.device_finish_signals is
  'Pro Gerät genau ein Eintrag: die n8n-Resume-URL der aktuell wartenden "order-released"-Ausführung. Wird nach dem Aufwecken (Signal oder 2h-Timeout) vom Workflow selbst wieder gelöscht.';

alter table public.device_finish_signals enable row level security;
-- Bewusst keine Policies für anon/authenticated -> RLS verweigert per Default,
-- Zugriff ausschließlich über die Service-Role (n8n-HTTP-Request-Nodes).
