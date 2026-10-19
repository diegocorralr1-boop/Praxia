# Contributing

## Workflow

1. Branch from `main` (`git checkout -b feature/short-name origin/main`). Nobody pushes to `main` directly.
2. Make the change. Keep database changes in a **new** numbered migration (`0008_what_it_does.sql`); never edit one that has run in production.
3. Run `npm run check` locally (see below). Fix everything it reports.
4. Open a pull request; fill in the template (migration applied? tests? privacy?). CI must be green. Test on the Netlify Deploy Preview.
5. One review, then merge. Merging deploys production.
6. If the PR includes a migration, apply it in production **before** merging when the front end depends on it (the app degrades gracefully when a migration is missing, but don't rely on that for long).

## Local setup

```bash
npm install                       # dev tools only; the app itself has no dependencies
npm run serve                     # http://localhost:8888 (uses config.js → development project if filled in)
npm run lint                      # ESLint on app.js, config.js, legal*.js, tests, scripts
npm run check:html                # every referenced file exists, no inline scripts, CDN scripts pinned + SRI
PGURL=postgres://postgres:postgres@localhost:5432/postgres npm run test:sql   # needs a local Postgres 16
npm run test:e2e                  # Playwright + Chromium (npx playwright install chromium once;
                                  # or PRAXIA_CHROMIUM=/path/to/chrome to use a browser you already have)
npm run check                     # all of the above
```

Local Postgres without installing anything: `docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`.

## Writing tests

- **SQL** (`tests/sql/test_*.sql`): each file runs inside one transaction against a fresh database with every migration applied and a stand-in `auth` schema. Use `tests.ok(condition, 'message')` and `tests.raises($$sql$$, 'expected error fragment', 'message')`. Switch identity with the `:login` macro (`\set who <uuid>` / `\set mail <email>`), and `reset role` afterwards. A failing assertion fails CI.
- **Browser** (`tests/e2e/*.test.js`): drive `index.html` in Chromium with the real CSP and the real `supabase-js`, against a fake API. Add a scenario, record what the app must do, and assert on it at the end of the file.

## Conventions

- The app is plain browser JavaScript with no build step: `app.js` runs as-is. Keep it that way until the roadmap's "modular front end" step lands; don't add a bundler for one file.
- All authorization lives in Postgres (RLS + `SECURITY DEFINER` functions). Never gate data access only in the UI.
- Never commit the Supabase `service_role` key, database passwords or `.env` files. The publishable key is fine.
- Legal texts: changing them means bumping `version` in `legal-config.js`, which makes every user re-accept.
- Spanish in the UI and legal documents; English in code comments, commit messages and engineering docs.
