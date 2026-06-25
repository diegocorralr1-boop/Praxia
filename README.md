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

> Note: the Supabase URL and key in `index.html` are placeholders. Add your own Supabase project credentials to run it.

## Status

In active pilot with private specialists in Tijuana, México.
