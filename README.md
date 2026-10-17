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

## Repository contents

- `index.html` — the full application (front end)
- `0001_init.sql` — database schema (clinics, patients, entries, line items, settings) and row-level-security policies
- `0002_invites.sql` — invite-code system for adding reception staff to a practice
- `0003_split_payments.sql` — per-line payment method, supporting split MXN/USD payments
- `0004_security_fixes.sql` — locks roles and invites, server-side entry saves, audit log, per-line currency, frozen exchange rate per entry

Run the `.sql` files in order (0001 → 0004) in Supabase Studio → SQL Editor.

## Security model

- `index.html` contains the project URL and the **publishable** key. That key is public by design; it grants nothing on its own.
- All access control is in Postgres: row-level security isolates each clinic, and money records are written only through the `save_entry` RPC.
- Users can change only their own display name. Role and clinic change only through `bootstrap_clinic` / `accept_invite`.
- Invite codes: 16 characters, single use, expire after 48 hours, readable only by managers; 10 failed redemptions per user per hour.
- Recepción without *monthly totals*, *analytics* or *export* only sees the last 7 days of entries.
- Every create/edit/delete of entries and charge lines is recorded in `entry_audit` (managers: Ajustes → Datos → Historial de cambios).
- **Required Supabase setting:** Authentication → Providers → Email → *Confirm email* must be **on**.

## Status

In active pilot with private specialists in Tijuana, México.
