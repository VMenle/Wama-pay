-- Wama-Pay Schema · Migration 0020
-- Fix: set_override_pin/verify_override_pin (Migration 0019) verwenden
-- gen_salt()/crypt() aus der Extension pgcrypto. Bei neueren Supabase-
-- Projekten installiert sich pgcrypto automatisch ins Schema "extensions"
-- statt "public" -- die Funktionen suchten aber nur in "public"
-- (search_path = public), daher der Fehler
-- "function gen_salt(unknown) does not exist". Fix: extensions zusätzlich
-- in den search_path der beiden Funktionen aufnehmen.
alter function public.set_override_pin(uuid, text) set search_path = public, extensions;
alter function public.verify_override_pin(uuid, text) set search_path = public, extensions;
