-- Wama-Pay Schema · Migration 0016
-- PayPal als zweiten Payment-Provider eintragen (siehe
-- supabase/functions/_shared/paypalAdapter.ts). Läuft bei Wama-Pay
-- ausschließlich über einen statisch am Gerät angebrachten PayPal-Payment-
-- Button/QR-Code (IPN-basiert), nicht über den dynamischen
-- create-checkout-Ablauf -- daher taucht 'paypal' bewusst NICHT als
-- Auswahloption in webapp-checkout/bezahlen.html auf.

insert into public.payment_providers (id, display_name, is_active)
values ('paypal', 'PayPal', true)
on conflict (id) do nothing;
