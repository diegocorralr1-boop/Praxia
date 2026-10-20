// Browser tests: the day-to-day features (login, entries, calendar, patients, analytics, settings, mobile layout,
// degraded backends) against a stateful fake Supabase API, with the real CSP. One scenario per numbered QA step.
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
const MANAGER = { status: 'active', role: 'manager', display_name: 'Dra. Test', terms_version: TERMS, email_confirmed: true, is_admin: false, clinic: { id: 'cl1', name: 'Consultorio Test', status: 'active', is_owner: true }, fx_rate: 18.5, caps: {}, pending: {}, onboarding_error: null };
const FX = 18.5;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function newDb() {
  let i = 0; const categories = [];
  for (const [kind, labels] of Object.entries({ concepto: ['REV', 'PRIMERA VEZ', 'FACO', 'LENTES'], modificador: ['OD', 'OI', 'AO'], estatus: ['Completo', 'Descuento', 'Cortesía'], metodo: ['Pesos (MXN)', 'Dolares (USD)', 'Tarjeta', 'Transferencia'] }))
    for (const label of labels) categories.push({ id: 'c' + (++i), clinic_id: 'cl1', kind, label, sort_order: i, active: true, currency: /USD/.test(label) ? 'USD' : 'MXN' });
  const patients = [{ id: 'p1', name: 'Juan Pérez', phone: '6641234567', created_at: '2026-05-01T00:00:00Z' }, { id: 'p2', name: 'María López', phone: null, created_at: '2026-05-02T00:00:00Z' }, { id: 'p3', name: 'Ana Ruiz', phone: '6649999999', created_at: '2026-05-03T00:00:00Z' }];
  const mk = (id, date, pid, items, extra = {}) => ({ id, entry_date: date, status: 'Completo', method: items[0].method, card_type: null, invoice_no: null, notes: null, created_at: date + 'T12:00:00Z', fx_rate: FX, patient_id: pid, entry_items: items.map(it => ({ currency: /USD/.test(it.method) ? 'USD' : 'MXN', modificador: null, ...it })), ...extra });
  const entries = [
    mk('e1', '2026-10-17', 'p1', [{ concepto: 'FACO', amount: 25000, method: 'Pesos (MXN)' }, { concepto: 'FACO', amount: 50, method: 'Dolares (USD)' }]),
    mk('e2', '2026-10-16', 'p2', [{ concepto: 'REV', amount: 500, method: 'Pesos (MXN)' }]),
    mk('e3', '2026-10-17', 'p3', [{ concepto: 'REV', amount: 500, method: 'Tarjeta' }], { created_at: '2026-10-17T10:00:00Z' }),
    mk('e4', '2026-09-30', 'p1', [{ concepto: 'LENTES', amount: 3000, method: 'Transferencia' }]),
  ];
  return { categories, patients, entries, settings: { fx_rate: FX, recepcion_caps: {} }, audit: [{ table_name: 'entries', action: 'insert', at: '2026-10-17T12:00:00Z', old_data: null, new_data: { entry_date: '2026-10-17' }, profiles: { display_name: 'Dra. Test' } }], seq: 100 };
}
const mxn = e => e.entry_items.reduce((s, it) => s + (it.currency === 'USD' ? it.amount * e.fx_rate : it.amount), 0);
const fmt = n => '$' + Math.round(n).toLocaleString('es-MX');

