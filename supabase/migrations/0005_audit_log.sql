-- Wama-Pay Schema · Migration 0005
-- Audit-Log für sicherheitsrelevante Vorgänge (Zahlungsstatusübergänge,
-- Freigaben, manuelle Eingriffe). Schreibzugriff ausschließlich über
-- Service-Role (siehe RLS-Migration).

create table public.audit_log (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.projects(id) on delete set null,
  actor_type    text not null,      -- 'system' | 'service_role' | 'customer' | 'admin'
  actor_id      uuid,               -- z.B. customer_id oder admin user id, sonst null
  action        text not null,      -- z.B. 'order.paid', 'device.released', 'refund.initiated'
  entity_table  text,
  entity_id     uuid,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_project_id_idx on public.audit_log(project_id);
create index audit_log_entity_idx on public.audit_log(entity_table, entity_id);
create index audit_log_created_at_idx on public.audit_log(created_at);
