# Runbook for Diego — finish the production setup (Supabase, Netlify, GitHub)

**How to use this file.** Everything below the line is a prompt. On your computer: `git checkout main && git pull`, open the repo folder in Claude Code, and paste the whole prompt. Claude will walk you through it, run the checks, and give you the SQL to paste wherever it cannot run it itself (if the Supabase MCP server is connected in your Claude Code, it can run the SQL for you). You can also just follow the steps by hand; each one says exactly where to click. No step needs you to write code.

Before you paste it, replace the three placeholders: `<correo de Diego>`, `<correo de Fer>` and `<tu-sitio>.netlify.app`.

---

You are helping me finish the production setup of **Praxia · Registro**, the app in this repository (a static site on Netlify backed by Supabase). I own the Supabase project `yqsgeywhilqrsombekce`, the Netlify site and the GitHub repository. The code on `main` is done and tested; what is missing lives in Supabase, Netlify and GitHub settings. Work through the steps **in order**, verify each one before moving on, and finish with the report in step 11. Ask me before anything destructive.

**Rules**

- Never paste, print, commit or log the `service_role` key, the database password or a full connection string. When you need the database URL, ask me to export it in my shell as `DATABASE_URL` and reference `"$DATABASE_URL"`. It is in Supabase → Project Settings → Database → Connection string (URI); use the *Direct connection* or *Session pooler* string (port 5432), not the transaction pooler.
- The SQL migrations at the repo root (`0004_…` to `0007_…`) are **not idempotent**. Always check what is already applied (step 1) and run only the missing ones, in numeric order, each exactly once.
- Do not change anything in the `public` schema by hand except running the migration files and the `platform_admins` insert in step 4.
- `psql`/`pg_dump` are optional. Without them, use Supabase → SQL Editor for every SQL block (New query → paste → Run). On macOS `brew install libpq` provides both; on Windows the PostgreSQL installer does.

## Step 0 — Update the checkout

```sh
git checkout main && git pull
npm ci
git log --oneline -1
```

Confirm the last commit is from 20 Oct 2026 or later and `docs/QA-CHECKLIST.md` exists. If `npm ci` fails, tell me the error and continue; it is only needed for step 10.

## Step 1 — Which migrations does the database already have?

Run in Supabase → SQL Editor (or `psql "$DATABASE_URL"`):

```sql
select '0004_security_fixes'     as migration, exists (select 1 from information_schema.columns where table_schema='public' and table_name='categories' and column_name='currency') as applied
union all select '0005_privacy_compliance', to_regclass('public.privacy_log') is not null
union all select '0006_accounts',           to_regprocedure('public.my_account_state()') is not null
union all select '0007_observability',      to_regclass('public.client_errors') is not null;
```

Write down the result. The goal is four `true`. (The app shows the same thing in Ajustes → General → Estado del sistema once it is deployed.)

## Step 2 — Backup before changing anything

Preferred, if `pg_dump` is installed and its version is at least the server's (`select version();`):

```sh
scripts/db/backup.sh "$DATABASE_URL"
```

The file lands in `backups/` (git-ignored). It contains patient data: keep it on an encrypted disk, never in the repo or in Supabase storage. If you cannot run `pg_dump`, note that step 3 only adds tables, columns and functions (nothing is dropped) and continue; we will set up proper backups in step 7.

## Step 3 — Apply the missing migrations, in order

Only the ones that were `false` in step 1, lowest number first. Two ways:

- **SQL Editor:** open the file at the repo root (`0004_security_fixes.sql`, `0005_privacy_compliance.sql`, `0006_accounts.sql`, `0007_observability.sql`), paste the whole file into a new query, Run. It must finish with "Success" and no error. Then the next file.
- **Terminal:** `scripts/db/apply.sh "$DATABASE_URL" 0005` — replace `0005` with the first missing number; the script applies that one and every later one and stops at the first error.

If a migration fails part-way, stop, copy the full error text for me, and do not re-run anything. When done, re-run the step 1 query: all four must be `true`.

## Step 4 — Register the two platform administrators

The admin panel (Administración) is only visible to e-mails in `platform_admins`. Use exactly the e-mails we log in with, lowercase:

```sql
insert into public.platform_admins (email) values ('<correo de Diego>'), ('<correo de Fer>') on conflict do nothing;
select email, user_id from public.platform_admins;
```

`user_id` may be empty until that person signs in; that is fine.

## Step 5 — Authentication settings (Supabase → Authentication)

