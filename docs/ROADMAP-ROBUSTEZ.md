# Praxia — Robustness roadmap

_19 Oct 2026. Companion to `docs/ARCHITECTURE.md`. Status legend: ✅ done · 🔜 next · ⏳ later._

## The question first: do we need Java (or any application server)?

**Not now, and not for robustness.** Praxia already has a real backend: Postgres with row-level security, server-side functions and triggers, authentication and an HTTP API, all operated by Supabase. Every business rule the product has is enforced there, where the browser cannot bypass it. What made the codebase feel fragile was the *engineering around it*: one 1,400-line HTML file, no separation of code and markup, no tests in the repo, no CI, no error visibility, no environments. Those are what technical investors probe, and they are fixed or scaffolded below without changing the stack.

A Java/Spring (or Node) service would add a server to deploy, scale, patch and pay for, re-implement authorization that RLS already does, and buy nothing the product needs today. When server-side work is required (sending invite emails with the admin key, PDF receipts, scheduled jobs, billing webhooks, integrations), the right tool is **Supabase Edge Functions** (TypeScript, deployed next to the database). Revisit a dedicated service only if the product grows a large integration surface or the team hires for that stack.

## Ten-step plan

| # | Step | Status | What it gives investors / users |
|---|---|---|---|
| 1 | **Separate code from markup and add quality gates.** `app.js` + `app.css` out of `index.html`; ESLint, Prettier, EditorConfig; HTML sanity script; strict CSP with no inline scripts. | ✅ today | Readable, lintable codebase; XSS surface reduced |
| 2 | **Automated tests in CI on every change.** SQL scenario tests with assertions (RLS, permissions, lifecycle) on a real Postgres with all migrations; Playwright browser tests with the real CSP; GitHub Actions; PR template. | ✅ today (branch protection: you) | Regressions caught before production; a green badge to show |
| 3 | **Environments.** `config.js` selects production vs development Supabase by hostname; previews/localhost stop touching real patient data once the dev project exists. | ✅ code · 🔜 create the dev project | Safe testing; no accidental edits to client data |
| 4 | **Observability.** Uncaught browser errors reported to `client_errors` with version/page/browser; admin view. Next: uptime monitor, Supabase log alerts, Sentry if volume grows. | ✅ basic (0007) · 🔜 alerts | Know about breakage before users call |
| 5 | **Data safety.** Repeatable migration apply script; backup script (pg_dump); Supabase Pro daily backups; quarterly restore drill. | ✅ scripts · 🔜 Pro + drill | Patient data cannot be lost by one mistake |
| 6 | **Modular front end.** Split `app.js` into ES modules per view (`auth`, `entries`, `calendar`, `patients`, `analytics`, `settings`, `admin`), a typed API layer generated from the database (`supabase gen types` + TypeScript via Vite), shared UI components. | 🔜 next sprint | Several engineers can work in parallel; type errors caught at build |
| 7 | **Server-side jobs with Edge Functions.** Email invites via the admin API (no codes), PDF/CSV receipts, nightly cleanups, future billing webhooks. | 🔜 | Features that need secrets, without exposing them |
| 8 | **Scale the data path.** Load by date range instead of the whole ledger; server-side totals via the existing RPCs; indexes reviewed with real volumes; per-tenant rate limits; `clinic_members` table if multi-clinic users are ever needed. | ⏳ when a clinic passes ~50k rows | Fast at 100× today's data |
| 9 | **Product hardening.** Offline-tolerant entry queue, optimistic UI with retry, finer role permissions, accessibility pass, English UI option. | ⏳ | Front-desk reliability on bad Wi-Fi |
| 10 | **Operations and compliance maturity.** Incident drills, status page, SLA definition, security review cadence, SOC 2-style control list, investor data room (architecture, security model, test evidence, roadmap). | ⏳ ongoing | Diligence-ready |

## Twenty improvements (prioritized)

Done today in this branch:

1. ✅ `app.js` / `app.css` extracted from `index.html`; CSP no longer allows inline scripts.
2. ✅ Pagination of Supabase reads (`fetchAll`) — reports, patients and CSV were silently truncated at 1,000 rows.
3. ✅ ESLint + Prettier + EditorConfig; `npm run lint` is clean.
4. ✅ SQL test suite with assertions (`tests/sql`, 3 files, ~100 checks) running against every migration.
5. ✅ Browser test suite ported into the repo with assertions (`tests/e2e`, 2 files, 28 scenarios).
6. ✅ GitHub Actions CI (lint, HTML sanity, SQL, browser) on every push/PR; PR template; Dependabot.
7. ✅ `config.js`: environment selection + app version shown in Ajustes → General.
8. ✅ Client error reporting (`0007_observability.sql`) + Administración → Errores.
9. ✅ `scripts/db/apply.sh` (ordered migrations) and `scripts/db/backup.sh` (pg_dump).
10. ✅ `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, this roadmap.

Next (in order):

11. 🔜 Protect `main` in GitHub: require the CI check and one review (needs repo admin).
12. 🔜 Create the development Supabase project, fill `config.js`, run migrations there; Netlify previews then use it.
13. 🔜 Supabase Pro (backups, no pausing) + first restore drill with `scripts/db/backup.sh`.
14. 🔜 Uptime monitoring (e.g., Better Stack / UptimeRobot on the site and a `health` RPC) + Supabase log alerts.
15. 🔜 Vite + TypeScript + ES modules; generated DB types; one module per view (step 6).
16. 🔜 Edge Function `invite-member` (email invites) and Spanish email templates (plan de cuentas, fase 4).
17. 🔜 End-to-end tests with real emails on the local Supabase stack (Mailpit) in CI (plan de cuentas, fase 5).
18. ⏳ Date-range loading + server-side totals; index review with production-size data.
19. ⏳ Offline-tolerant entry queue and retry; connection-loss UX.
20. ⏳ Investor data room: architecture, security model, test evidence, uptime, roadmap; status page.

## How to show this to investors

- **Architecture:** `docs/ARCHITECTURE.md` (diagrams, data model, security model).
- **Quality:** the CI badge on the README, `npm run check` output, `tests/` folder.
- **Security & compliance:** `docs/PLAN-LEGAL-MX.md`, `SECURITY.md`, `docs/RESPUESTA-A-INCIDENTES.md`, `netlify.toml` headers.
- **Roadmap:** this file.
