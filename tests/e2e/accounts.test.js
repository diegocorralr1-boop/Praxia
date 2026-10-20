// Browser tests: account lifecycle screens, member management and the platform admin panel.
// Browser checks of the account flows in index.html (0006) against a fake Supabase API, with the real CSP.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SBJS = fs.readFileSync(path.join(ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
const SB = 'https://yqsgeywhilqrsombekce.supabase.co';
const CSP = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)[1];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2' };
const _sb = { window: {} }; require('vm').runInNewContext(fs.readFileSync(path.join(ROOT, 'legal-config.js'), 'utf8'), _sb); const TERMS = _sb.window.PRAXIA_LEGAL.version;

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', role: 'authenticated', aud: 'authenticated', email: 'dra@test.mx', exp: 1900000000 }) + '.sig';
const USER = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'dra@test.mx', user_metadata: {}, identities: [{ id: 'u1', provider: 'email' }] };
const SESSION = { access_token: JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 1900000000, user: USER };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
const ACTIVE = { status: 'active', role: 'manager', display_name: 'Dra. Test', terms_version: TERMS, email_confirmed: true, is_admin: false, clinic: { id: 'cl1', name: 'Consultorio Test', status: 'active', is_owner: true }, fx_rate: 18.5, caps: {}, pending: {}, onboarding_error: null };
const entries = [{ id: 'e1', entry_date: '2026-10-17', status: 'Completo', method: 'Pesos (MXN)', card_type: null, invoice_no: null, notes: null, created_at: '2026-10-17T12:00:00Z', fx_rate: 18.5, patient_id: 'p1', patients: { name: 'Juan Pérez', phone: null }, entry_items: [{ concepto: 'REV', modificador: null, amount: 500, method: 'Pesos (MXN)', currency: 'MXN' }] }];
const cats = [['concepto', 'REV'], ['estatus', 'Completo'], ['metodo', 'Pesos (MXN)']].map(([k, l], i) => ({ id: 'c' + i, kind: k, label: l, sort_order: i, currency: 'MXN' }));

function makeApi(st) {
  return async route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const noContent = () => route.fulfill({ status: 204, headers: CORS });
    st.calls.push(req.method() + ' ' + u.pathname);
    if (u.pathname === '/auth/v1/user' && req.method() === 'GET') return json({ ...USER, user_metadata: st.metadata || {} });
    if (u.pathname === '/auth/v1/logout') { st.loggedOut = true; return noContent(); }
    if (u.pathname === '/auth/v1/signup') { st.signup = req.postDataJSON();
      if (st.signupMode === 'exists') return json({ ...USER, id: 'fake', email: st.signup.email, identities: [] });
      if (st.signupMode === 'session') return json({ ...SESSION, user: { ...USER, email: st.signup.email } });
      return json({ ...USER, email: st.signup.email, identities: [{ id: 'x', provider: 'email' }] }); }
    if (u.pathname === '/auth/v1/resend') { st.resend = req.postDataJSON(); return json({}); }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.slice('/rest/v1/rpc/'.length), args = req.postDataJSON(); st.rpc.push([fn, args]);
      if (st.pre0006 && ['my_account_state', 'finish_onboarding', 'list_members', 'check_invite'].includes(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
      switch (fn) {
        case 'my_account_state': return json(st.state);
        case 'finish_onboarding': if (st.finishResult === 'active') st.state = { ...ACTIVE }; return json(st.finishResult || 'needs_clinic');
        case 'bootstrap_clinic': st.state = { ...ACTIVE, clinic: { ...ACTIVE.clinic, name: args.p_clinic_name } }; st.legacyProfile = { role: 'manager', clinic_id: 'cl-new', display_name: 'Dra. Test', terms_version: TERMS }; return json('cl-new');
        case 'accept_invite': if (/^BAD/.test((args.p_code || '').replace(/-/g, ''))) return json(null); st.state = { ...ACTIVE, role: 'recepcion' }; return json('cl1');
        case 'check_invite': return json(/^GOOD/.test((args.p_code || '').replace(/-/g, '')) ? { valid: true, clinic_name: 'Clínica Luz', role: 'recepcion', email: null } : { valid: false, reason: 'not_found' });
        case 'list_members': return json({ members: [{ id: 'u1', display_name: 'Dra. Test', role: 'manager', status: 'active', is_owner: true, is_me: true, joined_at: '2026-05-01T00:00:00Z' }, { id: 'u2', display_name: 'Recepción Uno', role: 'recepcion', status: 'active', is_owner: false, is_me: false, joined_at: '2026-06-01T00:00:00Z' }], invites: [{ code: 'GOODGOODGOODGOOD', role: 'recepcion', email: null, created_at: '2026-10-17T00:00:00Z', expires_at: '2026-10-24T00:00:00Z', reserved: false, expired: false }] });
        case 'admin_list_clinics': return json([{ id: 'cl1', name: 'Consultorio Test', status: 'active', created_at: '2026-05-01T00:00:00Z', owner: 'Dra. Test', members: 2, entries: 10, last_entry: '2026-10-17', open_invites: 1 }]);
        case 'admin_list_users': return json([{ id: 'u1', email: 'dra@test.mx', display_name: 'Dra. Test', role: 'manager', status: 'active', clinic_id: 'cl1', clinic_name: 'Consultorio Test', created_at: '2026-05-01T00:00:00Z', email_confirmed: true, is_admin: true }, { id: 'u9', email: 'stuck@test.mx', display_name: null, role: 'recepcion', status: 'needs_clinic', clinic_id: null, clinic_name: null, created_at: '2026-10-17T00:00:00Z', email_confirmed: true, onboarding_error: 'invalid_or_used_code', is_admin: false }]);
        case 'admin_create_invite': return json('ADMINADMINADMIN1');
        case 'admin_create_clinic': return json({ clinic_id: 'cl-x', invite_code: 'NEWCLINICCODE123' });
        default: return noContent();
      }
    }
    const table = u.pathname.replace('/rest/v1/', '');
    switch (table) {
      case 'profiles': return json(st.legacyProfile === undefined ? [{ role: 'manager', clinic_id: 'cl1', display_name: 'Dra. Test', terms_version: TERMS }] : (st.legacyProfile ? [st.legacyProfile] : []));
      case 'clinics': return json({ name: 'Consultorio Legacy' });
      case 'clinic_settings': return json({ fx_rate: 18.5, recepcion_caps: {} });
      case 'categories': if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `0-2/3` } }); return json(cats);
      case 'entries': return json(entries);
      default: return json([]);
    }
  };
}

