# Wama-Pay

Pay-per-use-System für Waschmaschinen/Trockner in Waschsalons. Kunde scannt
einen QR-Code am Gerät, bezahlt (SumUp, PayPal oder Wallet-Guthaben) und das
Gerät schaltet sich frei. Betreiber: VM-Energy and Leisure (Einzelunternehmen),
Gollenhofweg 5, 73563 Mögglingen, vertreten durch Dipl.-Ing. Volker Moos.

Dieses Dokument bündelt: welche Komponenten es gibt, in welcher Reihenfolge
alles eingerichtet wird, und eine Checkliste zum Durchtesten vor dem
Produktivgang. Details zu einzelnen Komponenten stehen in den verlinkten
Unter-READMEs — hier geht es um den Gesamtüberblick.

## Komponenten

| Ordner | Was |
|---|---|
| `supabase/migrations/` | Datenbankschema (Postgres), durchnummeriert, einzeln im SQL-Editor auszuführen |
| `supabase/functions/` | Edge Functions: `create-checkout`, `payment-webhook`, `device-override` — siehe [`supabase/functions/README.md`](supabase/functions/README.md) |
| `webapp-checkout/` | Öffentliche Bezahlseite (kein Login nötig) — Gerät/Zahlweise wählen, SumUp/PayPal/QR anzeigen |
| `webapp-customer/` | Kunden-Login-Bereich — Wallet, Bestellhistorie, Benachrichtigungseinstellungen |
| `webapp-admin/` | Admin-Bereich (nur für `admin_users`) — Standorte/Geräte/Preise pflegen, Notfreigabe-PIN setzen, Override-QR erzeugen, Notfreigabe-Protokoll einsehen |
| `n8n/` | Workflows für Beleg-Mail, "Maschine fertig"-Erkennung, Reservierungs-Timeout — siehe [`n8n/README.md`](n8n/README.md) |
| `shelly/` | Skript für Shelly-Smart-Plugs, erkennt per Leistungsmessung, wann ein Waschgang fertig ist — siehe [`shelly/README.md`](shelly/README.md) |
| `docs/payment-provider-adapter.md` | Architektur der Zahlungsanbieter-Abstraktion (SumUp/PayPal hinter einem gemeinsamen Interface) |

Alle drei Webapps sind statisches HTML/JS ohne Build-Schritt — einfach als
Static Site hosten (z.B. GitHub Pages) oder lokal per Doppelklick öffnen.

## Einmalige Einrichtung (Reihenfolge)

### 1. Datenbank

Im Supabase-Dashboard → **SQL Editor**: jede Datei aus
`supabase/migrations/` **einzeln, in numerischer Reihenfolge** ausführen
(0001, 0002, 0003 … bis zur höchsten Nummer). Jede Datei = eine eigene
Ausführung/ein eigener Klick auf "Run", nicht mehrere Dateien in einem Paste
zusammenfassen.

**Wichtige Ausnahme:** `0018_override.sql` und `0019_override_rest.sql`
**müssen zwei getrennte Ausführungen sein** (nicht zusammen einfügen) — Postgres
lehnt es ab, einen gerade neu hinzugefügten Enum-Wert (`'override'`, in 0018
hinzugefügt) in derselben Transaktion zu verwenden, in der er hinzugefügt
wurde (0019 verwendet ihn in einem `CHECK`-Constraint). Läuft man beide als
eine Ausführung, kommt der Fehler `unsafe use of new value of enum type`.

Aktueller Stand (0001–0019): Kern-Tabellen, Zahlungsanbieter, Kunden/Wallet,
verschlüsselte Bankdaten, RLS-Policies, Fertig-Signal-Infrastruktur, Seed-Daten,
PayPal als Anbieter, Admin-Rolle + physische Freigabe-Platzhalter, Notfreigabe
(Zwei-Faktor).

### 2. Ersten Admin-Account freischalten

1. In `webapp-customer/index.html` mit der E-Mail-Adresse, die als Admin
   dienen soll, registrieren und die Bestätigungs-Mail bestätigen.
2. `supabase/admin-bootstrap-template.sql` öffnen, die Platzhalter-E-Mail
   durch die echte ersetzen, im SQL Editor ausführen.
3. In `webapp-admin/index.html` mit genau diesem Konto anmelden.

Weitere Admins später genauso freischalten (Schritt 2 wiederholen, andere
E-Mail-Adresse).

