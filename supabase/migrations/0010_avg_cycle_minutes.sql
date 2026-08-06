-- Wama-Pay Schema · Migration 0010
-- Geschätzte Programmdauer je Produkt (device_type + Standort). Wird
-- ausschließlich für den n8n-Workflow "Maschine fertig" benötigt, um zu
-- wissen, wie lange nach der Freigabe gewartet werden soll, bevor die
-- Benachrichtigung verschickt wird. Hat keinerlei Einfluss auf Preis oder
-- Freigabelogik (weiterhin pro Nutzung, nicht zeitbasiert, siehe
-- products.price_cents).

alter table public.products
  add column avg_cycle_minutes integer not null default 60
  check (avg_cycle_minutes > 0);

comment on column public.products.avg_cycle_minutes is
  'Geschätzte Dauer eines Waschgangs/Trocknergangs in Minuten. Nur für die "Maschine fertig"-Benachrichtigung (n8n), nicht für Abrechnung oder Freigabelogik relevant.';