function makeApi(st) {
  const db = st.db;
  return async route => {
    const req = route.request(), u = new URL(req.url()), m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (body, status = 200, extra = {}) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    const noContent = () => route.fulfill({ status: 204, headers: CORS });
    const fail = (code, message, status = 400) => json({ code, message, details: null, hint: null }, status);
    st.calls.push(m + ' ' + u.pathname + (u.search ? '?' + decodeURIComponent(u.search) : ''));
    if (u.pathname === '/auth/v1/user' && m === 'GET') return json(USER);
    if (u.pathname === '/auth/v1/token') { const b = req.postDataJSON(); st.login = b; if (b.password === 'clave-correcta') return json(SESSION); return json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400); }
    if (u.pathname === '/auth/v1/logout') { st.loggedOut = true; return noContent(); }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.slice('/rest/v1/rpc/'.length), a = req.postDataJSON() || {}; st.rpc.push([fn, a]);
      switch (fn) {
        case 'my_account_state': return json(st.state);
        case 'save_entry': {
          const sameName = db.patients.filter(p => norm(p.name) === norm(a.p_patient_name));
          let pat = a.p_patient_phone ? sameName.find(p => p.phone === a.p_patient_phone) : sameName[0];
          if (!pat && !a.p_patient_phone && sameName.length > 1) return fail('P0001', 'ambiguous_patient');
          if (!pat) { pat = { id: 'p' + (++db.seq), name: a.p_patient_name, phone: a.p_patient_phone || null, created_at: new Date().toISOString() }; db.patients.push(pat); }
          const cur = meth => (db.categories.find(c => c.kind === 'metodo' && c.label === meth) || {}).currency || 'MXN';
          const items = (a.p_items || []).map(it => ({ concepto: it.concepto, modificador: it.modificador || null, amount: Number(it.amount), method: it.method, currency: cur(it.method) }));
          let e = a.p_entry_id ? db.entries.find(x => x.id === a.p_entry_id) : null;
          if (!e) { e = { id: 'e' + (++db.seq), created_at: new Date().toISOString(), fx_rate: db.settings.fx_rate }; db.entries.push(e); }
          Object.assign(e, { entry_date: a.p_entry_date, status: a.p_status, method: items[0] && items[0].method, invoice_no: a.p_invoice_no, notes: a.p_notes, patient_id: pat.id, entry_items: items });
          return json(e.id);
        }
        case 'set_fx_rate': db.settings.fx_rate = a.p_rate; return noContent();
        case 'set_recepcion_caps': db.settings.recepcion_caps = a.p_caps; return noContent();
        case 'export_my_data': return json({ account: { id: 'u1' } });
        case 'check_invite': return json({ valid: false, reason: 'not_found' });
        case 'anonymize_patient': { const p = db.patients.find(x => x.id === a.p_patient); p.name = 'Paciente eliminado ' + p.id; p.phone = null; return noContent(); }
        case 'list_members': return json({ members: [{ id: 'u1', display_name: 'Dra. Test', role: 'manager', status: 'active', is_owner: true, is_me: true, joined_at: '2026-05-01T00:00:00Z' }], invites: [] });
        default: return noContent();
      }
    }
    const table = u.pathname.replace('/rest/v1/', ''), q = u.searchParams, eq = k => (q.get(k) || '').replace(/^eq\./, '');
    const withPatients = list => list.map(e => ({ ...e, patients: (p => p ? { name: p.name, phone: p.phone } : null)(db.patients.find(p => p.id === e.patient_id)) }));
    switch (table) {
      case 'categories': {
        const sel = q.get('select') || '';
        if (st.failCats === 'all' || (st.failCats === '42703' && /currency/.test(sel))) return st.failCats === 'all' ? fail('42501', 'permission denied for table categories', 401) : fail('42703', 'column categories.currency does not exist');
        if (m === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': db.categories.length ? `0-${db.categories.length - 1}/${db.categories.length}` : '*/0' } });
        if (m === 'POST') { const rows = [].concat(req.postDataJSON()); rows.forEach(r => db.categories.push({ id: 'c' + (++db.seq), active: true, currency: 'MXN', ...r })); st.posted = (st.posted || []).concat(rows); return json(rows, 201); }
        if (m === 'PATCH') { const r = db.categories.find(c => c.id === eq('id')); Object.assign(r, req.postDataJSON()); st.patched = (st.patched || []).concat([{ id: r.id, ...req.postDataJSON() }]); return noContent(); }
        if (m === 'DELETE') { st.deleted = (st.deleted || []).concat([eq('id')]); db.categories = db.categories.filter(c => c.id !== eq('id')); return noContent(); }
        return json(db.categories.filter(c => c.active).sort((a, b) => a.sort_order - b.sort_order));
      }
      case 'entries': {
        if (st.failEntries) return fail('42501', 'permission denied for table entries', 401);
        if (m === 'DELETE') { st.deleted = (st.deleted || []).concat([eq('id')]); db.entries = db.entries.filter(e => e.id !== eq('id')); return noContent(); }
        let list = db.entries.slice();
        if (q.get('patient_id')) list = list.filter(e => e.patient_id === eq('patient_id'));
        list.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at));
        return json(withPatients(list));
      }
      case 'patients': return json(db.patients.slice().sort((a, b) => a.id.localeCompare(b.id)));
      case 'clinic_settings': return json(db.settings);
      case 'entry_audit': return json(db.audit);
      case 'profiles': return json([{ role: 'manager', clinic_id: 'cl1', display_name: 'Dra. Test', terms_version: TERMS }]);
      case 'privacy_log': case 'client_errors': return m === 'HEAD' ? route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '*/0' } }) : json([]);
      default: return json([]);
    }
  };
}

