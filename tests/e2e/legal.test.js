// Browser tests: legal/privacy features of index.html (consent, ARCO actions, idle logout, password reset, legal pages).
// End-to-end checks of the legal/privacy features in index.html against a fake Supabase API,
// served with the CSP from netlify.toml. Usage: node e2e_legal.js
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SBJS = fs.readFileSync(path.join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
const SB = 'https://yqsgeywhilqrsombekce.supabase.co';
const _sb = { window: {} }; require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'legal-config.js'), 'utf8'), _sb); const TERMS = _sb.window.PRAXIA_LEGAL.version;
const CSP = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)[1];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2', '.md': 'text/markdown', '.txt': 'text/plain' };

const USER = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'dra@test.mx', user_metadata: {} };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', role: 'authenticated', aud: 'authenticated', email: 'dra@test.mx', exp: 1900000000 }) + '.sig';
const SESSION = { access_token: JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 1900000000, user: USER };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };

const entries = [
  { id: 'e1', entry_date: '2026-10-17', status: 'Completo', method: 'Pesos (MXN)', card_type: null, invoice_no: null, notes: 'nota', created_at: '2026-10-17T12:00:00Z', fx_rate: 18.5, patient_id: 'p1', patients: { name: 'Juan Pérez', phone: '6641234567' }, entry_items: [{ concepto: 'FACO', modificador: null, amount: 25000, method: 'Pesos (MXN)', currency: 'MXN' }, { concepto: 'FACO', modificador: null, amount: 50, method: 'Dolares (USD)', currency: 'USD' }] },
  { id: 'e2', entry_date: '2026-10-16', status: 'Completo', method: 'Pesos (MXN)', card_type: null, invoice_no: null, notes: null, created_at: '2026-10-16T12:00:00Z', fx_rate: 18.5, patient_id: 'p2', patients: { name: 'María López', phone: null }, entry_items: [{ concepto: 'REV', modificador: null, amount: 500, method: 'Pesos (MXN)', currency: 'MXN' }] },
];
const patients = [{ id: 'p1', name: 'Juan Pérez', created_at: '2026-05-01T00:00:00Z' }, { id: 'p2', name: 'María López', created_at: '2026-05-01T00:00:00Z' }];
const cats = [['concepto', 'REV'], ['concepto', 'FACO'], ['estatus', 'Completo'], ['metodo', 'Pesos (MXN)'], ['metodo', 'Dolares (USD)']].map(([k, l], i) => ({ id: 'c' + i, kind: k, label: l, sort_order: i, currency: /USD/.test(l) ? 'USD' : 'MXN' }));

