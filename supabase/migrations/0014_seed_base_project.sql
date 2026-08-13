-- Wama-Pay Schema · Migration 0014
-- Korrektur: der Basis-Projekteintrag "waschsalon" wurde in Migration 0001
-- nie tatsächlich eingefügt (nur die Tabelle erzeugt). Alle Client-Anfragen
-- (Checkout-Webapp/Kunden-Webapp) filtern aber nach
-- projects.key = 'waschsalon' (siehe assets/config.js, projectKey), liefen
-- also ins Leere. idempotent, kann gefahrlos mehrfach ausgeführt werden.

insert into public.projects (key, name)
values ('waschsalon', 'Waschsalon')
on conflict (key) do nothing;
