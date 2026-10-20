# Functional QA checklist — every feature and button, in order of importance

_Last full pass: 20 Oct 2026 on `main`. Verified in a real Chromium against a stateful fake Supabase API with the production CSP (`tests/e2e/app.test.js`, `accounts.test.js`, `legal.test.js`), plus a line-by-line review of `app.js`. The production database could not be reached from the review environment, so the last column says what to confirm there._

Legend: ✅ works and is covered by an automated test · 🔧 bug found and fixed in this pass · ⚠️ needs a one-time action in Supabase/Netlify (see the end).

| # | Feature / buttons | Verified | Found and fixed | Confirm in production |
|---|---|---|---|---|
| 1 | **Login** — Correo, Contraseña, Entrar, error messages, idle logout after 30 min | ✅ wrong password shows «Correo o contraseña incorrectos», right one opens the app; idle warning + logout | 🔧 Enter did nothing on the login/sign-up/join/reset forms; 🔧 no `autocomplete` hints for password managers | Log in once with the real account |
| 2 | **Patient capture** — Paciente, Teléfono in «Nueva entrada» | ✅ names are deduplicated server-side (accent/case-insensitive); phone separates homonyms; `ambiguous_patient` asks for a phone | 🔧 no suggestions while typing → the field now offers the clinic's existing patients (dropdown) and fills the phone when one is picked | Type the first letters of a known patient and pick it from the list |
| 3 | **New entry** — Fecha, Estatus, Cobros (concepto, modificador, método, monto), + concepto, Agregar línea, ✕, Guardar | ✅ every `<select>` has options and nothing overlaps it (hit-tested); values survive adding/removing lines; USD lines convert at the frozen rate; a package splits its amount in cents; one server transaction (`save_entry`) | 🔧 **Dropdowns could render empty**: if the categories read failed (missing `currency` column before `0004`, RLS, network) the app silently kept empty lists. Now it retries without the column, falls back to the default catalogue and shows a warning; seeding never runs on a failed count | Open «Nueva entrada» and check the four dropdowns have options. If a red toast says «No se pudieron cargar las categorías», go to Ajustes → General → Estado del sistema |
| 4 | **Entries list** — grouping by day, daily total, patient count, concept tags, method | ✅ totals match the sum of lines (MXN + USD×TC) | — | — |
| 5 | **Edit entry** — pencil icon, prefilled sheet, save | ✅ patient, status and every line are prefilled; save updates the same entry | 🔧 editing an entry whose concept/method/status was later deleted from Categorías silently switched it to the first option; the saved value is now kept in the list | — |
| 6 | **Delete entry** — trash icon + confirmation | ✅ confirm dialog, row disappears, audit row written | 🔧 **Edit/delete icons were invisible on touch screens** (they only appeared on mouse hover). Always visible on phones/tablets now | On a phone, the pencil and trash icons must be visible on every row |
| 7 | **Calendar** — ‹ ›, month total, day cells, day detail | ✅ month navigation, counts per day, detail list with edit/delete | — | — |
| 8 | **Patients (CRM)** — grid/list toggle, patient card, visits, anonymizar | ✅ visits, totals, last visit, anonymize (ARCO) | 🔧 no search and no phone shown → search box (accent-insensitive, by name or phone), phone on cards, list and detail | Search a patient by phone |
| 9 | **Analytics** — totals, patients, average ticket, by concept, by method, daily trend | ✅ numbers match the entries; hidden for Recepción without the capability | — | — |
| 10 | **Sign-up (new clinic)** — Crear consultorio → confirm e-mail → clinic created by the server | ✅ existing e-mail message, confirmation screen, resend with cooldown, server-side onboarding with retry | — (fixed in the accounts pass) | ⚠️ Needs `0006_accounts.sql` applied and SMTP configured; see the end |
| 11 | **Join with code** — Únete con un código, live code check | ✅ code validated before sign-up; wrong code blocks it; join from the onboarding screen | — | ⚠️ `0006` |
| 12 | **Password reset** — ¿Olvidaste tu contraseña?, e-mail link, new password | ✅ neutral message, recovery link opens the new-password form, mismatch check | — | Needs the Site URL / Redirect URLs set in Supabase Auth |
| 13 | **Ajustes → Preferencias** — Recepción capability switches | ✅ each switch saves `set_recepcion_caps`; Recepción UI reacts (totals, analytics, edit/delete, tabs) | — | — |
| 14 | **Ajustes → Personal** — team table, Hacer gerente/recepción, Deshabilitar, Quitar, Generar código, Revocar | ✅ (accounts test) | — | ⚠️ `0006` |
| 15 | **Ajustes → Categorías** — Agregar, ✕, MXN/USD toggle on methods | ✅ add (button and Enter), delete, currency toggle; the entry form sees the change immediately | — | — |
| 16 | **Ajustes → Datos** — Tipo de cambio, Exportar CSV, Historial de cambios | ✅ rate saved and used for new USD lines; CSV has one row per charge with a UTF-8 BOM for Excel; audit list | — | — |
| 17 | **Ajustes → Privacidad** — legal documents, patient notice template, Descargar mis datos, Eliminar cuenta, Eliminar consultorio, privacy log | ✅ (legal test) | — | ⚠️ `0005_privacy_compliance.sql`; fill `legal-config.js` |
| 18 | **Ajustes → General** — Cerrar sesión, Estado del sistema, Acerca de | ✅ logout with confirmation | 🔧 new **Estado del sistema** block: shows which migrations the database has (`0004`–`0007`) and whether the dropdown catalogue came from the database or from the built-in defaults | Open it once and send a screenshot if anything says «falta» |
| 19 | **Phone layout** — ☰ menu, drawer, entry rows, sheet, charge lines | ✅ at 390 px: no horizontal scroll, drawer opens/closes, sheet is full width, Guardar stays on screen | 🔧 entry rows collapsed into an odd 2-column layout; 🔧 three cramped columns per charge line (now two under 420 px); 🔧 sheet used `100vh` so Guardar could hide under the browser toolbar (`100dvh`) | Create an entry from a phone |
| 20 | **Administración** (platform admins) — Consultorios, Usuarios, Nuevo consultorio, Errores | ✅ (accounts test) | — | ⚠️ `0006`, `0007`, and the two admin e-mails inserted into `platform_admins` |