function makeApi(state) {
  return async route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const noContent = () => route.fulfill({ status: 204, headers: CORS });
    state.calls.push(req.method() + ' ' + u.pathname + (u.search ? '?' + decodeURIComponent(u.search) : ''));
    if (u.pathname === '/auth/v1/user' && req.method() === 'GET') return json({ ...USER, user_metadata: state.metadata || {} });
    if (u.pathname === '/auth/v1/user' && req.method() === 'PUT') { state.userUpdate = req.postDataJSON(); return json(USER); }
    if (u.pathname === '/auth/v1/logout') { state.loggedOut = true; return noContent(); }
    if (u.pathname === '/auth/v1/recover') { state.recover = req.postDataJSON(); return json({}); }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.slice('/rest/v1/rpc/'.length); state.rpc.push([fn, req.postDataJSON()]);
      if (state.preMigration) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache`, hint: null, details: null }, 404);
      if (fn === 'my_account_state') return json({ status: 'active', role: 'manager', display_name: 'Dra. Test', terms_version: state.termsVersion === undefined ? null : state.termsVersion, email_confirmed: true, is_admin: false, clinic: { id: 'cl1', name: 'Consultorio Test', status: 'active', is_owner: true }, fx_rate: 18.5, caps: {}, pending: {}, onboarding_error: null });
      if (fn === 'export_my_data') return json({ account: { id: 'u1', email: 'dra@test.mx' }, profile: { role: 'manager' } });
      if (fn === 'anonymize_patient') { patients[0].name = 'Paciente eliminado 1a2b3c4d'; entries[0].patients.name = patients[0].name; return noContent(); }
      return noContent();
    }
    const table = u.pathname.replace('/rest/v1/', '');
    const single = /vnd\.pgrst\.object/.test(req.headers()['accept'] || '');
    switch (table) {
      case 'profiles': {
        const sel = u.searchParams.get('select') || '';
        if (sel === 'terms_version') {
          if (state.preMigration) return json({ code: '42703', message: 'column profiles.terms_version does not exist', hint: null, details: null }, 400);
          return json({ terms_version: state.termsVersion });
        }
        return json(single ? { role: 'manager', clinic_id: 'cl1', display_name: 'Dra. Test' } : [{ role: 'manager', clinic_id: 'cl1', display_name: 'Dra. Test' }]);
      }
      case 'clinics': return json({ name: 'Consultorio Test' });
      case 'clinic_settings': return json({ fx_rate: 18.5, recepcion_caps: {} });
      case 'categories':
        if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `0-${cats.length - 1}/${cats.length}` } });
        return json(cats);
      case 'entries': return json(u.searchParams.get('patient_id') ? entries.filter(e => 'eq.' + e.patient_id === u.searchParams.get('patient_id')) : entries);
      case 'patients': return json(patients);
      case 'entry_audit': return json([]);
      case 'invites': return json([]);
      case 'privacy_log':
        if (state.preMigration) return json({ code: '42P01', message: 'relation "public.privacy_log" does not exist' }, 404);
        return json([{ action: 'terms_accepted', at: '2026-10-17T18:00:00Z', actor_name: 'Dra. Test', details: { version: TERMS } }, { action: 'patient_anonymized', at: '2026-10-16T18:00:00Z', actor_name: 'Recepción', details: {} }]);
      default: return json([]);
    }
  };
}

async function openApp(browser, state, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Tijuana', acceptDownloads: true });
  const page = await ctx.newPage();
  state.calls = []; state.rpc = []; state.errors = []; state.csp = []; state.console = [];
  page.on('pageerror', e => state.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') state.console.push(m.text()); });
  page.on('dialog', d => { state.dialog = d.message(); d.type() === 'prompt' ? d.accept(opts.promptAnswer || '') : d.accept(); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await page.clock.install({ time: new Date('2026-10-18T01:30:00Z') });
  // Serve the repo at https://praxia.test with the real CSP header from netlify.toml.
  await page.route('https://praxia.test/**', r => {
    const p = decodeURIComponent(new URL(r.request().url()).pathname); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: 'not found' });
    r.fulfill({ status: 200, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'content-security-policy': CSP }, body: fs.readFileSync(f) });
  });
  await page.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[0-9.]+\/dist\/umd\/supabase\.js/, r => r.fulfill({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body: SBJS }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => { state.googleFonts = true; r.abort(); });
  await page.route(SB + '/**', makeApi(state));
  if (opts.session !== false) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-yqsgeywhilqrsombekce-auth-token', JSON.stringify(SESSION)]);
  await page.goto('https://praxia.test/' + (opts.urlSuffix || ''));
  return { ctx, page };
}

const results = {};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PRAXIA_CHROMIUM || undefined }); // PRAXIA_CHROMIUM: optional path to a local Chromium (CI installs its own)

  // A. Terms already accepted: app loads straight in, no Google requests, fonts from self, no CSP violations.
  { const st = { termsVersion: TERMS }; const { ctx, page } = await openApp(browser, st);
    await page.waitForSelector('.erow');
    results.A_app_loaded = await page.locator('.erow').count();
    results.A_consent_shown = await page.locator('#consent.open').count();
    results.A_google_fonts_requested = !!st.googleFonts;
    results.A_fonts_loaded = await page.evaluate(() => Promise.all([document.fonts.load('700 16px Archivo'), document.fonts.load('400 16px "Hanken Grotesk"')]).then(r => r.map(x => x.length)));
    results.A_csp_violations = await page.evaluate(() => window.__csp);
    results.A_page_errors = st.errors;
    // Settings → Privacidad
    await page.click('#nav [data-view="settings"]'); await page.click('[data-st="privacidad"]');
    // The privacy log loads asynchronously inside #set-panel; wait for it before counting so the numbers are deterministic.
    await page.waitForFunction(() => !/Cargando/.test(document.querySelector('#pv-log').textContent));
    results.A_privacy_log_lines = await page.locator('#pv-log .set-row').count();
    results.A_privacy_rows = await page.locator('#set-panel .set-row').count() - results.A_privacy_log_lines;
    results.A_template_link = await page.getAttribute('a[href^="aviso-pacientes.html"]', 'href');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pv-export')]);
    results.A_export_download = dl.suggestedFilename() + ' ' + fs.readFileSync(await dl.path(), 'utf8').slice(0, 40);
    results.A_export_rpc = st.rpc.some(r => r[0] === 'export_my_data');
    // Delete account: wrong word → no RPC; right word → RPC + logout
    await page.click('#pv-delme'); // dialog accepted with '' → aborted
    results.A_delme_wrong_word_rpc = st.rpc.some(r => r[0] === 'delete_my_account');
    // Patient anonymize from CRM
    await page.click('#nav [data-view="crm"]'); await page.waitForSelector('[data-p="p1"]'); await page.click('[data-p="p1"]');
    await page.waitForSelector('#pt-anon'); await page.click('#pt-anon');
    await page.waitForFunction(() => document.body.innerText.includes('Paciente eliminado'));
    results.A_anonymize_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'anonymize_patient'));
    results.A_anonymize_confirm_text = (st.dialog || '').slice(0, 60);
    // Idle logout: 30 minutes without activity
    await page.clock.fastForward(29 * 60 * 1000 + 1000);
    results.A_idle_warning = await page.locator('#toast.show').innerText().catch(() => '');
    await page.clock.fastForward(61 * 1000);
    await page.clock.runFor(3000); await page.waitForURL(/inactivo=1/, { timeout: 5000 }).catch(() => {});
    results.A_idle_logged_out = st.loggedOut === true;
    results.A_idle_redirect = page.url().includes('inactivo=1');
    results.A_idle_login_message = await page.locator('#login-msg').innerText().catch(() => '');
    await ctx.close(); }

  // B. Version mismatch → consent modal blocks; accepting calls accept_terms(version) and lets the app in.
  { const st = { termsVersion: '2025-01-01' }; const { ctx, page } = await openApp(browser, st);
    await page.waitForSelector('#consent.open');
    results.B_modal_version = await page.locator('#consent-ver').innerText();
    results.B_ok_disabled_before_tick = await page.locator('#consent-ok').isDisabled();
    results.B_app_hidden_while_modal = await page.locator('.erow').count();
    await page.check('#consent-chk'); await page.click('#consent-ok');
    await page.waitForSelector('.erow');
    results.B_accept_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'accept_terms'));
    results.B_modal_closed = await page.locator('#consent.open').count();
    await ctx.close(); }

  // C. Ticked at sign-up (metadata carries the version) → silent accept, no modal.
  { const st = { termsVersion: null, metadata: { terms_version: TERMS } }; const { ctx, page } = await openApp(browser, st);
    await page.waitForSelector('.erow');
    results.C_silent_accept_rpc = st.rpc.some(r => r[0] === 'accept_terms');
    results.C_modal_shown = await page.locator('#consent.open').count();
    await ctx.close(); }

  // D. Migration 0005 not applied: app must still load; privacy actions explain what's missing.
  { const st = { preMigration: true }; const { ctx, page } = await openApp(browser, st);
    await page.waitForSelector('.erow');
    results.D_app_loaded_without_0005 = await page.locator('.erow').count();
    await page.click('#nav [data-view="settings"]'); await page.click('[data-st="privacidad"]');
    await page.waitForFunction(() => !/Cargando/.test(document.querySelector('#pv-log').textContent));
    results.D_log_message = await page.locator('#pv-log').innerText();
    await page.click('#pv-export'); await page.waitForSelector('#toast.show');
    results.D_export_message = await page.locator('#toast-msg').innerText();
    results.D_page_errors = st.errors;
    await ctx.close(); }

  // E. Signed out: sign-up validation (box unticked, short password) and password-reset request.
  { const st = {}; const { ctx, page } = await openApp(browser, st, { session: false });
    await page.click('#go-signup');
    await page.fill('#su-clinic', 'Consultorio X'); await page.fill('#su-email', 'x@y.mx'); await page.fill('#su-pass', 'abcdefghij');
    await page.click('#btn-signup'); results.E_signup_unticked_msg = await page.locator('#signup-msg').innerText();
    await page.fill('#su-pass', 'short'); await page.check('#su-acepto'); await page.click('#btn-signup');
    results.E_signup_short_pw_msg = await page.locator('#signup-msg').innerText();
    results.E_signup_api_called = st.calls.some(c => c.includes('/auth/v1/signup'));
    await page.click('#go-login'); await page.click('#go-reset');
    results.E_reset_view_visible = await page.locator('#v-reset').isVisible();
    await page.fill('#rs-email', 'dra@test.mx'); await page.click('#btn-reset');
    await page.waitForFunction(() => document.querySelector('#reset-msg').textContent.length > 10);
    results.E_reset_msg = await page.locator('#reset-msg').innerText();
    results.E_recover_payload = JSON.stringify(st.recover);
    results.E_footer_links = await page.locator('.lfoot a').allInnerTexts();
    await ctx.close(); }

  // F. Arriving from the reset-password email (implicit flow hash) → new-password form, not the app.
  { const st = { termsVersion: TERMS }; const { ctx, page } = await openApp(browser, st, { session: false, urlSuffix: `#access_token=${JWT}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery` });
    await page.waitForSelector('#v-newpass:not(.hidden)', { timeout: 10000 });
    results.F_newpass_shown = await page.locator('#v-newpass').isVisible();
    results.F_app_hidden = await page.evaluate(() => getComputedStyle(document.getElementById('app')).display);
    await page.fill('#np-pass', 'nuevaclave123'); await page.fill('#np-pass2', 'nuevaclave124'); await page.click('#btn-newpass');
    results.F_mismatch_msg = await page.locator('#newpass-msg').innerText();
    await page.fill('#np-pass2', 'nuevaclave123'); await page.click('#btn-newpass');
    await page.waitForSelector('.erow');
    results.F_password_update_sent = !!(st.userUpdate && st.userUpdate.password === 'nuevaclave123');
    results.F_app_after_update = await page.locator('.erow').count();
    await ctx.close(); }

  // G. Legal pages render, config fills in, processor table populated, no CSP violations.
  for (const pg of ['privacidad.html', 'terminos.html', 'aviso-pacientes.html?consultorio=Cl%C3%ADnica%20Luz&responsable=Dra.%20Ana']) {
    const st = {}; const { ctx, page } = await openApp(browser, st, { session: false, urlSuffix: pg });
    await page.waitForLoadState('load');
    const key = pg.split('.')[0];
    results['G_' + key] = {
      title: await page.title(),
      legal_fields_filled: await page.locator('[data-legal]:not(:empty)').count(),
      legal_fields_empty: await page.locator('[data-legal]:empty').count(),
      processor_rows: await page.locator('#tabla-encargados tbody tr').count(),
      clinic_prefill: key === 'aviso-pacientes' ? await page.locator('#f-consultorio').innerText() + ' / ' + await page.locator('#s-consultorio').innerText() : undefined,
      csp: await page.evaluate(() => window.__csp), errors: st.errors, scrollWidth400: undefined,
    };
    await page.setViewportSize({ width: 400, height: 800 });
    results['G_' + key].scrollWidth400 = await page.evaluate(() => document.documentElement.scrollWidth);
    await ctx.close();
  }

  await browser.close();
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };
  check('app loads', results.A_app_loaded === 2 && results.A_consent_shown === 0);
  check('no Google Fonts', results.A_google_fonts_requested === false && results.A_fonts_loaded.every(n => n >= 1));
  check('no CSP violations / page errors', Object.keys(results).filter(k => /csp|errors/.test(k)).every(k => Array.isArray(results[k]) ? results[k].length === 0 : (results[k] && Object.values(results[k]).every(v => !Array.isArray(v) || v.length === 0))));
  check('privacy tab', results.A_privacy_rows === 7 && results.A_privacy_log_lines === 2 && results.A_export_rpc === true && results.A_delme_wrong_word_rpc === false);
  check('anonymize', /anonymize_patient/.test(results.A_anonymize_rpc));
  check('idle logout', results.A_idle_logged_out === true && /inactividad/.test(results.A_idle_login_message) && /1 minuto/.test(results.A_idle_warning));
  check('consent modal', results.B_modal_version === TERMS && results.B_ok_disabled_before_tick === true && results.B_app_hidden_while_modal === 0 && results.B_accept_rpc.includes(TERMS) && results.B_modal_closed === 0);
  check('silent accept from sign-up metadata', results.C_silent_accept_rpc === true && results.C_modal_shown === 0);
  check('works without 0005', results.D_app_loaded_without_0005 === 2 && /0005/.test(results.D_export_message));
  check('sign-up validation', /acepta/.test(results.E_signup_unticked_msg) && /10\+/.test(results.E_signup_short_pw_msg) && results.E_signup_api_called === false);
  check('password reset request', results.E_reset_view_visible === true && /registrado/.test(results.E_reset_msg) && /dra@test\.mx/.test(results.E_recover_payload));
  check('password recovery flow', results.F_newpass_shown === true && results.F_app_hidden === 'none' && /no coinciden/.test(results.F_mismatch_msg) && results.F_password_update_sent === true && results.F_app_after_update === 2);
  check('legal pages', ['G_privacidad','G_terminos','G_aviso-pacientes'].every(k => results[k].legal_fields_empty === 0 && results[k].scrollWidth400 === 400) && results.G_privacidad.processor_rows === 3 && results.G_terminos.processor_rows === 3 && /Clínica Luz/.test(results['G_aviso-pacientes'].clinic_prefill));
  console.log(JSON.stringify(results, null, 2));
  if (failures.length) { console.error('\nFAILED checks: ' + failures.join(', ')); process.exit(1); }
  console.log(`\nlegal.test.js: all checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
