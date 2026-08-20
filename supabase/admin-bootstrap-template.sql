-- Wama-Pay – ersten Admin-Zugang freischalten.
--
-- Reihenfolge:
-- 1. Migration 0017_admin.sql muss bereits eingespielt sein.
-- 2. Auf webapp-admin/index.html einmal auf "Anmelden" klicken -- das
--    Formular selbst kann noch kein Konto anlegen, aber Sie brauchen
--    zuerst ein normales Supabase-Auth-Konto. Am einfachsten: in
--    webapp-customer/index.html (Kunden-Webapp) auf "Jetzt registrieren"
--    mit der E-Mail-Adresse, die als Admin fungieren soll, ein Konto
--    anlegen und die Bestätigungs-Mail bestätigen.
-- 3. Dieses Skript hier im SQL-Editor ausführen, VORHER die E-Mail-Adresse
--    unten eintragen.
-- 4. Danach in webapp-admin/index.html mit genau diesem Konto anmelden.

insert into public.admin_users (user_id, note)
select id, 'Erster Admin'
from auth.users
where email = 'REPLACE-WITH-YOUR-ADMIN-EMAIL@example.com'
on conflict (user_id) do nothing;

-- Weitere Admins später genauso freischalten (E-Mail anpassen, erneut
-- ausführen) -- dieses Skript ist absichtlich nicht Teil der
-- durchnummerierten Migrationen, da es pro Person individuell ausgeführt
-- werden muss.