async function open(browser, st, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Tijuana' }); const page = await ctx.newPage();
  Object.assign(st, { calls: [], rpc: [], errors: [], console: [] });
  page.on('pageerror', e => st.errors.push(e.message)); page.on('dialog', d => { st.dialog = d.message(); d.accept(opts.promptAnswer || ''); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await page.route('https://praxia.test/**', r => { const p = decodeURIComponent(new URL(r.request().url()).pathname); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ status: 200, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'content-security-policy': CSP }, body: fs.readFileSync(f) }); });
  await page.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[0-9.]+\/dist\/umd\/supabase\.js/, r => r.fulfill({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body: SBJS }));
  await page.route(SB + '/**', makeApi(st));
  if (opts.session !== false) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-yqsgeywhilqrsombekce-auth-token', JSON.stringify(SESSION)]);
  await page.goto('https://praxia.test/' + (opts.url || ''));
  return { ctx, page };
}
const visible = (page, sel) => page.locator(sel).isVisible();
const R = {};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PRAXIA_CHROMIUM || undefined }); // PRAXIA_CHROMIUM: optional path to a local Chromium (CI installs its own)
  const close = async (ctx, key, st, page) => { R[key + '_errors'] = st.errors; R[key + '_csp'] = await page.evaluate(() => window.__csp).catch(() => []); await ctx.close(); };

  // A. Active manager: app, no admin nav, Personal v2 with actions.
  { const st = { state: { ...ACTIVE } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.A_app = await page.locator('.erow').count();
    R.A_admin_nav_hidden = await page.evaluate(() => getComputedStyle(document.querySelector('#nav [data-view="admin"]')).display);
    await page.click('#nav [data-view="settings"]'); await page.click('[data-st="personal"]'); await page.waitForSelector('.tbl');
    R.A_member_rows = await page.locator('.tbl tbody tr').count(); R.A_invite_code_shown = await page.locator('.tbl').nth(1).innerText().then(t => t.includes('GOOD-GOOD-GOOD-GOOD'));
    await page.click('[data-role="u2"]'); R.A_role_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'set_member_role'));
    await page.click('[data-remove="u2"]'); R.A_remove_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'remove_member')); R.A_remove_confirm = (st.dialog || '').slice(0, 30);
    await page.selectOption('#inv-role', 'manager'); await page.fill('#inv-email', 'nuevo@test.mx'); await page.click('#gen-code'); await page.waitForSelector('#code-out .warn');
    R.A_create_invite_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'create_invite'));
    await page.click('[data-revoke="GOODGOODGOODGOOD"]'); R.A_revoke_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'revoke_invite'));
    await close(ctx, 'A', st, page); }

  // B. Pending sign-up (needs_clinic + pending clinic): finish_onboarding runs and the app opens.
  { const st = { state: { ...ACTIVE, status: 'needs_clinic', clinic: null, pending: { clinic_name: 'Clínica Nueva' } }, finishResult: 'active' }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.B_finish_called = st.rpc.some(r => r[0] === 'finish_onboarding'); R.B_app = await page.locator('.erow').count();
    await close(ctx, 'B', st, page); }

  // C. Sign-up that failed server-side: Onboarding screen with the reason; creating a clinic from there works.
  { const st = { state: { ...ACTIVE, status: 'needs_clinic', clinic: null, pending: { invite: true }, onboarding_error: 'invalid_or_used_code' } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('#v-onboard:not(.hidden)'); R.C_error_text = await page.locator('#ob-error').innerText(); R.C_retry_visible = await visible(page, '#ob-retry');
    R.C_finish_not_auto = !st.rpc.some(r => r[0] === 'finish_onboarding');
    await page.click('#ob-create'); await page.fill('#ob-clinic', 'Mi Clínica'); await page.click('#ob-create-go'); await page.waitForSelector('.erow');
    R.C_bootstrap_rpc = JSON.stringify(st.rpc.find(r => r[0] === 'bootstrap_clinic')); R.C_clinic_name_shown = await page.locator('#s-clinic').innerText();
    await close(ctx, 'C', st, page); }

  // D. No clinic, no pending: join with a code, live check shows the clinic; bad code is rejected.
  { const st = { state: { ...ACTIVE, status: 'needs_clinic', clinic: null, pending: {} } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('#v-onboard:not(.hidden)'); R.D_retry_hidden = !(await visible(page, '#ob-retry'));
    await page.click('#ob-code'); await page.fill('#ob-codein', 'GOOD-GOOD-GOOD-GOOD'); await page.waitForFunction(() => /Clínica Luz/.test(document.querySelector('#ob-codeinfo').textContent));
    R.D_live_info = await page.locator('#ob-codeinfo').innerText();
    await page.fill('#ob-codein', 'BADB-ADBA-DBAD-BADB'); await page.click('#ob-code-go'); await page.waitForFunction(() => /no es válido/.test(document.querySelector('#ob-msg').textContent));
    R.D_bad_code_msg = await page.locator('#ob-msg').innerText();
    await page.fill('#ob-codein', 'GOOD-GOOD-GOOD-GOOD'); await page.click('#ob-code-go'); await page.waitForSelector('.erow'); R.D_joined_role = await page.locator('#role-badge').innerText();
    await close(ctx, 'D', st, page); }

  // E. Disabled / suspended.
  for (const s of ['disabled', 'clinic_suspended']) { const st = { state: { ...ACTIVE, status: s } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('#v-blocked:not(.hidden)'); R['E_' + s] = await page.locator('#bl-title').innerText() + ' | ' + await page.locator('#bl-sub').innerText();
    await close(ctx, 'E_' + s, st, page); }

  // F. Platform admin without a clinic: admin-only mode.
  { const st = { state: { status: 'needs_clinic', role: 'recepcion', display_name: 'Fer', terms_version: TERMS, email_confirmed: true, is_admin: true, clinic: null, pending: {}, onboarding_error: null } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('[data-at="clinics"]');
    R.F_nav_visible = await page.evaluate(() => [...document.querySelectorAll('#nav button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.view));
    R.F_badge = await page.locator('#role-badge').innerText(); R.F_banner = await visible(page, '#adm-own');
    await page.waitForSelector('.tbl tbody tr'); R.F_clinic_rows = await page.locator('.tbl tbody tr').count();
    await page.click('[data-inv="cl1"][data-role="manager"]'); await page.waitForSelector('#adm-code .warn'); R.F_invite_box = (await page.locator('#adm-code').innerText()).includes('ADMI-NADM-INAD-MIN1');
    await page.click('[data-at="users"]'); await page.waitForSelector('#adm-users .tbl tbody tr'); R.F_user_rows = await page.locator('#adm-users .tbl tbody tr').count();
    R.F_stuck_user_error = (await page.locator('#adm-users').innerText()).includes('Alta pendiente');
    R.F_self_has_no_delete = await page.locator('[data-udel="u1"]').count(); R.F_other_has_delete = await page.locator('[data-udel="u9"]').count();
    await page.click('[data-at="new"]'); await page.fill('#adm-cname', 'Clínica Cliente'); await page.click('#adm-create'); await page.waitForSelector('#adm-newcode .warn');
    R.F_new_clinic_code = (await page.locator('#adm-newcode').innerText()).includes('NEWC-LINI-CCOD-E123');
    await page.click('#adm-own'); await page.waitForSelector('#v-onboard:not(.hidden)'); R.F_own_onboarding = await visible(page, '#ob-create');
    await close(ctx, 'F', st, page); }

  // G. Admin who also has a clinic: full app plus the admin entry.
  { const st = { state: { ...ACTIVE, is_admin: true } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.G_nav_visible = await page.evaluate(() => [...document.querySelectorAll('#nav button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.view));
    await page.click('#nav [data-view="admin"]'); await page.waitForSelector('[data-at="clinics"]'); R.G_admin_opens = true; R.G_banner_absent = !(await page.locator('#adm-own').count());
    await close(ctx, 'G', st, page); }

  // H. Signed out: existing email; pending confirmation + resend; confirmation disabled (session) path.
  { const st = { signupMode: 'exists' }; const { ctx, page } = await open(browser, st, { session: false });
    await page.click('#go-signup'); await page.fill('#su-clinic', 'X'); await page.fill('#su-email', 'dup@test.mx'); await page.fill('#su-pass', 'abcdefghij'); await page.check('#su-acepto'); await page.click('#btn-signup');
    await page.waitForFunction(() => /ya tiene una cuenta/.test(document.querySelector('#signup-msg').textContent)); R.H_exists_msg = await page.locator('#signup-msg').innerText();
    st.signupMode = 'pending'; await page.click('#btn-signup'); await page.waitForSelector('#v-confirm:not(.hidden)');
    R.H_confirm_email = await page.inputValue('#cf-email'); R.H_signup_metadata = JSON.stringify(st.signup.data);
    await page.click('#btn-resend'); await page.waitForFunction(() => /reenviado/.test(document.querySelector('#confirm-msg').textContent));
    R.H_resend_payload = JSON.stringify(st.resend); R.H_resend_cooldown = await page.locator('#btn-resend').innerText();
    await close(ctx, 'H', st, page); }
  { const st = { signupMode: 'session', state: { ...ACTIVE } }; const { ctx, page } = await open(browser, st, { session: false });
    await page.click('#go-signup'); await page.fill('#su-clinic', 'X'); await page.fill('#su-email', 'new@test.mx'); await page.fill('#su-pass', 'abcdefghij'); await page.check('#su-acepto'); await page.click('#btn-signup');
    await page.waitForSelector('.erow'); R.H_session_path_app = await page.locator('.erow').count();
    await close(ctx, 'H2', st, page); }

  // I. Join form: live invite info, invalid code blocks the sign-up.
  { const st = { signupMode: 'pending' }; const { ctx, page } = await open(browser, st, { session: false });
    await page.click('#go-join'); await page.fill('#jo-code', 'GOOD-GOOD-GOOD-GOOD'); await page.waitForFunction(() => /Clínica Luz/.test(document.querySelector('#join-msg').textContent)); R.I_live = await page.locator('#join-msg').innerText();
    await page.fill('#jo-name', 'Ana'); await page.fill('#jo-email', 'ana@test.mx'); await page.fill('#jo-pass', 'abcdefghij'); await page.check('#jo-acepto');
    await page.fill('#jo-code', 'BADB-ADBA-DBAD-BADB'); await page.click('#btn-join'); await page.waitForFunction(() => /no es válido/.test(document.querySelector('#join-msg').textContent));
    R.I_bad_blocks_signup = !st.signup; await page.fill('#jo-code', 'GOOD-GOOD-GOOD-GOOD'); await page.click('#btn-join'); await page.waitForSelector('#v-confirm:not(.hidden)'); R.I_good_signup_meta = JSON.stringify(st.signup.data);
    await close(ctx, 'I', st, page); }

  // J. Session but email not confirmed → confirm screen. K. Expired link in URL.
  { const st = { state: { ...ACTIVE, status: 'pending_email', clinic: null } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('#v-confirm:not(.hidden)'); R.J_confirm_prefilled = await page.inputValue('#cf-email'); await close(ctx, 'J', st, page); }
  { const st = {}; const { ctx, page } = await open(browser, st, { session: false, url: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired' });
    await page.waitForFunction(() => /venció/.test(document.querySelector('#login-msg').textContent)); R.K_expired_msg = (await page.locator('#login-msg').innerText()).slice(0, 60); R.K_url_cleaned = page.url();
    await page.click('#login-msg a'); R.K_resend_view = await visible(page, '#v-confirm'); await close(ctx, 'K', st, page); }

  // L. Before 0006: legacy state still opens the app; a user without clinic gets the onboarding screen.
  { const st = { pre0006: true }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.L_legacy_app = await page.locator('#s-clinic').innerText(); await close(ctx, 'L', st, page); }
  { const st = { pre0006: true, legacyProfile: null, metadata: { pending_clinic: 'Clínica Vieja' } }; const { ctx, page } = await open(browser, st);
    await page.waitForFunction(() => document.querySelector('#v-onboard') && !document.querySelector('#v-onboard').classList.contains('hidden') || document.querySelector('.erow'));
    R.L_legacy_pending_bootstrap = JSON.stringify(st.rpc.find(r => r[0] === 'bootstrap_clinic')); R.L_legacy_result = (await page.locator('.erow').count()) ? 'app' : 'onboarding';
    await close(ctx, 'L2', st, page); }

  await browser.close();
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };
  check('no page errors / CSP violations', Object.keys(R).filter(k => /_errors$|_csp$/.test(k)).every(k => R[k].length === 0));
  check('A active manager + Personal v2', R.A_app === 1 && R.A_admin_nav_hidden === 'none' && R.A_member_rows === 3 && R.A_invite_code_shown === true && /set_member_role/.test(R.A_role_rpc) && /remove_member/.test(R.A_remove_rpc) && /create_invite/.test(R.A_create_invite_rpc) && /revoke_invite/.test(R.A_revoke_rpc));
  check('B pending sign-up finishes', R.B_finish_called === true && R.B_app === 1);
  check('C onboarding error + create clinic', /no es válido/.test(R.C_error_text) && R.C_retry_visible === true && R.C_finish_not_auto === true && /bootstrap_clinic/.test(R.C_bootstrap_rpc) && R.C_clinic_name_shown === 'Mi Clínica');
  check('D join with live check', R.D_retry_hidden === true && /Clínica Luz/.test(R.D_live_info) && /no es válido/.test(R.D_bad_code_msg) && R.D_joined_role === 'Recepción');
  check('E blocked screens', /deshabilitado/i.test(R.E_disabled) && /suspendido/i.test(R.E_clinic_suspended));
  check('F admin-only mode', JSON.stringify(R.F_nav_visible) === '["admin"]' && R.F_badge === 'Admin' && R.F_banner === true && R.F_clinic_rows === 1 && R.F_invite_box === true && R.F_user_rows === 2 && R.F_stuck_user_error === true && R.F_self_has_no_delete === 0 && R.F_other_has_delete === 1 && R.F_new_clinic_code === true && R.F_own_onboarding === true);
  check('G admin with clinic', R.G_nav_visible.includes('admin') && R.G_nav_visible.includes('entries') && R.G_banner_absent === true);
  check('H sign-up: existing email, confirm screen, resend', /ya tiene una cuenta/.test(R.H_exists_msg) && R.H_confirm_email === 'dup@test.mx' && /pending_clinic/.test(R.H_signup_metadata) && /"type":"signup"/.test(R.H_resend_payload) && /Reenviar \(/.test(R.H_resend_cooldown) && R.H_session_path_app === 1);
  check('I join form validation', /Clínica Luz/.test(R.I_live) && R.I_bad_blocks_signup === true && /pending_invite/.test(R.I_good_signup_meta));
  check('J/K confirm + expired link', R.J_confirm_prefilled === 'dra@test.mx' && /venció/.test(R.K_expired_msg) && /praxia\.test\/$/.test(R.K_url_cleaned) && R.K_resend_view === true);
  check('L legacy (pre-0006) paths', R.L_legacy_app === 'Consultorio Legacy' && /bootstrap_clinic/.test(R.L_legacy_pending_bootstrap) && R.L_legacy_result === 'app');
  console.log(JSON.stringify(R, null, 2));
  if (failures.length) { console.error('\nFAILED checks: ' + failures.join(', ')); process.exit(1); }
  console.log(`\naccounts.test.js: all checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
