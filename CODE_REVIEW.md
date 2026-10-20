# Praxia — code review & checklist

_Review date: 17 Oct 2026 · Reviewed: `main` at commit `99276c0` (`index (15).html`, `0001`–`0003` SQL) plus the GitHub / Netlify / Supabase setup._

> **Status (20 Oct 2026): historical.** This review describes `main` as it was on 17 Oct 2026. Since then the database fixes in Appendix B were applied by `0004_security_fixes.sql`, the front-end fixes landed in `app.js`, and the setup items in §2–§3 are tracked in `README.md`, `docs/PLAN-LEGAL-MX.md`, `docs/PLAN-CUENTAS.md` and `docs/ROADMAP-ROBUSTEZ.md`. It is kept for the record; use those files for current state.
>
> _Original note:_ **proposed fixes, not applied.** This file is the only change on its branch, so it can't conflict with bug fixes already in progress. Every proposed change is written out in full in the appendices, and each was tested (see [How this was verified](#5-how-this-was-verified)).

**How to use this file**

- **Whoever is fixing bugs:** treat [§1](#1-bugs-found) as the to-do list and tick each box as it's fixed. The code for each fix is in [Appendix A](#appendix-a--front-end-fixes) (front end) and [Appendix B](#appendix-b--database-migration-0004_security_hardeningsql) (database).
- **Everyone:** [§2](#2-checklist) covers setup and collaboration, [§3](#3-team-workflow) the team workflow, and [§4](#4-hosting-netlify-vs-vercel) the Netlify vs. Vercel question.

## TL;DR

- **The code is in reasonable shape.** It's a clean single-file app, user input is consistently HTML-escaped, and the database uses row-level security (RLS) for tenant isolation. The review found **1 high-severity permission bug**, **4 front-end bugs that silently show wrong totals or dates**, and a few smaller issues.
- **Netlify is fine. You don't need to move to Vercel.** For a static page plus Supabase, Vercel would cost more and add nothing. Vercel's free tier is non-commercial and single-person. See [§4](#4-hosting-netlify-vs-vercel).
- **The biggest risks are in the setup, not the code:**
  1. GitHub, Netlify and Supabase are all owned by **one partner's personal accounts**.
  2. Supabase Free has **no automatic backups** of real clinic revenue data.
  3. Every test and preview runs against the **production database**.

---

## 1. Bugs found

### Database

The fix for all of these is one migration, [Appendix B](#appendix-b--database-migration-0004_security_hardeningsql). It must be **run by hand** in Supabase → SQL Editor. It changes permissions and functions only, no data, and the current app works the same before and after it.

- [ ] 🔴 **High: any receptionist can make herself manager.** One line in the browser console does it: `sb.from("profiles").update({role:"manager"}).eq("id", myId)`. The `profile_self_update` policy in `0001_init.sql` allows updating every column, not just `display_name`. A manager can see all totals, export data, delete entries, change permissions and invite people.
- [ ] 🟠 **Medium: `entry_mxn(id)` returns the peso total of *any* clinic's entry**, given its id.
- [ ] 🟡 **Low: server-side totals ignore per-line payment methods from `0003`.** Affects `entry_mxn`, `get_daily_totals`, `get_monthly_total` and `get_revenue_by_concepto`. A visit of MXN 1000 + USD 50 counts as $1,050 instead of $1,925. The app doesn't call these functions yet.
- [ ] 🟡 **Low: receptionists can list unused invite codes.**
- [ ] 🟡 **Low: invite codes are 6 hex characters** (~16.7M combinations, guessable by script), and two people can redeem the same code at the same moment.
- [ ] 🟡 **Low: manager-only checks don't fire for a caller without a profile** (`NULL <> 'manager'` is not true). Harmless today, but fragile.

> ℹ️ Moving a user into **another** clinic by editing `clinic_id` is already blocked, but only as a side effect of the read policy. The migration blocks it explicitly.

### Front end (`index (15).html`)

All five fixes are in [Appendix A](#appendix-a--front-end-fixes), as one diff and as a list of changes.

- [ ] **1,000-row limit.** Supabase returns at most 1,000 rows per request, and the app makes one request per screen.
  - Effect: once a clinic passes **1,000 visits** (about 2 months at 20/day), the Entries list and calendar drop older visits, **Analytics totals are wrong**, the patient list under-counts, and the **CSV export drops the most recent visits**. In a test with 2,500 visits, the export stopped at July.
- [ ] **"Today" is the UTC date.** After ~5 pm in Tijuana, new entries default to **tomorrow's date** and the calendar highlights tomorrow.
- [ ] **Analytics "Ingresos por concepto" adds USD and MXN amounts together**, so services paid in dollars are under-reported (USD 50 counts as $50).
- [ ] **CSV export uses the visit's payment method instead of each line's**, so split MXN/USD payments export the wrong method and MXN amount.
- [ ] **`supabase-js@2` is loaded unpinned from the CDN**, so any new 2.x release goes live in the app automatically.

### Repo layout

This is optional, and best done **after** the bug fixes land so the renames don't collide with them. Commands and files are in [Appendix C](#appendix-c--repo-layout-optional).

- [ ] Rename `index (15).html` → `public/index.html` and `0002_invites (1).sql` → `0002_invites.sql`.
  - Netlify can't serve the app at `/` under the current name, and the README already refers to the clean names.
- [ ] Add `netlify.toml` so Netlify publishes only `public/`. Today the SQL files would also be downloadable from the site.
- [ ] Add a `.gitignore`. Also fix the README: it says the Supabase keys are placeholders, but the real ones are committed. The publishable key is fine to commit; the secret key never is.

---

## 2. Checklist

**Owner** shows who has the access needed. "Host" = the partner who owns the GitHub repo, Netlify site and Supabase project.

### 🔴 Do now

- [ ] **Host:** Run [Appendix B](#appendix-b--database-migration-0004_security_hardeningsql) in Supabase → SQL Editor, then confirm it took effect:
  ```sql
  select has_column_privilege('authenticated','public.profiles','role','UPDATE')         as role_editable,  -- expect false
         has_column_privilege('authenticated','public.profiles','display_name','UPDATE') as name_editable;  -- expect true
  ```
- [ ] **Host:** Check nobody already used the role bug. Every manager listed should be someone you expect:
  ```sql
  select c.name as clinic, p.display_name, p.role, p.created_at
  from profiles p join clinics c on c.id = p.clinic_id
  order by c.name, p.role;
  ```
- [ ] **Host:** Confirm `0003` is applied in production. This should return one row:
  ```sql
  select 1 from information_schema.columns where table_name = 'entry_items' and column_name = 'method';
  ```
- [ ] **Whoever fixes the front end:** test on a Netlify deploy preview. Click through Entries, Calendar, Pacientes, Analíticas and Ajustes → Datos → Exportar.
- [ ] **Host:** **Backups.** Supabase Free has no automatic backups. Either upgrade to **Pro ($25/mo)**, which adds daily backups kept 7 days and no auto-pause, or until then take a weekly `supabase db dump` and store it somewhere off Supabase. (Recommended: Pro, since this is real clinic revenue data.)
- [ ] **Everyone:** Turn on **2FA** on GitHub, Netlify and Supabase. These accounts hold patient names and revenue.
- [ ] **Host:** Run **Supabase → Advisors → Security Advisor** after applying the migration and fix anything it flags.

### 🟠 Collaboration setup (this month)

- [ ] **Shared ownership.** Today one personal account owns everything, so if it's lost or that partner is unavailable, nobody can deploy, fix the database or restore data.
  - [ ] **GitHub:** create a free GitHub **organization** for Praxia, transfer the repo into it, and make at least 2 partners owners. After the transfer, install Netlify's GitHub app on the new organization and re-link the repo in Netlify's site settings so deploys keep triggering.
  - [ ] **Supabase:** invite all partners to the Supabase **organization** (Organization settings → Team), with at least 2 Owners.
  - [ ] **Netlify:** the Free plan allows only **1 team member**. Either:
    - add partners as **Reviewers** (free on any plan), who can see deploys and leave feedback; or
    - move to **Pro ($20/mo flat, unlimited members since Apr 2026)** when more than one person needs to manage the site.
  - [ ] Ideally register these accounts with a shared business email (e.g. `admin@…`), not a personal one.
- [ ] **Using Claude Code on this repo?** Install the **Claude GitHub App** on the account that owns the repo: https://github.com/apps/claude/installations/select_target. Being a collaborator with push access isn't enough. Without the app, Claude sessions can read the repo but can't push branches. That's why this review was delivered as a patch at first.
- [ ] **Connect Netlify to the GitHub repo** if you deploy by drag-and-drop today. Set the production branch to `main` and turn on Deploy Previews for pull requests.
- [ ] **Protect `main`** (GitHub → Settings → Branches; needs repo admin, i.e. the host): require a pull request and 1 approval before merging.
- [ ] **Public or private repo?** The repo is **public** today. That's not a secret leak (the publishable key is meant to be public), but anyone can read your schema and code. Trade-off: branch protection is free on public repos, while private repos need GitHub Team (paid) for it. Decide deliberately.
- [ ] **Separate dev database.** Deploy previews and local testing all hit **production** with real patient data. Create a second (free) Supabase project for development, run the migrations there first, and make previews and localhost use it. One simple option is choosing the URL/key by `location.hostname` in the HTML.
- [ ] **Track migrations properly.** They've been pasted into the SQL Editor, so Supabase has no record of which ones ran. Options:
  - adopt the Supabase CLI (`supabase link`, then `supabase migration repair --status applied 0001 0002 0003 0004` once, and `supabase db push` from then on); or
  - at minimum, note in each PR whether a migration was run and by whom.
- [ ] **Netlify credits (Free plan).** You get 300 credits/month, each production deploy costs **15 credits**, and when credits run out the **site is paused until next month** (no overage billing). Deploy previews are free. So:
  - merge in batches rather than many small production deploys;
  - check usage in the Netlify dashboard;
  - move to Pro before clinics depend on uptime.
  - (If the Netlify account predates Sept 2025 it may still be on the legacy plan with different limits. Check Billing.)

### 🟡 Auth & privacy (before onboarding more clinics)

- [ ] **Supabase Auth → URL Configuration:** set Site URL to the production Netlify URL, and add the deploy-preview pattern (`https://deploy-preview-*--<site>.netlify.app/**`) to Redirect URLs.
- [ ] **Email confirmation is off** (the app tells users to turn it off). That means anyone can sign up with someone else's email. Set up custom SMTP (Supabase's built-in email is rate-limited and meant for testing only), turn confirmation back on, and update the sign-up screens to say "check your email".
- [ ] **No password reset.** A user who forgets their password is locked out. Add "¿Olvidaste tu contraseña?" using `sb.auth.resetPasswordForEmail` (needs SMTP).
- [ ] Raise the minimum password length from 6 to at least 8 (Supabase Auth settings plus the UI checks).
- [ ] **Pin the CDN script with an integrity hash** after pinning the version. Run
  `curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3 | openssl dgst -sha384 -binary | openssl base64 -A`,
  add `integrity="sha384-<output>" crossorigin="anonymous"` to the `<script>` tag, and verify on a deploy preview.
- [ ] **Data protection (talk to a lawyer).** Patient names next to procedures (e.g. FACO, LASER YAG) are likely **sensitive personal data** under Mexico's data protection law (LFPDPPP). Clinics will expect:
  - a privacy notice (aviso de privacidad);
  - a data-processing agreement;
  - an answer to "where is our data stored?" (check the Supabase project's region).

### ⚪ Backlog: known limitations worth a ticket each

- [ ] **Reception permission switches only hide things in the screen; they don't protect the data.** Verified: a receptionist with Analytics and Monthly totals **off** can still read every amount through the API (browser console). Each entry row also shows its amount anyway. If this restriction matters to clinics, totals must come from the server functions (`get_daily_totals` etc., correct after the migration) and direct reads of amounts must be restricted. Decide whether it's a real requirement.
- [ ] **Changing the exchange rate rewrites history.** Totals convert every past USD payment at **today's** rate. Store the rate (or the MXN amount) on each line when it's saved.
- [ ] **Saving an entry isn't atomic.** An edit runs 3 separate requests: update the visit, delete its lines, insert new lines. If the connection drops mid-way, lines can be lost. Move this to one `save_entry` database function (single transaction).
- [ ] **Patients are matched by name only.** Two different "Juan Pérez" merge into one patient, and a typo creates a new one. Consider phone or date of birth, or picking an existing patient from a list.
- [ ] **Performance.** Every screen downloads all visits. Fine for a few thousand; later, load by date range and use server-side totals.
- [ ] **Invites:**
  - codes never expire;
  - redeeming a code moves the user out of their current clinic (even a manager);
  - the join screen only works for brand-new accounts.
- [ ] The message shown to signed-in users without a clinic still says invitations are "coming in the next step". They exist now; point users to "Únete con un código".
- [ ] **CSV formula injection.** Prefix exported cells starting with `= + - @` with `'` so Excel doesn't run them as formulas.
- [ ] Defense in depth:
  - revoke `EXECUTE` on `public` functions from `anon`;
  - make sure an entry's lines and patient belong to the same clinic (composite foreign keys).
- [ ] File attachments (`entry_files` table and storage policies) exist in the schema but the app doesn't use them. Create the `entry-files` bucket as **private** before building that feature.
- [ ] **Automated tests.** The scripts in [Appendix D](#appendix-d--test-scripts-used-for-this-review) could go in the repo, with a GitHub Action, to catch regressions like these on every PR.

---

## 3. Team workflow

1. **Branch → pull request → review → merge.** Nobody pushes straight to `main`.
2. Netlify builds a **Deploy Preview** for every PR. Test there (against the dev database once you have one).
3. Merging to `main` deploys production automatically.
4. **Database changes** go in the same PR as a new numbered SQL file (`0004_…`, `0005_…`):
   - Never edit a migration that already ran; add a new one.
   - Run it on the dev project first.
   - Run it on production **before** merging if the front end depends on it. Otherwise production breaks until it's applied.
   - Write "Migration: yes/no, applied by ___ on ___" in the PR description.
5. **Never commit:**
   - the Supabase secret / `service_role` key;
   - the database password;
   - `.env` files.

   The publishable key in the HTML is fine.

| Service | Owned by today | Recommended |
|---|---|---|
| GitHub | one partner's personal account (public repo) | Praxia GitHub organization, ≥2 owners, `main` protected |
| Netlify | one partner's account (Free = 1 member) | team on a shared business email; Reviewers or Pro for partners |
| Supabase | one partner's account | Supabase organization with all partners, ≥2 Owners, Pro for backups |

---

## 4. Hosting: Netlify vs Vercel

**Recommendation: stay on Netlify. There's no reason to migrate.**

- Praxia is one static HTML file plus Supabase. Any static host serves it equally well, and nothing here uses a Vercel-specific feature.
- **Vercel's free (Hobby) plan is for personal, non-commercial use only.** Vercel defines commercial as any deployment that makes money for anyone involved, which Praxia is. Hobby also **doesn't support collaboration**: deploys triggered by commits from people other than the account owner are blocked. With several partners you'd need Vercel's paid Pro plan right away.
- Netlify Free covers you today. Watch its limits: **1 member**, **300 credits/month**, **15 credits per production deploy**, and the site **pauses** when credits run out. **Netlify Pro is $20/month flat with unlimited members** (since April 2026), which fits a small founding team well.
- When might Vercel make sense? Only if you rewrite the front end in Next.js and want Vercel-specific features. Netlify also supports Next.js, so even then it's a choice, not a requirement.
- Not on either platform's account: your data lives in **Supabase**, so changing hosts later just means deploying the HTML somewhere else.

---

## 5. How this was verified

- **Database.** The three existing SQL files plus the proposed migration were run on a local PostgreSQL 16 with a stand-in for Supabase's `auth` schema and default grants. Then a script acted as a receptionist, a manager, a user from another clinic and an anonymous caller, in three setups: current schema, upgrading with the migration, and fresh install with it. Every database bug in §1 reproduced on the current schema and was blocked after the migration, and normal flows still worked: sign-up, invite, rename, permission toggles.
- **Front end.** The current page and the page with [Appendix A](#appendix-a--front-end-fixes) applied were loaded in Chromium with the real `supabase-js 2.117.3`, against a fake Supabase API holding 2,500 visits and the 1,000-row cap, at 6:30 pm Tijuana time:

  | | Expected | Current `main` | With fix |
  |---|---|---|---|
  | Entries listed | 2,500 | 1,000 | 2,500 |
  | Default date of a new entry | 2026-10-17 | 2026-10-18 | 2026-10-17 |
  | Analytics total | $725,000 | $290,000 | $725,000 |
  | "FACO" revenue bar | $500,000 | $105,000 | $500,000 |
  | CSV rows / last date | 2,750 / Oct 17 | 1,100 / Jul 7 | 2,750 / Oct 17 |

- **Not verified:** the reviewer had no access to the production Supabase project or the Netlify site, so nothing has been applied anywhere real. The queries in §2 are how to confirm the migration once it's run.

### Sources (hosting & pricing, checked Oct 2026)

- Netlify: [credit-based plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) · [how credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) · [April 2026 pricing update (unlimited Pro seats)](https://www.netlify.com/changelog/2026-04-14-pricing-updates-april-2026/) · [legacy plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)
- Vercel: [Hobby plan](https://vercel.com/docs/plans/hobby) · [fair use guidelines (commercial usage)](https://vercel.com/docs/limits/fair-use-guidelines) · [community: Hobby doesn't support collaboration](https://community.vercel.com/t/vercel-hobby-plan-deployment-blocked-because-commit-author-lacks-access/35446)
- Supabase: [backups](https://supabase.com/docs/guides/platform/backups) · [pricing](https://supabase.com/pricing) · [free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) · [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)

---

## Appendix A — front-end fixes

A diff against `index (15).html` at `99276c0`. Either apply it, or make the same edits by hand (they're small).

**To apply:** save the block below as `frontend.diff` in the repo root, then run `git apply frontend.diff`. If the file has changed since `99276c0`, `git apply` will refuse rather than guess; use the list below instead.

**What it changes:**

1. **Pin the library:** `supabase-js@2` → `supabase-js@2.117.3` in the `<script src>`.
2. **Local date:** `todayISO()` builds `YYYY-MM-DD` from `getFullYear()/getMonth()/getDate()` instead of `toISOString()` (which is UTC).
3. **New `fetchAll(q)` helper:** pages with `.range()` until a request comes back empty. It's used in five places:
   - `renderEntries`
   - `renderCalendar`
   - `renderAnalytics`
   - both queries in `renderCRM`
   - `exportCSV`

   Each of those queries now ends with `.order("id")`, so the paging order is stable.
4. **Analytics per-service totals** use `toMXN(amount, itemMethod(e,it))`.
5. **CSV export** uses `itemMethod(e,it)` for the method column and the MXN conversion, and shows an error instead of silently exporting an empty file.

````diff
diff --git a/index (15).html b/index (15).html
--- a/index (15).html	
+++ b/index (15).html	
@@ -8,5 +8,5 @@
 <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
 <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
-<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
+<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3"></script>
 <style>
 :root{
@@ -365,6 +365,7 @@ h1,h2,h3,h4{font-family:var(--display);letter-spacing:-.01em}
 
 <script>
-// Replace with your own Supabase project URL and publishable (anon) key:
-    const SUPABASE_URL = "https://yqsgeywhilqrsombekce.supabase.co";
+// Supabase project URL + publishable key. Both are public by design: data is protected by
+// row-level security (supabase/migrations). Never put the secret / service_role key here.
+const SUPABASE_URL = "https://yqsgeywhilqrsombekce.supabase.co";
 const SUPABASE_KEY = "sb_publishable_U5Li7wfZ_ttx9wYlEnqSKQ_CjvQKbVB";
 const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
@@ -392,5 +393,9 @@ const fmtMXN=n=>"$"+Math.round(n).toLocaleString("es-MX");
 const initials=n=>(n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase();
 const parseDate=s=>{const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);};
-const todayISO=()=>new Date().toISOString().slice(0,10);
+// Local date, not UTC: toISOString() already reads "tomorrow" after ~5pm in Tijuana.
+const todayISO=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
+// Supabase returns at most 1000 rows per request ("Max rows"), so page until a request comes back empty.
+// `q` builds a fresh query each call; it needs a stable order (end with .order("id")).
+async function fetchAll(q){const out=[];for(;;){const {data,error}=await q().range(out.length,out.length+999);if(error)return {data:null,error};if(!data.length)return {data:out,error:null};out.push(...data);}}
 function toMXN(a,metodo){a=Number(a)||0;return /USD/i.test(metodo)?a*me.fx:a;}
 function itemMethod(e,it){return it.method||e.method;}
@@ -506,7 +511,7 @@ $("#menu-btn").onclick=openSide;$("#side-scrim").onclick=closeSide;
 async function renderEntries(){
   $("#content").innerHTML=`<div class="loading">Cargando entradas...</div>`;
-  const {data,error}=await sb.from("entries")
+  const {data,error}=await fetchAll(()=>sb.from("entries")
     .select("id,entry_date,status,method,card_type,invoice_no,notes,created_at,patients(name),entry_items(concepto,modificador,amount,method)")
-    .order("entry_date",{ascending:false}).order("created_at",{ascending:false});
+    .order("entry_date",{ascending:false}).order("created_at",{ascending:false}).order("id"));
   if(error){$("#content").innerHTML=`<div class="empty"><b>Error al cargar</b>${esc(error.message)}</div>`;return;}
   entriesCache=data||[];
@@ -563,7 +568,7 @@ function dailyTotals(){
 async function renderCalendar(){
   $("#content").innerHTML=`<div class="loading">Cargando calendario...</div>`;
-  const {data,error}=await sb.from("entries")
+  const {data,error}=await fetchAll(()=>sb.from("entries")
     .select("id,entry_date,status,method,card_type,invoice_no,notes,created_at,patients(name),entry_items(concepto,modificador,amount,method)")
-    .order("entry_date",{ascending:false}).order("created_at",{ascending:false});
+    .order("entry_date",{ascending:false}).order("created_at",{ascending:false}).order("id"));
   if(error){$("#content").innerHTML=`<div class="empty"><b>Error al cargar</b>${esc(error.message)}</div>`;return;}
   entriesCache=data||[];
@@ -703,5 +708,5 @@ $("#sheet-save").onclick=async()=>{
 async function renderAnalytics(){
   $("#content").innerHTML=`<div class="loading">Cargando analíticas...</div>`;
-  const {data,error}=await sb.from("entries").select("id,entry_date,method,patients(name),entry_items(concepto,amount,method)");
+  const {data,error}=await fetchAll(()=>sb.from("entries").select("id,entry_date,method,patients(name),entry_items(concepto,amount,method)").order("id"));
   if(error){$("#content").innerHTML=`<div class="empty"><b>Error</b>${esc(error.message)}</div>`;return;}
   const es=data||[];
@@ -709,5 +714,5 @@ async function renderAnalytics(){
   const pac=new Set(es.map(e=>((e.patients&&e.patients.name)||"").toLowerCase()).filter(Boolean)).size;
   const ticket=es.length?total/es.length:0;
-  const byC={};es.forEach(e=>(e.entry_items||[]).forEach(it=>{if(it.concepto)byC[it.concepto]=(byC[it.concepto]||0)+(Number(it.amount)||0);}));
+  const byC={};es.forEach(e=>(e.entry_items||[]).forEach(it=>{if(it.concepto)byC[it.concepto]=(byC[it.concepto]||0)+toMXN(Number(it.amount)||0,itemMethod(e,it));}));
   const byCount={};es.forEach(e=>[...new Set((e.entry_items||[]).map(it=>it.concepto).filter(Boolean))].forEach(c=>byCount[c]=(byCount[c]||0)+1));
   const concepts=Object.entries(byC).sort((a,b)=>b[1]-a[1]).slice(0,8),maxC=Math.max(1,...concepts.map(c=>c[1]));
@@ -747,6 +752,6 @@ async function renderCRM(){
   $("#content").innerHTML=`<div class="loading">Cargando pacientes...</div>`;
   const [{data:pats,error:perr},{data:ents}]=await Promise.all([
-    sb.from("patients").select("id,name,created_at"),
-    sb.from("entries").select("id,patient_id,entry_date,method,entry_items(concepto,amount,method)")
+    fetchAll(()=>sb.from("patients").select("id,name,created_at").order("id")),
+    fetchAll(()=>sb.from("entries").select("id,patient_id,entry_date,method,entry_items(concepto,amount,method)").order("id"))
   ]);
   if(perr){$("#content").innerHTML=`<div class="empty"><b>Error</b>${esc(perr.message)}</div>`;return;}
@@ -891,7 +896,8 @@ async function setPersonal(){
 }
 async function exportCSV(){
-  const {data}=await sb.from("entries").select("entry_date,status,method,card_type,invoice_no,notes,patients(name),entry_items(concepto,modificador,amount,method)").order("entry_date");
+  const {data,error}=await fetchAll(()=>sb.from("entries").select("id,entry_date,status,method,card_type,invoice_no,notes,patients(name),entry_items(concepto,modificador,amount,method)").order("entry_date").order("id"));
+  if(error){toast("Error: "+error.message,true);return;}
   const head=["Fecha","Paciente","Estatus","Metodo","TipoTarjeta","Concepto","Modificador","Monto","MontoMXN","Factura","Notas"];
-  const rows=[];(data||[]).forEach(e=>{(e.entry_items||[]).forEach(it=>rows.push([e.entry_date,(e.patients&&e.patients.name)||"",e.status,e.method,e.card_type||"",it.concepto,it.modificador||"",it.amount,Math.round(toMXN(it.amount,e.method)),e.invoice_no||"",(e.notes||"").replace(/\n/g," ")]));});
+  const rows=[];(data||[]).forEach(e=>{(e.entry_items||[]).forEach(it=>{const m=itemMethod(e,it);rows.push([e.entry_date,(e.patients&&e.patients.name)||"",e.status,m,e.card_type||"",it.concepto,it.modificador||"",it.amount,Math.round(toMXN(it.amount,m)),e.invoice_no||"",(e.notes||"").replace(/\n/g," ")]);});});
   const csv=[head,...rows].map(r=>r.map(c=>`"${String(c==null?"":c).replace(/"/g,'""')}"`).join(",")).join("\n");
   const b=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download="registro_praxia.csv";a.click();URL.revokeObjectURL(u);toast("CSV exportado");
````

## Appendix B — database migration (`0004_security_hardening.sql`)

Run it in Supabase → SQL Editor → New query → paste → Run. It requires `0001`–`0003`. Then run the two checks in [§2](#2-checklist). Keep a copy in the repo next to the other SQL files, as `0004_security_hardening.sql`.

````sql
-- ============================================================================
-- Praxia · Registro — security hardening
-- Requires 0001–0003. Changes permissions and functions only; no data changes.
-- Run in: Supabase Studio → SQL Editor → New query → paste → Run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) profiles: a member may only edit their own display_name.
-- profile_self_update allowed every column, so any reception user could run
--   update profiles set role = 'manager' where id = auth.uid()
-- from the browser console and become a manager. role / clinic_id now change
-- only through bootstrap_clinic / accept_invite (SECURITY DEFINER, unaffected).
-- ----------------------------------------------------------------------------
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ----------------------------------------------------------------------------
-- 2) Fail closed when the caller has no profile.
-- has_cap() returned NULL and `current_role_name() <> 'manager'` evaluated to
-- NULL, so the `if not ...` / `if ... <> ...` guards silently did not raise.
-- ----------------------------------------------------------------------------
create or replace function public.has_cap(cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when p.role = 'manager' then true
      else coalesce((s.recepcion_caps ->> cap)::boolean, false)
    end
    from public.profiles p
    join public.clinic_settings s on s.clinic_id = p.clinic_id
    where p.id = auth.uid()
  ), false);
$$;

create or replace function public.set_recepcion_caps(p_caps jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'manager' then raise exception 'no_permission: manager only'; end if;
  update public.clinic_settings
     set recepcion_caps = p_caps, updated_at = now()
   where clinic_id = public.current_clinic_id();
end; $$;

-- ----------------------------------------------------------------------------
-- 3) Invites: only managers can list codes; codes are longer; a code can't be
-- redeemed twice by two people signing up at the same moment.
-- ----------------------------------------------------------------------------
drop policy if exists inv_read on public.invites;
create policy inv_read on public.invites
  for select using (clinic_id = public.current_clinic_id() and public.current_role_name() = 'manager');

create or replace function public.create_invite(p_role text default 'recepcion')
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if public.current_role_name() is distinct from 'manager' then raise exception 'no_permission: manager only'; end if;
  if p_role not in ('manager','recepcion') then raise exception 'bad_role'; end if;
  -- 8 hex chars (~4.3 billion codes) instead of 6 (~16.7 million), so guessing is impractical.
  c := upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8));
  insert into public.invites(code, clinic_id, role, created_by)
    values (c, public.current_clinic_id(), p_role, auth.uid());
  return c;
end; $$;

create or replace function public.accept_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select * into inv from public.invites
   where code = upper(trim(p_code)) and used_at is null
   for update;
  if not found then raise exception 'invalid_or_used_code'; end if;
  update public.profiles set clinic_id = inv.clinic_id, role = inv.role where id = auth.uid();
  if not found then
    insert into public.profiles(id, clinic_id, role) values (auth.uid(), inv.clinic_id, inv.role);
  end if;
  update public.invites set used_at = now(), used_by = auth.uid() where code = inv.code;
  return inv.clinic_id;
end; $$;

-- ----------------------------------------------------------------------------
-- 4) Server-side totals: only the caller's clinic, and each line's own payment
-- method (split payments, 0003). entry_mxn() used to return the total of ANY
-- entry in ANY clinic given its id, and all four still used the visit-level
-- method, so a USD line inside an MXN visit was counted as pesos.
-- ----------------------------------------------------------------------------
create or replace function public.entry_mxn(p_entry uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(ei.amount * case when coalesce(ei.method, e.method) ilike '%USD%' then s.fx_rate else 1 end), 0)
  from public.entries e
  join public.entry_items ei on ei.entry_id = e.id
  join public.clinic_settings s on s.clinic_id = e.clinic_id
  where e.id = p_entry
    and e.clinic_id = public.current_clinic_id();
$$;

create or replace function public.get_daily_totals(p_month date)
returns table (day date, entries int, patients int, total_mxn numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_cap('dailyTotals') then raise exception 'no_permission: dailyTotals'; end if;
  return query
    select e.entry_date,
           count(distinct e.id)::int,
           count(distinct e.patient_id)::int,
           coalesce(sum(ei.amount * case when coalesce(ei.method, e.method) ilike '%USD%' then s.fx_rate else 1 end),0)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and date_trunc('month', e.entry_date) = date_trunc('month', p_month)
    group by e.entry_date
    order by e.entry_date;
end; $$;

create or replace function public.get_monthly_total(p_month date)
returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_cap('monthlyTotals') then raise exception 'no_permission: monthlyTotals'; end if;
  return coalesce((
    select sum(ei.amount * case when coalesce(ei.method, e.method) ilike '%USD%' then s.fx_rate else 1 end)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and date_trunc('month', e.entry_date) = date_trunc('month', p_month)
  ), 0);
end; $$;

create or replace function public.get_revenue_by_concepto(p_from date, p_to date)
returns table (concepto text, total_mxn numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_cap('analytics') then raise exception 'no_permission: analytics'; end if;
  return query
    select ei.concepto,
           coalesce(sum(ei.amount * case when coalesce(ei.method, e.method) ilike '%USD%' then s.fx_rate else 1 end),0)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and e.entry_date between p_from and p_to
    group by ei.concepto
    order by 2 desc;
end; $$;
````

## Appendix C — repo layout (optional)

Best done **after** the bug fixes are merged, in its own PR:

```
mkdir -p public supabase/migrations
git mv "index (15).html" public/index.html
git mv 0001_init.sql supabase/migrations/0001_init.sql
git mv "0002_invites (1).sql" supabase/migrations/0002_invites.sql
git mv 0003_split_payments.sql supabase/migrations/0003_split_payments.sql
git mv 0004_security_hardening.sql supabase/migrations/0004_security_hardening.sql   # if added
```

Add `netlify.toml` **in the same commit** as moving the HTML into `public/`. It tells Netlify to serve that folder, so it's what keeps the site working at `/`:

````toml
# Netlify reads this on every deploy and it overrides the build settings in the Netlify UI.
# No build step: the app is the single static file public/index.html.
[build]
  publish = "public"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
````

`.gitignore`:

````
# OS / editor
.DS_Store
Thumbs.db
.vscode/
.idea/

# Secrets — never commit these (the Supabase *publishable* key in index.html is fine)
.env
.env.*

# Tooling
node_modules/
.netlify/
supabase/.branches/
supabase/.temp/
````

Also update the README:
- point it at the new paths;
- replace "the Supabase URL and key are placeholders" with: the URL and **publishable** key are meant to be public, data is protected by RLS, and the secret / `service_role` key must never be committed.

## Appendix D — test scripts used for this review

These reproduce the verification in [§5](#5-how-this-was-verified). They need PostgreSQL 16, Node 22 and Playwright with Chromium. They contain absolute paths from the review machine (the `S=`, `D=` and `M=` variables and the paths in `e2e.js`), so adjust those first.

- `run_scenario.sh before|upgrade|fresh` builds a scratch database from `supabase_mock.sql` and the migrations, loads `fixtures.sql`, and runs `attacks.sql`.
- `node e2e.js <path-to-html>` drives the page against a fake API and prints the numbers in the §5 table.

<details><summary><code>supabase_mock.sql</code>: stand-in for Supabase's auth/storage schemas and default grants</summary>

````sql
-- Minimal stand-in for the parts of Supabase the Praxia migrations depend on.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  ), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts,1)-1];
end $$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;

-- Supabase's default grants on the public schema.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
````
</details>

<details><summary><code>fixtures.sql</code>: two clinics, a manager, a receptionist, one entry each</summary>

````sql
-- Two clinics: A (manager + receptionist) and B (manager), one entry each.
\set A_MGR '''aaaaaaaa-0000-0000-0000-000000000001'''
\set A_REC '''aaaaaaaa-0000-0000-0000-000000000002'''
\set B_MGR '''bbbbbbbb-0000-0000-0000-000000000001'''

insert into auth.users(id,email) values
  (:A_MGR,'a-mgr@x'),(:A_REC,'a-rec@x'),(:B_MGR,'b-mgr@x');

-- clinic A manager bootstraps
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_MGR)::text, false);
select public.bootstrap_clinic('Clinic A','Dra. A') as clinic_a \gset
select public.create_invite('recepcion') as code_a \gset
insert into public.patients(clinic_id,name,name_key) values (:'clinic_a','Paciente A','paciente a') returning id as pat_a \gset
insert into public.entries(clinic_id,patient_id,entry_date,status,method) values (:'clinic_a',:'pat_a','2026-10-01','Completo','Pesos (MXN)') returning id as ent_a \gset
insert into public.entry_items(entry_id,clinic_id,concepto,amount,method) values (:'ent_a',:'clinic_a','FACO',25000,'Pesos (MXN)');
reset role;

-- clinic A receptionist joins with the invite code
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
select public.accept_invite(:'code_a');
update public.profiles set display_name='Recepción A' where id = auth.uid();
reset role;

-- clinic B manager bootstraps
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:B_MGR)::text, false);
select public.bootstrap_clinic('Clinic B','Dr. B') as clinic_b \gset
insert into public.patients(clinic_id,name,name_key) values (:'clinic_b','Paciente B','paciente b') returning id as pat_b \gset
insert into public.entries(clinic_id,patient_id,entry_date,status,method) values (:'clinic_b',:'pat_b','2026-10-02','Completo','Dolares (USD)') returning id as ent_b \gset
insert into public.entry_items(entry_id,clinic_id,concepto,amount,method) values (:'ent_b',:'clinic_b','LASER YAG',500,'Dolares (USD)');
reset role;

-- B's ids, for the attacker scenarios (an attacker would need to learn these)
select :'clinic_b' as clinic_b_id \gset
select :'ent_b' as ent_b_id \gset
\echo fixtures: clinic_a=:clinic_a clinic_b=:clinic_b
select p.display_name, p.role, c.name as clinic from public.profiles p join public.clinics c on c.id=p.clinic_id order by 1;
select set_config('t.clinic_b', :'clinic_b', false) is not null as _c, set_config('t.code_a', :'code_a', false) is not null as _k \gset
````
</details>

<details><summary><code>attacks.sql</code>: the permission checks from §1</summary>

````sql
-- Run after fixtures.sql in the same psql session (uses its \gset vars).
\echo
\echo ===== [1] Receptionist promotes herself to manager via direct profiles UPDATE
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
do $$ begin update public.profiles set role='manager' where id = auth.uid(); exception when others then raise notice '[1] update rejected: %', sqlerrm; end $$;
select public.current_role_name() as "[1] a_rec_role_after";
reset role;
update public.profiles set role='recepcion' where id = :A_REC;

\echo
\echo ===== [2] Clinic A receptionist moves herself into clinic B (needs the B uuid)
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
do $$ begin update public.profiles set clinic_id = current_setting('t.clinic_b')::uuid where id = auth.uid(); exception when others then raise notice '[2] update rejected: %', sqlerrm; end $$;
select (select name from public.clinics) as "[2] reading_clinic";
reset role;
update public.profiles set clinic_id = :'clinic_a', role='recepcion' where id = :A_REC;

\echo
\echo ===== [2b] Brand-new signup with no clinic tries to set clinic_id to B
insert into auth.users(id,email) values ('cccccccc-0000-0000-0000-000000000001','new@x');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000001"}', false);
do $$ begin update public.profiles set clinic_id = current_setting('t.clinic_b')::uuid, role='manager' where id = auth.uid(); exception when others then raise notice '[2b] update rejected: %', sqlerrm; end $$;
select public.current_clinic_id() is not null as "[2b] got_into_a_clinic";
reset role;

\echo
\echo ===== [3] Clinic A manager reads a clinic B entry total via entry_mxn()
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_MGR)::text, false);
select public.entry_mxn(:'ent_b_id') as "[3] clinic_b_total_seen_by_a";
reset role;

\echo
\echo ===== [4] Receptionist lists unused invite codes
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_MGR)::text, false);
select public.create_invite('recepcion') as new_code \gset
select length(:'new_code') as "[4] new_code_length";
select count(*) as "[4] codes_visible_to_manager" from public.invites where used_at is null;
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
select count(*) as "[4] codes_visible_to_receptionist" from public.invites where used_at is null;
do $$ begin perform public.create_invite('manager'); raise notice '[4] receptionist created an invite!'; exception when others then raise notice '[4] receptionist create_invite rejected: %', sqlerrm; end $$;
reset role;

\echo
\echo ===== [5] Receptionist with analytics/monthlyTotals OFF reading amounts (UI-only gate; expected to remain readable)
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
select public.has_cap('analytics') as analytics_cap, (select sum(amount) from public.entry_items) as "[5] amounts_readable";
do $$ begin perform public.get_monthly_total('2026-10-01'); raise notice '[5] get_monthly_total allowed'; exception when others then raise notice '[5] get_monthly_total rejected: %', sqlerrm; end $$;
reset role;

\echo
\echo ===== [6] Anonymous caller: manager-only RPCs
set role anon;
select set_config('request.jwt.claims', '', false);
do $$ begin perform public.set_recepcion_caps('{"analytics":true}'::jsonb); raise notice '[6] set_recepcion_caps: guard did NOT fire'; exception when others then raise notice '[6] set_recepcion_caps rejected: %', sqlerrm; end $$;
do $$ begin perform public.get_monthly_total('2026-10-01'); raise notice '[6] get_monthly_total: guard did NOT fire'; exception when others then raise notice '[6] get_monthly_total rejected: %', sqlerrm; end $$;
do $$ begin perform public.accept_invite('XXXX'); exception when others then raise notice '[6] accept_invite rejected: %', sqlerrm; end $$;
reset role;

\echo
\echo ===== [7] Split payment (MXN 1000 + USD 50 at 18.5) server-side totals; expected 1925
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_MGR)::text, false);
insert into public.entries(clinic_id,patient_id,entry_date,status,method) values (:'clinic_a',:'pat_a','2026-09-15','Completo','Pesos (MXN)') returning id as ent_split \gset
insert into public.entry_items(entry_id,clinic_id,concepto,amount,method) values
  (:'ent_split',:'clinic_a','FACO',1000,'Pesos (MXN)'), (:'ent_split',:'clinic_a','FACO',50,'Dolares (USD)');
select public.entry_mxn(:'ent_split') as "[7] entry_mxn",
       public.get_monthly_total('2026-09-01') as "[7] monthly_total",
       (select total_mxn from public.get_daily_totals('2026-09-01')) as "[7] daily_total";
reset role;

\echo
\echo ===== [8] Normal flows: rename self, manager toggles caps, used code can't be reused
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
update public.profiles set display_name='Recepción A (renamed)' where id = auth.uid();
select display_name as "[8] rec_display_name" from public.profiles where id = auth.uid();
select count(*) as "[8] rec_sees_entries" from public.entries;
select set_config('request.jwt.claims', json_build_object('sub',:A_MGR)::text, false);
select public.set_recepcion_caps('{"analytics":true}'::jsonb);
select set_config('request.jwt.claims', json_build_object('sub',:A_REC)::text, false);
select public.has_cap('analytics') as "[8] rec_analytics_after_manager_toggle";
reset role;
insert into auth.users(id,email) values ('dddddddd-0000-0000-0000-000000000001','late@x');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-000000000001"}', false);
do $$ begin perform public.accept_invite(current_setting('t.code_a')); raise notice '[8] reused code accepted!'; exception when others then raise notice '[8] reused code rejected: %', sqlerrm; end $$;
reset role;
````
</details>

<details><summary><code>run_scenario.sh</code>: runs the three database scenarios</summary>

````bash
#!/bin/bash
# usage: run_scenario.sh before|upgrade|fresh
S=/tmp/claude-0/-home-user-Praxia/cb4e3828-21b2-5a8e-8b86-0e2731b56f73/scratchpad
D=/var/lib/postgresql/praxia-test; M=/home/user/Praxia/supabase/migrations
P="psql -h $D -p 5499 -U postgres -q -X"
$P -c "drop database if exists praxia" -c "create database praxia" 2>/dev/null
apply() { $P -d praxia -v ON_ERROR_STOP=1 -f "$1" >/dev/null 2>$S/err.txt || { echo "FAILED applying $1"; cat $S/err.txt; exit 1; }; }
apply $S/supabase_mock.sql
apply $M/0001_init.sql; apply $M/0002_invites.sql; apply $M/0003_split_payments.sql
case $1 in
  before)  cat $S/fixtures.sql $S/attacks.sql > $S/run.sql ;;
  upgrade) cat $S/fixtures.sql > $S/run.sql; echo "\\i $M/0004_security_hardening.sql" >> $S/run.sql; cat $S/attacks.sql >> $S/run.sql ;;
  fresh)   apply $M/0004_security_hardening.sql; cat $S/fixtures.sql $S/attacks.sql > $S/run.sql ;;
esac
$P -d praxia -f $S/run.sql 2>&1 | grep -E '^=====|\[[0-9]b?\]|^ +[^ -].*$|ERROR|FATAL|NOTICE' | grep -v -E 'set_config|^ +\{|^ +_c|^ +t +\| t' 
````
</details>

<details><summary><code>e2e.js</code>: browser test (2,500 visits, 1,000-row cap, Tijuana time)</summary>

````js
// Drive index.html in Chromium with the real supabase-js against a fake Supabase API.
// Usage: node e2e.js <path-to-index.html>
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(process.argv[2], 'utf8');
const SBJS = fs.readFileSync(path.join(__dirname, 'vendor/sbjs/package/dist/umd/supabase.js'), 'utf8');
const SB = 'https://yqsgeywhilqrsombekce.supabase.co';
const MAX_ROWS = 1000;             // Supabase default "Max rows"
const FX = 20;
const NOW = new Date('2026-10-18T01:30:00Z'); // 6:30 pm on Oct 17 in Tijuana (PDT)

// ---- dataset: 2,500 visits; every 10th is a split payment (MXN line + USD line) ----
const entries = [];
const start = Date.UTC(2026, 4, 1);
for (let i = 0; i < 2500; i++) {
  const d = new Date(start + Math.floor(i * 170 / 2500) * 86400000).toISOString().slice(0, 10);
  const split = i % 10 === 0;
  entries.push({
    id: 'e' + String(i).padStart(5, '0'), entry_date: d, status: 'Completo', method: 'Pesos (MXN)',
    card_type: null, invoice_no: null, notes: null, created_at: d + 'T12:00:00Z',
    patient_id: 'p' + (i % 300), patients: { name: 'Paciente ' + (i % 300) },
    entry_items: split
      ? [{ concepto: 'FACO', modificador: null, amount: 1000, method: 'Pesos (MXN)' },
         { concepto: 'FACO', modificador: null, amount: 50, method: 'Dolares (USD)' }]
      : [{ concepto: 'REV', modificador: null, amount: 100, method: 'Pesos (MXN)' }],
  });
}
entries.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || a.id.localeCompare(b.id));
const toMXN = it => /USD/i.test(it.method) ? it.amount * FX : it.amount;
const EXPECTED_TOTAL = entries.reduce((s, e) => s + e.entry_items.reduce((t, it) => t + toMXN(it), 0), 0);
const EXPECTED_ITEMS = entries.reduce((s, e) => s + e.entry_items.length, 0);
const patients = [...Array(300)].map((_, i) => ({ id: 'p' + i, name: 'Paciente ' + i, created_at: '2026-05-01T00:00:00Z' }));
const cats = ['REV', 'FACO'].map((l, i) => ({ id: 'c' + i, kind: 'concepto', label: l, sort_order: i }))
  .concat(['Completo'].map(l => ({ id: 'cs', kind: 'estatus', label: l, sort_order: 0 })))
  .concat(['Pesos (MXN)', 'Dolares (USD)'].map((l, i) => ({ id: 'cm' + i, kind: 'metodo', label: l, sort_order: i })));

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const USER = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'dra@test.mx' };
const JWT = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', role: 'authenticated', aud: 'authenticated', exp: 1900000000 }) + '.sig';
const SESSION = { access_token: JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 1900000000, user: USER };

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
let requests = 0;

async function api(route) {
  const req = route.request(), u = new URL(req.url());
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  requests++;
  const json = (body, extra = {}) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  if (u.pathname === '/auth/v1/user') return json(USER);
  const table = u.pathname.replace('/rest/v1/', '');
  const single = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
  const page = rows => {
    const off = +(u.searchParams.get('offset') || 0);
    const lim = Math.min(+(u.searchParams.get('limit') || Infinity), MAX_ROWS);
    const out = rows.slice(off, off + lim);
    return json(out, { 'content-range': `${off}-${off + out.length - 1}/*` });
  };
  switch (table) {
    case 'profiles': return json(single ? { role: 'manager', clinic_id: 'cl1', display_name: 'Dra. Test' } : [{ display_name: 'Dra. Test', role: 'manager' }]);
    case 'clinics': return json({ name: 'Consultorio Test' });
    case 'clinic_settings': return json({ fx_rate: FX, recepcion_caps: {} });
    case 'categories':
      if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `0-${cats.length - 1}/${cats.length}` } });
      return json(cats);
    case 'entries': return page(/^entry_date\.asc/.test(u.searchParams.get('order') || '') ? [...entries].reverse() : entries);
    case 'patients': return page(patients);
    case 'invites': return json([]);
    default: return json([]);
  }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: 'America/Tijuana', acceptDownloads: true });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));
  await pg.clock.setFixedTime(NOW);
  await pg.route('https://praxia.test/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await pg.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: SBJS }));
  await pg.route(SB + '/**', api);
  await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-yqsgeywhilqrsombekce-auth-token', JSON.stringify(SESSION)]);

  const res = { expected: { total_mxn: EXPECTED_TOTAL, entries: entries.length, csv_rows: EXPECTED_ITEMS, today: '2026-10-17' } };
  await pg.goto('https://praxia.test/');
  await pg.waitForSelector('.erow', { timeout: 15000 });
  res.entries_listed = await pg.locator('.erow').count();

  await pg.click('#btn-new');
  res.new_entry_default_date = await pg.inputValue('#i-fecha');
  await pg.click('#sheet-cancel');

  await pg.click('#nav [data-view="calendar"]');
  await pg.waitForSelector('.cal-grid');
  res.calendar_today_cell = await pg.getAttribute('.cal-cell.today', 'data-day').catch(() => null);

  await pg.click('#nav [data-view="analytics"]');
  await pg.waitForSelector('.grid-stats');
  res.analytics_total_text = await pg.locator('.stat .val').first().innerText();
  res.analytics_faco_bar = await pg.locator('.bar-row', { hasText: 'FACO' }).locator('.bar-val').innerText().then(t => t.split('\n')[0]);
  res.expected.faco_bar = '$' + entries.reduce((s, e) => s + e.entry_items.filter(i => i.concepto === 'FACO').reduce((t, it) => t + toMXN(it), 0), 0).toLocaleString('en-US');

  await pg.click('#nav [data-view="settings"]');
  await pg.click('[data-st="datos"]');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#exp-csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split('\n').slice(1)
    .map(l => l.split('","').map(c => c.replace(/^"|"$/g, '')));
  res.csv_rows = csv.length;
  res.csv_sum_montomxn = csv.reduce((s, r) => s + Number(r[8]), 0);
  res.csv_last_date = csv.length ? csv[csv.length - 1][0] : null;
  res.expected.csv_last_date = entries[0].entry_date;

  res.page_errors = errors;
  res.api_requests = requests;
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
````
</details>