### 3. Frontend-Konfiguration

`assets/config.js` enthält bereits die Supabase-URL und den `anon`-Key (kein
Geheimnis, siehe Kommentar in der Datei) — nur anpassen, falls ein anderes
Supabase-Projekt verwendet wird.

### 4. Edge-Function-Deployment

Läuft automatisch über `.github/workflows/deploy-edge-functions.yml` bei
jedem Push nach `main`, der `supabase/functions/**` ändert. Voraussetzung:
zwei Repository-Secrets sind gesetzt (`SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID`) — Details und Alternativen (lokale CLI) in
[`supabase/functions/README.md`](supabase/functions/README.md#deployment).

Zusätzlich müssen die **Function-Secrets** (SumUp-Zugangsdaten, Basis-URLs
etc.) im Supabase-Dashboard gesetzt werden — vollständige Liste ebenfalls in
[`supabase/functions/README.md`](supabase/functions/README.md#benötigte-secrets-function-umgebungsvariablen).

### 5. Standorte/Geräte/Preise anlegen

Ab jetzt über `webapp-admin/dashboard.html` statt per SQL:

- **Standort** anlegen.
- **Gerät** anlegen: Name/Label, Standort, Typ (Waschmaschine/Trockner).
- **Preis** (Produkt) anlegen und dem Gerät zuordnen.
- Pro Gerät den **Schaltlink** eintragen ("Bearbeiten" in der Geräteliste):
  die Shelly-Cloud-URL bzw. der Schaltlink, der beim Bezahlvorgang die
  Maschine tatsächlich einschaltet (`switch_webhook_url`, optional
  `switch_webhook_secret` als Header `X-Wama-Pay-Switch-Secret`). Ohne
  eingetragenen Schaltlink läuft die Freigabe rein digital (Datenbankstatus),
  ohne dass sich physisch etwas einschaltet — kein Fehler, nur ein
  Log-Hinweis.

### 6. Zahlungswege pro Gerät einrichten

- **SumUp:** QR-Code auf `webapp-checkout/pay.html?device=<devices.id>`
  drucken und dauerhaft am Gerät anbringen (der Link ändert sich nie, siehe
  [`supabase/functions/README.md`](supabase/functions/README.md#payhtml-fest-aufgehängter-qr-code)).
- **PayPal:** im PayPal-Business-Account einen Payment Button pro Gerät
  anlegen (fester Betrag, verstecktes `custom`-Feld = `devices.id`, IPN-URL
  = `.../payment-webhook?provider=paypal`), QR-Code drucken und anbringen —
  Schritt-für-Schritt-Anleitung in
  [`supabase/functions/README.md`](supabase/functions/README.md#wie-die-paypal-anbindung-funktioniert-statischer-payment-button--ipn).

### 7. Notfreigabe (Zwei-Faktor) einrichten

1. In `webapp-admin/dashboard.html`, Abschnitt "Notfreigabe": PIN setzen
   (4–8 Ziffern, gilt projektweit).
2. Pro Gerät auf "QR erzeugen" klicken, den Override-QR ausdrucken und an
   einer für Kunden **nicht sichtbaren** Stelle anbringen (z.B. innen an der
   Serviceklappe) — nur für Hausmeister/Techniker gedacht.
3. Der QR-Code allein reicht nicht: zusätzlich muss der PIN eingegeben
   werden. Beide Faktoren zusammen lösen die Freigabe aus, protokolliert im
   Notfreigabe-Protokoll im Admin-Dashboard.

### 8. n8n und Shelly

Siehe [`n8n/README.md`](n8n/README.md) (Workflows importieren, Credentials
anlegen) und [`shelly/README.md`](shelly/README.md) (Skript pro Gerät
einrichten, `DEVICE_ID`/`WEBHOOK_URL`/`SIGNAL_SECRET` konfigurieren).

## Bekannte offene Punkte

- **SumUp- und PayPal-Anbindung wurden gegen die offizielle Dokumentation
  entwickelt, aber noch nie gegen einen echten Account/Sandbox getestet**
  (kein Zugang während der Entwicklung) — vor dem ersten echten Zahlungstest
  unbedingt den Abschnitt ["Bekannte offene Punkte" in
  `supabase/functions/README.md`](supabase/functions/README.md#bekannte-offene-punkte-vor-produktivgang-zu-prüfen)
  lesen.
- Race Condition beim PayPal-Weg bei zwei nahezu gleichzeitigen Zahlungen auf
  dasselbe Gerät (Details ebenda) — prinzipbedingt beim reservierungslosen
  statischen QR-Modell, braucht im Zweifel manuelle Nachbearbeitung.
- Physische Geräte-Freigabe ist bewusst generisch als "Schaltlink" gebaut
  (GET-Request, optionales Secret) statt fest auf Shelly programmiert — passt
  aktuell zu Shelly Cloud, ließe sich aber auch mit anderer Hardware nutzen.

## Test-Checkliste vor Produktivgang

Vor der ersten echten Nutzung durch Kunden empfiehlt sich, jeden Punkt einmal
komplett durchzuspielen — am besten mit einem echten Gerät oder zumindest
einem testweise angelegten Gerät ohne angeschlossene Hardware.

### Admin & Stammdaten
- [ ] Admin-Login funktioniert, Nicht-Admin-Konto wird abgewiesen.
- [ ] Standort, Gerät und Preis lassen sich im Admin-Dashboard anlegen und bearbeiten.
- [ ] Schaltlink für ein Testgerät eintragen und speichern.

### Wallet-Zahlung (einfachster Weg, kein externer Anbieter nötig)
- [ ] In `webapp-customer` registrieren, Guthaben aufladen (falls Aufladeweg vorhanden) bzw. testweise per SQL Guthaben setzen.
- [ ] In `webapp-checkout/bezahlen.html` Gerät wählen, mit Wallet bezahlen.
- [ ] Order-Status wird `paid`, Gerät wird als `busy` markiert, Schaltlink wird aufgerufen (im Log/Protokoll sichtbar), Beleg-Mail kommt an (falls n8n eingerichtet).

### SumUp
- [ ] QR-Code/Link `pay.html?device=<id>` scannen, SumUp-Zahlungsseite öffnet sich (Link **und** QR-Anzeige in `verarbeitung.html` prüfen).
- [ ] Testzahlung abschließen, `payment-webhook?provider=sumup` wird aufgerufen, Order-Status wird `paid`.
- [ ] Gerät schaltet sich frei (bzw. Schaltlink-Aufruf im Protokoll sichtbar).
- [ ] Abgelaufene/abgebrochene Zahlung führt nicht zu einer fälschlich freigeschalteten Order.

### PayPal
- [ ] Payment Button mit korrektem `custom`-Feld (Test-`devices.id`) und IPN-URL erzeugen.
- [ ] Testzahlung auslösen, prüfen dass die IPN bei `payment-webhook?provider=paypal` ankommt und die Postback-Verifikation (`VERIFIED`) durchläuft.
- [ ] Order wird rückwirkend angelegt, Status `paid`, Gerät wird freigegeben.
- [ ] Zahlung auf ein bereits belegtes Gerät: Order wird trotzdem verbucht, aber **nicht** freigegeben (`paid_device_busy` im `audit_log` sichtbar) — bewusstes Verhalten, keine Fehlfunktion.

### Notfreigabe
- [ ] Override-QR ohne PIN-Eingabe: keine Freigabe.
- [ ] Falscher PIN: keine Freigabe, generische Fehlermeldung (kein Hinweis, welcher Faktor falsch war).
- [ ] 5 Fehlversuche hintereinander: Sperre für 15 Minuten greift.
- [ ] Korrekter QR-Token + korrekter PIN: Gerät wird freigeschaltet, Eintrag erscheint im Notfreigabe-Protokoll im Admin-Dashboard.
- [ ] Neuen Override-QR erzeugen: alter QR/Token funktioniert danach nicht mehr.

### "Maschine fertig"-Erkennung (falls Shelly angeschlossen)
- [ ] Testwaschgang laufen lassen: Shelly erkennt Start (Leistung über Schwelle) und Ende (Debounce-Zeit unter Schwelle), ruft `device-finished`-Webhook auf.
- [ ] Gerät wird in der Datenbank wieder freigegeben, "Maschine fertig"-Mail kommt an (falls Kunde eingeloggt war und Benachrichtigung aktiviert hat).
- [ ] Ohne jedes Signal: nach 2 Stunden greift der Timeout-Fallback trotzdem.

### Reservierungs-Timeout
- [ ] Checkout starten, aber nicht bezahlen: nach Ablauf des Zeitfensters wird die Reservierung automatisch `expired`, Gerät wird wieder frei (läuft über den 5-Minuten-Schedule-Workflow).
