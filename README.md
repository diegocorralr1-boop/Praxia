# Praxia · Financial Solutions

Finance and analytics software for private medical practices.

## What it is

Praxia is a revenue-tracking and analytics tool for private medical specialists in Tijuana, a major cross-border medical hub. Most private practices track income in fragile spreadsheets that can't answer the basics — how much did I earn this month, which service pays most, how much came in as cash, card, or dollars.

Praxia replaces that with a revenue ledger built for the front desk: fast charge entry, automatic patient records, a revenue calendar, and clear analytics by service and payment method. It is a financial layer for the practice — not a clinical records system.

## Features

- **Fast charge entry** — multi-service visits, split MXN/USD payments, and service packages in a single entry
- **Automatic patients** — every charge creates and updates the patient record
- **Revenue calendar** — how much came in each day of the month, at a glance
- **Analytics** — revenue and visit counts by service and by payment method
- **Roles & permissions** — separate manager and reception access; the manager controls what reception can see
- **Runs anywhere** — any browser on computer or phone, nothing to install; exports to Excel

## Tech

- **Front end:** single-file HTML / CSS / JavaScript (no framework)
- **Backend:** Supabase — Postgres, authentication, and row-level security
- **Multi-tenant:** each practice's data is isolated through row-level security
- **Deployment:** Netlify (static hosting)

## Developer workflow

```bash
npm install          # dev tools (the app itself has no dependencies or build step)
npm run serve        # http://localhost:8888
npm run check        # lint + HTML sanity + SQL tests (needs Postgres, see CONTRIBUTING.md) + browser tests
```

CI runs the same checks on every push and pull request (`.github/workflows/ci.yml`). See `CONTRIBUTING.md` for the workflow and `docs/ARCHITECTURE.md` for how the system fits together. `docs/ROADMAP-ROBUSTEZ.md` is the engineering roadmap.

## Repository contents

- `index.html`, `app.js`, `app.css` — the application (markup, logic, styles); `config.js` — environment (production/development) and app version
- `0001_init.sql` — database schema (clinics, patients, entries, line items, settings) and row-level-security policies
- `0002_invites.sql` — invite-code system for adding reception staff to a practice
- `0003_split_payments.sql` — per-line payment method, supporting split MXN/USD payments
- `0004_security_fixes.sql` — locks roles and invites, server-side entry saves, audit log, per-line currency, frozen exchange rate per entry
- `0005_privacy_compliance.sql` — consent record, privacy log, patient anonymization, clinic/account deletion, personal-data export (LFPDPPP)
- `0006_accounts.sql` — account lifecycle (server finishes the sign-up when the email is confirmed), account events, member management, platform admins
- `0007_observability.sql` — client error reports (Administración → Errores)
- `tests/` — SQL scenario tests and Playwright browser tests; `scripts/` — test runner, HTML checks, `db/apply.sh`, `db/backup.sh`
- `privacidad.html`, `terminos.html`, `aviso-pacientes.html` — legal pages (Spanish); `legal-config.js` holds the legal entity's details and the current terms version
- `fonts/` — self-hosted fonts (no third-party font requests); `netlify.toml` — security headers (CSP, HSTS)
- `docs/PLAN-LEGAL-MX.md` — the 15-point legal, privacy and security plan for Mexico; `docs/RESPUESTA-A-INCIDENTES.md` — breach response procedure

Run the `.sql` files in order (0001 → 0007) in Supabase Studio → SQL Editor, or `scripts/db/apply.sh "<DATABASE_URL>" <first-pending-number>`.

## Accounts, roles and admins

- **Sign-up** stores the clinic name (or invite code) in the user's metadata; when the email is confirmed, a database trigger creates the clinic / redeems the invite. The app only shows the state and offers to retry (`docs/PLAN-CUENTAS.md`).
- **Roles inside a clinic:** `manager` (full access, Ajustes → Personal to invite, remove, change roles, disable) and `recepcion` (what the manager allows). The clinic's **owner** (founding manager) can only be changed by a platform admin.
- **Platform admins** (the people who run Praxia) see every clinic and user, can create a clinic plus a manager invite code for a client, suspend/delete clinics and disable/delete users (nav → Administración). They do **not** get the clinics' patient or revenue data. Add an admin by running, in the SQL Editor, with the email that person signs in with:
  ```sql
  insert into public.platform_admins (email) values ('persona@correo.mx');
  ```
  The row links to their account the next time they sign in. Remove with `delete from public.platform_admins where email = '…'`.
- **Email must work for sign-up to work.** Supabase's built-in mailer only delivers to the project team's addresses (2/hour). Configure a custom SMTP provider, the Site URL and Redirect URLs, and set *Email OTP expiration* to 86400 (Authentication settings). Details in `docs/PLAN-CUENTAS.md`, fase 0.

## Legal & privacy (Mexico)

Praxia stores patient names next to paid procedures, which is sensitive (health) data under the LFPDPPP. Before onboarding real clinics:

1. Fill in `legal-config.js` (legal entity, address, privacy and security emails, site URL). The legal pages show missing fields in red until you do.
2. Run `0005_privacy_compliance.sql`; the app works without it but can't record consent or run the ARCO self-service actions.
3. Follow `docs/PLAN-LEGAL-MX.md`, which lists what is implemented and what the partners still have to do (Supabase Auth settings, backups, lawyer review).

## Security model

- `index.html` contains the project URL and the **publishable** key. That key is public by design; it grants nothing on its own.
- All access control is in Postgres: row-level security isolates each clinic, and money records are written only through the `save_entry` RPC.
- Users can change only their own display name. Role and clinic change only through `bootstrap_clinic` / `accept_invite`.
- Invite codes: 16 characters, single use, expire after 48 hours, readable only by managers; 10 failed redemptions per user per hour.
- Recepción without *monthly totals*, *analytics* or *export* only sees the last 7 days of entries.
- Every create/edit/delete of entries and charge lines is recorded in `entry_audit` (managers: Ajustes → Datos → Historial de cambios).
- Consents, patient anonymizations and account/clinic deletions are recorded in `privacy_log` (managers: Ajustes → Privacidad).
- Sessions end after 30 minutes without activity; passwords must be at least 10 characters; password reset is available from the login screen.
- `netlify.toml` sets a Content-Security-Policy (scripts only from the site and the SRI-pinned supabase-js, API calls only to our Supabase project, no framing), HSTS and related headers.
- **Required Supabase settings:** Authentication → Providers → Email → *Confirm email* **on**, *Minimum password length* **10**; a custom SMTP provider (the built-in one is for testing only); Site URL and Redirect URLs set to the deployed site. Details in `docs/PLAN-LEGAL-MX.md`, point 10.

## Status

In active pilot with private specialists in Tijuana, México.