1. **Email provider** (Authentication → Sign In / Providers → Email; older dashboards: Providers → Email): *Confirm email* **on**, *Secure email change* **on**, *Minimum password length* **10**, *Email OTP expiration* **86400** seconds (the confirmation link must last 24 h; the default hour expires before many people open the mail).
2. **URL configuration** (Authentication → URL Configuration): *Site URL* = `https://<tu-sitio>.netlify.app`. *Redirect URLs*: add `https://<tu-sitio>.netlify.app/**` and, for previews, `https://deploy-preview-*--<tu-sitio>.netlify.app/**`. Without these, confirmation and password-reset links send people to the wrong place.
3. **Custom SMTP** (Authentication → Emails → SMTP Settings; older dashboards: Project Settings → Authentication → SMTP): enable it with a transactional provider (Resend, Brevo, Postmark or SendGrid all have free tiers) and a sender address on a domain we control, e.g. `no-reply@…`. **This is the blocker for sign-ups:** Supabase's built-in mailer only delivers to the project's own team members, two per hour, so no client can create an account until this is on.
4. Leave rate limits and the e-mail templates at their defaults for now.

**Verify:** in an incognito window open the site, *Crea tu consultorio* with an e-mail you control that is **not** a Supabase team member. The confirmation mail must arrive within a minute; clicking it must open the app with the new clinic ready (no "Termina tu alta" screen). Note how long the mail took. Afterwards delete that test clinic: log in as admin → Administración → Consultorios → Eliminar.

## Step 6 — Verify the deployed app

Netlify deploys `main` automatically; Netlify → Deploys must show the latest commit as *Published*. Then, logged in as yourself:

- Ajustes → General → **Estado del sistema**: four rows "aplicada", Categorías "ok". Screenshot it for me.
- The sidebar shows **Administración** (you are in `platform_admins`).
- **Nueva entrada**: the four dropdowns (estatus, concepto, modificador, método) have options; save a test entry, edit it, delete it.
- From a **phone**: the pencil and trash icons are visible on each entry row and the *Guardar entrada* button is on screen.
- Administración → Errores shows "Sin errores reportados" (or a list: send it to me).

## Step 7 — Backups going forward

Pick one and tell me which: (a) Supabase Pro ($25/month): daily backups plus point-in-time recovery, no scripts; or (b) stay on Free and run `scripts/db/backup.sh "$DATABASE_URL"` every week from a scheduled task on your computer, storing the dump on an encrypted drive. Clinic revenue data without any backup is the single biggest risk in the whole setup.

## Step 8 — Netlify and GitHub hygiene

- **Netlify:** Site configuration → Build & deploy: production branch `main`, publish directory `.` (there is no build command). Then run `curl -sI https://<tu-sitio>.netlify.app/ | grep -i -E 'content-security-policy|strict-transport|x-frame'` — all three headers must be present; they come from `netlify.toml`. Also open `https://<tu-sitio>.netlify.app/.well-known/security.txt`.
- **GitHub** → Settings → Branches → Add branch ruleset / protection rule for `main`: require a pull request before merging, require the **CI** status check to pass, apply to administrators. Settings → Code security: enable Dependabot alerts and secret scanning (free on public repos). Settings → Collaborators: Fer has *Write* access.

## Step 9 — Legal placeholders (needs your data, not code)

`legal-config.js` still has `[RAZÓN SOCIAL…]`, `[CALLE…]`, `[privacidad@tudominio.mx]`, `[seguridad@tudominio.mx]`, `[https://tu-sitio.netlify.app]`, and `.well-known/security.txt` has `Contact: mailto:[seguridad@tudominio.mx]`. Fill them with the real responsable, address, two mailboxes that someone reads (aliases are fine) and the site URL. The legal pages and the consent modal show these values. Do it on a branch, open a pull request, let CI pass, merge.

## Step 10 — Optional but recommended: a development project

Today localhost and Netlify deploy previews hit the production database. Create a second Supabase project (e.g. `praxia-dev`), run **all** migrations there in order (`scripts/db/apply.sh "$DEV_DATABASE_URL"` with no second argument, or paste `0001` to `0007` in its SQL Editor), then put its URL and *publishable* key into `config.js` → `ENVS.development` and commit. Previews and local runs switch to it automatically. The publishable key is safe to commit; the service_role key never is.

## Step 11 — Report back

Reply to me with: the step 1 table before and after; the `platform_admins` rows; SMTP provider and sender address; Site URL and redirect URLs as configured; the test sign-up result and how long the mail took; the Estado del sistema screenshot; the backup decision; whether branch protection is on; whether `legal-config.js` is filled; whether the dev project exists; and the exact error text of anything that failed.