## About the «dropdown menus did not work» report

The dropdowns in «Nueva entrada» are plain `<select>` elements filled from the clinic's `categories` table. Two ways they could appear broken before this pass:

1. **Empty lists.** When the categories read failed, the app kept empty arrays and rendered selects with no options, which looks like a dropdown that does nothing. The most likely cause in production is the database missing `0004_security_fixes.sql` (the read asks for the `currency` column that migration adds). Fixed as described in row 3, and the new **Estado del sistema** block says exactly which migration is missing.
2. **Touch devices.** Edit/delete icons were hover-only; nothing else in the form was touch-specific, but the charge line was cramped on narrow phones. Fixed in rows 6 and 19.

If a dropdown still misbehaves after deploying this version, note which screen and which dropdown, and whether the red «No se pudieron cargar las categorías» toast appeared. Uncaught JavaScript errors are now reported to Administración → Errores once `0007` is applied.

## One-time actions that are not code (owner of Supabase / Netlify)

1. Supabase → SQL Editor: run `0004_security_fixes.sql` if Estado del sistema says «falta», then `0005_privacy_compliance.sql`, `0006_accounts.sql`, `0007_observability.sql`, in that order.
2. Supabase → SQL Editor: `insert into public.platform_admins (email) values ('<correo de Diego>'), ('<correo de Fer>');`
3. Supabase → Authentication: custom SMTP; Site URL and Redirect URLs = the Netlify domain; e-mail OTP expiration 86400; Confirm email on; minimum password length 10.
4. `legal-config.js` and `.well-known/security.txt`: fill in the placeholders and commit.
5. Netlify: after deploying, open the site once from a phone and once from a desktop and walk rows 1, 3, 6, 18 and 19.

## How to re-run this checklist

```sh
npm run check            # lint + HTML + SQL tests + all browser tests (needs Postgres and Chromium)
node tests/e2e/app.test.js   # only the feature walk-through (prints every observed value as JSON)
```