async function open(browser, st, opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'America/Tijuana', acceptDownloads: true, ...(opts.context || {}) }); const page = await ctx.newPage();
  Object.assign(st, { calls: [], rpc: [], errors: [], dialogs: [] }); st.db = st.db || newDb(); st.state = st.state || { ...MANAGER };
  page.on('pageerror', e => st.errors.push(e.message)); page.on('dialog', d => { st.dialogs.push(d.message()); d.accept(opts.promptAnswer || ''); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await page.clock.install({ time: new Date('2026-10-18T01:30:00Z') }); // 17 Oct 2026, 18:30 in Tijuana
  await page.route('https://praxia.test/**', r => { const p = decodeURIComponent(new URL(r.request().url()).pathname); const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ status: 200, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'content-security-policy': CSP }, body: fs.readFileSync(f) }); });
  await page.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[0-9.]+\/dist\/umd\/supabase\.js/, r => r.fulfill({ status: 200, headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' }, body: SBJS }));
  await page.route(SB + '/**', makeApi(st));
  if (opts.session !== false) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-yqsgeywhilqrsombekce-auth-token', JSON.stringify(SESSION)]);
  await page.goto('https://praxia.test/');
  return { ctx, page };
}
const toast = page => page.locator('#toast.show').innerText().catch(() => '');
const selectsHit = page => page.evaluate(() => [...document.querySelectorAll('#sheet select, #sheet input')].map(s => { const r = s.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === s; }));
const R = {};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PRAXIA_CHROMIUM || undefined });
  const close = async (ctx, key, st, page) => { R[key + '_errors'] = st.errors; R[key + '_csp'] = await page.evaluate(() => window.__csp).catch(() => []); await ctx.close(); };

  // 1. Login: wrong password shows a message, Enter submits, the right password opens the app.
  { const st = {}; const { ctx, page } = await open(browser, st, { session: false });
    R.L_autocomplete = [await page.getAttribute('#li-email', 'autocomplete'), await page.getAttribute('#li-pass', 'autocomplete')];
    await page.fill('#li-email', 'dra@test.mx'); await page.fill('#li-pass', 'mala'); await page.press('#li-pass', 'Enter');
    await page.waitForFunction(() => /incorrectos/.test(document.querySelector('#login-msg').textContent)); R.L_wrong_msg = await page.locator('#login-msg').innerText();
    await page.fill('#li-pass', 'clave-correcta'); await page.press('#li-pass', 'Enter'); await page.waitForSelector('.erow');
    R.L_app = await page.locator('.erow').count(); R.L_login_payload = st.login && st.login.email;
    await close(ctx, 'L', st, page); }

  // 2–14. The manager's day: entries → new entry → edit → delete → calendar → patients → analytics → settings.
  { const st = {}; const { ctx, page } = await open(browser, st); const db = st.db;
    await page.waitForSelector('.erow');
    // 2. Entries list
    R.E_days = await page.locator('.day-block').count(); R.E_rows = await page.locator('.erow').count();
    const day17 = db.entries.filter(e => e.entry_date === '2026-10-17');
    R.E_day17_total = await page.locator('.day-block').first().locator('.dt').innerText(); R.E_day17_expected = fmt(day17.reduce((s, e) => s + mxn(e), 0)) + '2 pacientes';
    R.E_first_row = await page.locator('.erow').first().innerText(); R.E_edit_buttons = await page.locator('[data-edit]').count(); R.E_del_buttons = await page.locator('[data-del]').count();
    // 3. New entry sheet: every dropdown has options and nothing covers it
    await page.click('#btn-new'); await page.waitForSelector('#sheet.open'); await page.waitForTimeout(400);
    R.N_options = { estatus: await page.locator('#i-estatus option').count(), concepto: await page.locator('.cc option').count(), modificador: await page.locator('.sm option').count(), metodo: await page.locator('.smethod option').count() };
    R.N_hit = await selectsHit(page); R.N_date = await page.inputValue('#i-fecha');
    await page.waitForFunction(() => document.querySelectorAll('#pac-list option').length > 0); R.N_suggestions = await page.locator('#pac-list option').count();
    await page.fill('#i-pac', 'Juan Pérez'); await page.locator('#i-pac').dispatchEvent('change'); R.N_phone_autofill = await page.inputValue('#i-tel');
    await page.fill('#i-pac', 'Nuevo Paciente'); await page.fill('#i-tel', '');
    const row0 = page.locator('.svc-row').nth(0);
    await row0.locator('.cc').first().selectOption('FACO'); await row0.locator('.sm').selectOption('OD'); await row0.locator('.smethod').selectOption('Dolares (USD)'); await row0.locator('.sa').fill('100');
    R.N_total_usd = await page.locator('#svc-total').innerText();
    await page.click('#svc-add'); R.N_rows_after_add = await page.locator('.svc-row').count();
    R.N_row0_kept = [await row0.locator('.cc').first().inputValue(), await row0.locator('.sm').inputValue(), await row0.locator('.smethod').inputValue(), await row0.locator('.sa').inputValue()];
    const row1 = page.locator('.svc-row').nth(1);
    await row1.locator('.cc-add').click(); R.N_row1_concepts = await page.locator('.svc-row').nth(1).locator('.cc').count();
    await page.locator('.svc-row').nth(1).locator('.cc').nth(1).selectOption('LENTES'); await page.locator('.svc-row').nth(1).locator('.sa').fill('1000');
    R.N_total_two_lines = await page.locator('#svc-total').innerText();
    await page.click('#sheet-save'); await page.waitForSelector('#sheet:not(.open)'); R.N_toast = await toast(page);
    const saved = st.rpc.find(r => r[0] === 'save_entry'); R.N_rpc = saved && saved[1]; R.N_new_id = db.entries[db.entries.length - 1].id;
    await page.waitForFunction(() => document.querySelector('#content').innerText.includes('Nuevo Paciente'));
    R.N_day17_total_after = await page.locator('.day-block').first().locator('.dt').innerText();
    R.N_day17_expected_after = fmt(db.entries.filter(e => e.entry_date === '2026-10-17').reduce((s, e) => s + mxn(e), 0)) + '3 pacientes';
    // 4. Edit: the sheet is prefilled; a status change is saved on the same entry
    await page.click(`[data-edit="${R.N_new_id}"]`); await page.waitForSelector('#sheet.open'); await page.waitForTimeout(400);
    R.D_title = await page.locator('#sheet .sheet-head h3').innerText(); R.D_name = await page.inputValue('#i-pac'); R.D_lines = await page.locator('.svc-row').count();
    R.D_line0 = [await page.locator('.svc-row').nth(0).locator('.cc').first().inputValue(), await page.locator('.svc-row').nth(0).locator('.sm').inputValue(), await page.locator('.svc-row').nth(0).locator('.smethod').inputValue(), await page.locator('.svc-row').nth(0).locator('.sa').inputValue()];
    await page.selectOption('#i-estatus', 'Descuento'); await page.click('#sheet-save'); await page.waitForSelector('#sheet:not(.open)');
    const upd = st.rpc.filter(r => r[0] === 'save_entry').pop(); R.D_rpc = upd && { id: upd[1].p_entry_id, status: upd[1].p_status, items: upd[1].p_items.length };
    await page.waitForFunction(() => /Descuento/.test(document.querySelector('#content').innerText)); R.D_status_shown = (await page.locator(`[data-edit="${R.N_new_id}"]`).locator('xpath=ancestor::div[contains(@class,"erow")]').innerText()).includes('Descuento');
    // 5. Delete (confirm dialog accepted)
    await page.click(`[data-del="${R.N_new_id}"]`); await page.waitForFunction(id => !document.querySelector(`[data-del="${id}"]`), R.N_new_id);
    R.X_confirm = st.dialogs.pop(); R.X_deleted = st.deleted && st.deleted.includes(R.N_new_id); R.X_rows = await page.locator('.erow').count();
    // 6. Calendar
    await page.click('#nav [data-view="calendar"]'); await page.waitForSelector('.cal-grid');
    R.C_month = await page.locator('.cal-nav b').innerText(); R.C_days_with_entries = await page.locator('.cal-cnt').count(); R.C_month_total = await page.locator('.cal-month-tot').innerText();
    await page.click('[data-day="2026-10-16"]'); R.C_detail_rows = await page.locator('#cal-detail .erow').count(); R.C_detail_name = await page.locator('#cal-detail .erow .pname').innerText();
    await page.click('#cprev'); R.C_prev = await page.locator('.cal-nav b').innerText(); R.C_prev_days = await page.locator('.cal-cnt').count(); await page.click('#cnext'); R.C_next = await page.locator('.cal-nav b').innerText();
    // 7. Patients: search (accent-insensitive, by phone), list view, detail
    await page.click('#nav [data-view="crm"]'); await page.waitForSelector('.pcard'); R.P_cards = await page.locator('.pcard').count();
    await page.fill('#crm-q', 'maria'); R.P_search_name = await page.locator('.pcard').count(); R.P_search_text = await page.locator('.pcard b').first().innerText();
    await page.fill('#crm-q', '664 999'); R.P_search_phone = await page.locator('.pcard b').first().innerText(); await page.fill('#crm-q', 'zzz'); R.P_search_none = await page.locator('#crm-body .empty').count();
    await page.fill('#crm-q', ''); await page.click('#crm-toggle [data-v="list"]'); R.P_list_rows = await page.locator('.cl-row:not(.head)').count(); R.P_list_phone = (await page.locator('.cl-row:not(.head)').first().innerText());
    await page.click('[data-p="p1"]'); await page.waitForSelector('#pt-modal.open'); await page.waitForSelector('.pt-visit');
    R.P_modal_head = await page.locator('#pt-head').innerText(); R.P_visits = await page.locator('.pt-visit').count(); await page.click('#pt-close'); R.P_modal_closed = await page.locator('#pt-modal.open').count();
    // 8. Analytics
    await page.click('#nav [data-view="analytics"]'); await page.waitForSelector('.grid-stats');
    R.A_stats = await page.locator('.stat .val').allInnerTexts(); R.A_total_expected = fmt(db.entries.reduce((s, e) => s + mxn(e), 0)); R.A_bars = await page.locator('.bar-row').count(); R.A_legend = await page.locator('.legend .li').allInnerTexts(); R.A_trend = await page.locator('.trend .tb').count();
    // 9. Preferences (Recepción capabilities)
    await page.click('#nav [data-view="settings"]'); await page.waitForSelector('[data-cap]'); await page.click('[data-cap="monthlyTotals"]'); await page.waitForSelector('#toast.show');
    R.S_caps_rpc = (st.rpc.filter(r => r[0] === 'set_recepcion_caps').pop() || [])[1]; R.S_caps_on = await page.locator('[data-cap="monthlyTotals"].on').count();
    // 10. Categories: add, currency toggle, delete; the form sees the new concept
    await page.click('[data-st="categorias"]'); await page.waitForSelector('[data-add="concepto"]'); const chips = await page.locator('.chip').count();
    await page.fill('#add-concepto', 'OCT'); await page.press('#add-concepto', 'Enter'); await page.waitForFunction(n => document.querySelectorAll('.chip').length === n + 1, chips);
    R.K_posted = st.posted && st.posted[0]; R.K_chip_added = (await page.locator('.chip').allInnerTexts()).some(t => /OCT/.test(t));
    const tarjeta = db.categories.find(c => c.label === 'Tarjeta'); await page.click(`[data-cur="${tarjeta.id}"]`); await page.waitForFunction(id => document.querySelector(`[data-cur="${id}"]`).textContent === 'USD', tarjeta.id);
    R.K_patched = st.patched && st.patched[0];
    const oct = db.categories.find(c => c.label === 'OCT'); await page.click(`[data-del="${oct.id}"]`); await page.waitForFunction(n => document.querySelectorAll('.chip').length === n, chips); R.K_deleted = st.deleted && st.deleted.includes(oct.id);
    await page.fill('#add-concepto', 'YAG'); await page.click('[data-add="concepto"]'); await page.waitForFunction(n => document.querySelectorAll('.chip').length === n + 1, chips);
    await page.click('#nav [data-view="entries"]'); await page.waitForSelector('.erow'); await page.click('#btn-new'); await page.waitForSelector('#sheet.open');
    R.K_form_has_new = (await page.locator('.cc option').allInnerTexts()).includes('YAG'); R.K_form_usd_tarjeta = await page.evaluate(() => { const s = document.querySelector('.smethod'); s.value = 'Tarjeta'; s.dispatchEvent(new Event('change')); document.querySelector('.sa').value = '10'; document.querySelector('.sa').dispatchEvent(new Event('input')); return document.querySelector('#svc-total').innerText; });
    await page.click('#sheet-cancel');
    // 11. Data: exchange rate, audit trail, CSV export
    await page.click('#nav [data-view="settings"]'); await page.waitForSelector('[data-st="datos"]'); await page.click('[data-st="datos"]'); await page.waitForSelector('#s-fx');
    R.T_fx_initial = await page.inputValue('#s-fx'); await page.fill('#s-fx', '20'); await page.click('#s-fx-save'); await page.waitForFunction(() => /TC actualizado/.test(document.querySelector('#toast-msg').textContent)); R.T_fx_rpc = (st.rpc.filter(r => r[0] === 'set_fx_rate').pop() || [])[1]; R.T_fx_toast = await toast(page);
    await page.waitForFunction(() => !/Cargando/.test(document.querySelector('#audit-list').textContent)); R.T_audit_rows = await page.locator('#audit-list .set-row').count(); R.T_audit_text = await page.locator('#audit-list').innerText();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp-csv')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
    R.T_csv_name = dl.suggestedFilename(); R.T_csv_lines = csv.trim().split('\n').length; R.T_csv_head = csv.split('\n')[0].replace(/^\ufeff/, ''); R.T_csv_items = db.entries.reduce((s, e) => s + e.entry_items.length, 0);
    // 12. General: system status, about, logout
    await page.click('[data-st="general"]'); await page.waitForFunction(() => document.querySelector('#sys-diag') && !/Comprobando/.test(document.querySelector('#sys-diag').textContent));
    R.G_diag = await page.locator('#sys-diag .set-row').allInnerTexts(); R.G_about = await page.locator('#set-panel').innerText().then(t => /versión/.test(t));
    await page.click('#s-logout'); await page.waitForFunction(() => document.querySelector('#lock').style.display !== 'none' || true); await page.waitForTimeout(300); R.G_logout_confirm = st.dialogs.pop(); R.G_logged_out = st.loggedOut === true;
    await close(ctx, 'M', st, page); }

  // 13. Phone layout: menu button, drawer, row actions always visible, full-width sheet, two-column charge lines.
  { const st = {}; const { ctx, page } = await open(browser, st, { context: { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true } });
    await page.waitForSelector('.erow'); R.Mb_menu_btn = await page.evaluate(() => getComputedStyle(document.querySelector('#menu-btn')).display);
    R.Mb_no_hscroll = await page.evaluate(() => document.documentElement.scrollWidth); R.Mb_row_acts_opacity = await page.evaluate(() => getComputedStyle(document.querySelector('.row-acts')).opacity);
    await page.click('#menu-btn'); R.Mb_side_open = await page.locator('.side.open').count(); await page.click('#nav [data-view="calendar"]'); await page.waitForSelector('.cal-grid'); R.Mb_side_closed = await page.locator('.side.open').count();
    await page.click('#menu-btn'); await page.click('#nav [data-view="entries"]'); await page.waitForSelector('.erow'); await page.click('#btn-new'); await page.waitForSelector('#sheet.open'); await page.waitForTimeout(400);
    R.Mb_sheet_width = await page.evaluate(() => document.querySelector('#sheet').getBoundingClientRect().width); R.Mb_l2_cols = await page.evaluate(() => getComputedStyle(document.querySelector('.svc-l2')).gridTemplateColumns.split(' ').length);
    R.Mb_hit = await selectsHit(page); R.Mb_save_visible = await page.evaluate(() => { const r = document.querySelector('#sheet-save').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top >= 0; });
    await close(ctx, 'Mb', st, page); }

  // 14. Degraded backends: categories unreadable (before 0004 / fully failing) and entries unreadable.
  { const st = { failCats: '42703' }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); await page.click('#btn-new'); await page.waitForSelector('#sheet.open');
    R.F1_options = await page.locator('.cc option').count(); R.F1_metodo_usd = await page.evaluate(() => { const s = document.querySelector('.smethod'); s.value = 'Dolares (USD)'; s.dispatchEvent(new Event('change')); document.querySelector('.sa').value = '1'; document.querySelector('.sa').dispatchEvent(new Event('input')); return document.querySelector('#svc-total').innerText; });
    await page.click('#sheet-cancel'); await page.click('#nav [data-view="settings"]'); await page.click('[data-st="general"]'); await page.waitForFunction(() => document.querySelector('#sys-diag') && !/Comprobando/.test(document.querySelector('#sys-diag').textContent));
    R.F1_diag_0004 = (await page.locator('#sys-diag .set-row').allInnerTexts()).find(t => /0004/.test(t));
    await close(ctx, 'F1', st, page); }
  { const st = { failCats: 'all' }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.F2_toast = await toast(page); await page.click('#btn-new'); await page.waitForSelector('#sheet.open');
    R.F2_options = { concepto: await page.locator('.cc option').count(), estatus: await page.locator('#i-estatus option').count(), metodo: await page.locator('.smethod option').count() };
    await close(ctx, 'F2', st, page); }
  { const st = { failEntries: true }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.empty'); R.F3_message = await page.locator('.empty').innerText();
    await close(ctx, 'F3', st, page); }

  // 15. Recepción: capabilities decide what is visible.
  { const st = { state: { ...MANAGER, role: 'recepcion', clinic: { ...MANAGER.clinic, is_owner: false }, caps: {} } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.Rc_badge = await page.locator('#role-badge').innerText(); R.Rc_nav = await page.evaluate(() => [...document.querySelectorAll('#nav button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.view));
    R.Rc_note = await page.locator('.note').count(); R.Rc_day_total = await page.locator('.day-block').first().locator('.dt').innerText(); R.Rc_edit_buttons = await page.locator('[data-edit]').count();
    await page.click('#nav [data-view="calendar"]'); await page.waitForSelector('.cal-grid'); R.Rc_cal_total = await page.locator('.cal-top').innerText();
    await page.click('#nav [data-view="settings"]'); await page.waitForSelector('.set-tabs'); R.Rc_tabs = await page.locator('.set-tabs button').allInnerTexts();
    await close(ctx, 'Rc', st, page); }
  { const st = { state: { ...MANAGER, role: 'recepcion', caps: { dailyTotals: false, deleteEntries: false, editEntries: false, editCategories: false, editFx: false } } }; const { ctx, page } = await open(browser, st);
    await page.waitForSelector('.erow'); R.Rc2_day_total = await page.locator('.day-block').first().locator('.dt').innerText(); R.Rc2_edit_buttons = await page.locator('[data-edit]').count() + await page.locator('[data-del]').count();
    await page.click('#nav [data-view="settings"]'); await page.waitForSelector('.set-tabs'); R.Rc2_tabs = await page.locator('.set-tabs button').allInnerTexts();
    await close(ctx, 'Rc2', st, page); }

  await browser.close();
  const failures = []; const check = (name, cond) => { if (!cond) failures.push(name); };
  check('no page errors / CSP violations', Object.keys(R).filter(k => /_errors$|_csp$/.test(k)).every(k => R[k].length === 0));
  check('1 login', /incorrectos/.test(R.L_wrong_msg) && R.L_app > 0 && R.L_login_payload === 'dra@test.mx' && R.L_autocomplete[1] === 'current-password');
  check('2 entries list', R.E_days === 3 && R.E_rows === 4 && R.E_day17_total.replace(/\s+/g, '') === R.E_day17_expected.replace(/\s+/g, '') && /Juan Pérez/.test(R.E_first_row) && /FACO/.test(R.E_first_row) && /MXN \+ USD/.test(R.E_first_row) && R.E_edit_buttons === 4 && R.E_del_buttons === 4);
  check('3 new entry dropdowns', R.N_options.estatus === 3 && R.N_options.concepto === 4 && R.N_options.modificador === 4 && R.N_options.metodo === 4 && R.N_hit.every(Boolean) && R.N_date === '2026-10-17');
  check('3 patient suggestions + phone autofill', R.N_suggestions === 3 && R.N_phone_autofill === '6641234567');
  check('3 lines, totals, save', /\$1,850/.test(R.N_total_usd) && /USD/.test(R.N_total_usd) && R.N_rows_after_add === 2 && JSON.stringify(R.N_row0_kept) === '["FACO","OD","Dolares (USD)","100"]' && R.N_row1_concepts === 2 && /\$2,850/.test(R.N_total_two_lines) && /guardada/.test(R.N_toast)
    && R.N_rpc && R.N_rpc.p_patient_name === 'Nuevo Paciente' && R.N_rpc.p_entry_id === null && R.N_rpc.p_status === 'Completo' && JSON.stringify(R.N_rpc.p_items) === JSON.stringify([{ concepto: 'FACO', modificador: 'OD', amount: 100, method: 'Dolares (USD)' }, { concepto: 'REV', modificador: null, amount: 500, method: 'Pesos (MXN)' }, { concepto: 'LENTES', modificador: null, amount: 500, method: 'Pesos (MXN)' }])
    && R.N_day17_total_after.replace(/\s+/g, '') === R.N_day17_expected_after.replace(/\s+/g, ''));
  check('4 edit entry', R.D_title === 'Editar entrada' && R.D_name === 'Nuevo Paciente' && R.D_lines === 3 && JSON.stringify(R.D_line0) === '["FACO","OD","Dolares (USD)","100"]' && R.D_rpc && R.D_rpc.id === R.N_new_id && R.D_rpc.status === 'Descuento' && R.D_rpc.items === 3 && R.D_status_shown === true);
  check('5 delete entry', /Eliminar esta entrada/.test(R.X_confirm) && R.X_deleted === true && R.X_rows === 4);
  check('6 calendar', /octubre 2026/i.test(R.C_month) && R.C_days_with_entries === 2 && /\$/.test(R.C_month_total) && R.C_detail_rows === 1 && /María López/.test(R.C_detail_name) && /septiembre 2026/i.test(R.C_prev) && R.C_prev_days === 1 && /octubre 2026/i.test(R.C_next));
  check('7 patients', R.P_cards === 4 && R.P_search_name === 1 && /María López/.test(R.P_search_text) && /Ana Ruiz/.test(R.P_search_phone) && R.P_search_none === 1 && R.P_list_rows === 4 && /664/.test(R.P_list_phone) && /6641234567/.test(R.P_modal_head) && R.P_visits === 2 && R.P_modal_closed === 0);
  check('8 analytics', R.A_stats.length === 4 && R.A_stats[0] === R.A_total_expected && R.A_stats[1] === '3' && R.A_bars >= 3 && R.A_legend.length === 4 && R.A_trend === 3);
  check('9 preferences', R.S_caps_rpc && R.S_caps_rpc.p_caps && R.S_caps_rpc.p_caps.monthlyTotals === true && R.S_caps_on === 1);
  check('10 categories', R.K_posted && R.K_posted.kind === 'concepto' && R.K_posted.label === 'OCT' && R.K_chip_added === true && R.K_patched && R.K_patched.currency === 'USD' && R.K_deleted === true && R.K_form_has_new === true && /USD/.test(R.K_form_usd_tarjeta));
  check('11 data', R.T_fx_initial === '18.5' && R.T_fx_rpc && R.T_fx_rpc.p_rate === 20 && /TC actualizado/.test(R.T_fx_toast) && R.T_audit_rows === 1 && /creó entrada/.test(R.T_audit_text) && R.T_csv_name === 'registro_praxia.csv' && R.T_csv_lines === R.T_csv_items + 1 && /^"Fecha","Paciente"/.test(R.T_csv_head));
  check('12 general', R.G_diag.length === 5 && R.G_diag.every(t => /ok|aplicada/.test(t)) && R.G_about === true && /Cerrar sesión/.test(R.G_logout_confirm) && R.G_logged_out === true);
  check('13 phone layout', R.Mb_menu_btn === 'grid' && R.Mb_no_hscroll === 390 && R.Mb_row_acts_opacity === '1' && R.Mb_side_open === 1 && R.Mb_side_closed === 0 && R.Mb_sheet_width === 390 && R.Mb_l2_cols === 2 && R.Mb_hit.every(Boolean) && R.Mb_save_visible === true);
  check('14 degraded backends', R.F1_options === 4 && /USD/.test(R.F1_metodo_usd) && /falta/.test(R.F1_diag_0004) && /categorías/.test(R.F2_toast) && R.F2_options.concepto === 17 && R.F2_options.estatus === 3 && R.F2_options.metodo === 5 && /Error al cargar/.test(R.F3_message));
  check('15 recepción', R.Rc_badge === 'Recepción' && !R.Rc_nav.includes('analytics') && R.Rc_note === 1 && /\$/.test(R.Rc_day_total) && R.Rc_edit_buttons === 4 && /no disponible/.test(R.Rc_cal_total) && JSON.stringify(R.Rc_tabs) === '["Categorías","Datos","Privacidad","General"]'
    && /^—/.test(R.Rc2_day_total) && R.Rc2_edit_buttons === 0 && JSON.stringify(R.Rc2_tabs) === '["Privacidad","General"]');
  console.log(JSON.stringify(R, null, 2));
  if (failures.length) { console.error('\nFAILED checks: ' + failures.join(', ')); process.exit(1); }
  console.log('\napp.test.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
