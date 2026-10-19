-- Tenant isolation and permission model (0001, 0004, 0006). Runs inside one transaction (rolled back).
\set login 'set role authenticated; select set_config(''request.jwt.claims'', format(''{"sub":"%s","email":"%s","role":"authenticated"}'', :''who'', :''mail''), false) is not null as _;'
\set MA a0000000-0000-0000-0000-000000000001
\set RA a0000000-0000-0000-0000-000000000002
\set MB b0000000-0000-0000-0000-000000000001

-- Fixtures: two clinics created the way production does it (sign-up metadata + confirmed email).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:'MA', 'ma@x.mx', now(), '{"pending_clinic":"Clinica A","display_name":"Dra. A"}'),
  (:'MB', 'mb@x.mx', now(), '{"pending_clinic":"Clinica B","display_name":"Dr. B"}');
\set who :MA
\set mail ma@x.mx
:login
select public.create_invite('recepcion') as code_a \gset
select public.save_entry(null, 'Juan Pérez', null, public.clinic_today(), 'Completo', 'F-1', 'nota privada',
  '[{"concepto":"FACO","amount":25000,"method":"Pesos (MXN)"},{"concepto":"FACO","amount":50,"method":"Dolares (USD)"}]'::jsonb) as ent_a \gset
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:'RA', 'ra@x.mx', now(), jsonb_build_object('pending_invite', :'code_a', 'display_name', 'Recep A'));
select tests.ok((select clinic_id is not null and role = 'recepcion' and status = 'active' from public.profiles where id = :'RA'),
                'receptionist joined clinic A through the invite saved at sign-up');
\set who :MB
\set mail mb@x.mx
:login
select public.save_entry(null, 'Pedro B', null, public.clinic_today(), 'Completo', null, null,
  '[{"concepto":"REV","amount":700,"method":"Pesos (MXN)"}]'::jsonb) as ent_b \gset
select set_config('t.ent_b', :'ent_b', false) is not null as _;
reset role;

-- [1] A receptionist cannot escalate privileges
\set who :RA
\set mail ra@x.mx
:login
select tests.raises($$update public.profiles set role = 'manager' where id = auth.uid()$$, 'permission denied', 'RA cannot change own role');
select tests.raises($$update public.profiles set clinic_id = null where id = auth.uid()$$, 'permission denied', 'RA cannot change own clinic');
select tests.ok((select role from public.profiles where id = auth.uid()) = 'recepcion', 'RA is still recepcion');
select tests.ok((select count(*) from public.profiles where id = auth.uid()) = 1, 'RA can read own profile row');
update public.profiles set display_name = 'Recep A2' where id = auth.uid();
select tests.ok((select display_name from public.profiles where id = auth.uid()) = 'Recep A2', 'RA can change own display_name');

-- [2] Tenant isolation
select tests.ok((select count(*) from public.entries) = 1, 'RA sees only clinic A entries');
select tests.ok((select count(*) from public.patients where name = 'Pedro B') = 0, 'RA cannot see clinic B patients');
select tests.ok(public.entry_mxn(current_setting('t.ent_b')::uuid) = 0, 'entry_mxn() of another clinic returns 0');
select tests.ok((select count(*) from public.invites) = 0, 'RA cannot list invite codes');
select tests.raises($$select public.create_invite('manager')$$, 'no_permission', 'RA cannot create invites');
select tests.raises($$select public.set_recepcion_caps('{"analytics":true}'::jsonb)$$, 'no_permission', 'RA cannot change caps');
select tests.raises($$select public.get_monthly_total(current_date)$$, 'no_permission', 'monthly total gated by cap');
select tests.ok((select count(*) from public.platform_admins) = 0, 'RA cannot read platform_admins');
select tests.ok(public.admin_list_users(null) is null, 'RA gets nothing from admin_list_users');
reset role;

-- [3] Split payments: USD lines convert at the rate frozen on the entry
\set who :MA
\set mail ma@x.mx
:login
select tests.ok(public.entry_mxn(:'ent_a') = 25000 + 50 * 18.5, 'split payment total = MXN + USD * fx');
select public.set_recepcion_caps('{"monthlyTotals": true}'::jsonb);
reset role;
\set who :RA
\set mail ra@x.mx
:login
select tests.ok(public.get_monthly_total(current_date) = 25000 + 50 * 18.5, 'monthly total allowed once the cap is on');
reset role;

-- [4] Anonymous callers
set role anon;
select set_config('request.jwt.claims', '', false) is not null as _;
select tests.raises($$select public.set_recepcion_caps('{}'::jsonb)$$, 'permission denied', 'anon cannot execute RPCs');
select tests.raises($$select public.my_account_state()$$, 'permission denied', 'anon cannot call my_account_state');
-- Anonymous requests to data tables fail closed: the RLS policy calls current_clinic_id(), which anon cannot execute (0004).
select tests.raises($$select count(*) from public.entries$$, 'permission denied', 'anon cannot read entries (fails closed)');
select tests.ok((public.check_invite('nope') ->> 'valid') = 'false', 'anon may check an invite code (64-bit codes)');
reset role;
