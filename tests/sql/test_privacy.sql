-- LFPDPPP features (0005): consent, patient anonymization, clinic and account deletion, data export.
\set login 'set role authenticated; select set_config(''request.jwt.claims'', format(''{"sub":"%s","email":"%s","role":"authenticated"}'', :''who'', :''mail''), false) is not null as _;'
\set MA a0000000-0000-0000-0000-000000000001
\set RA a0000000-0000-0000-0000-000000000002
\set MB b0000000-0000-0000-0000-000000000001

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:'MA', 'ma@x.mx', now(), '{"pending_clinic":"Clinica A","display_name":"Dra. A"}'),
  (:'MB', 'mb@x.mx', now(), '{"pending_clinic":"Clinica B","display_name":"Dr. B"}');
\set who :MA
\set mail ma@x.mx
:login
select public.create_invite('recepcion') as code_a \gset
select public.save_entry(null, 'Juan Pérez', '664-123-4567', public.clinic_today(), 'Completo', 'F-1', 'alergia (nota privada)',
  '[{"concepto":"FACO","amount":25000,"method":"Pesos (MXN)"},{"concepto":"FACO","amount":50,"method":"Dolares (USD)"}]'::jsonb) as ent_a1 \gset
select public.save_entry(null, 'Juan Pérez', '664-123-4567', public.clinic_today(), 'Completo', null, 'segunda visita',
  '[{"concepto":"REV","amount":500,"method":"Pesos (MXN)"}]'::jsonb) as ent_a2 \gset
select public.save_entry(null, 'María López', null, public.clinic_today(), 'Completo', null, 'nota maria',
  '[{"concepto":"REV","amount":600,"method":"Pesos (MXN)"}]'::jsonb) as ent_a3 \gset
select id as pat_juan from public.patients where name = 'Juan Pérez' \gset
select id as pat_maria from public.patients where name = 'María López' \gset
select set_config('t.pat_juan', :'pat_juan', false) is not null as _;
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:'RA', 'ra@x.mx', now(), jsonb_build_object('pending_invite', :'code_a', 'display_name', 'Recep A'));
\set who :MB
\set mail mb@x.mx
:login
select public.save_entry(null, 'Pedro B', null, public.clinic_today(), 'Completo', null, 'nota B', '[{"concepto":"REV","amount":700,"method":"Pesos (MXN)"}]'::jsonb) as ent_b \gset
reset role;

-- [1] Consent is recorded and visible per role
\set who :RA
\set mail ra@x.mx
:login
select public.accept_terms('2026-10-17');
select tests.ok((select terms_version = '2026-10-17' and terms_accepted_at is not null from public.profiles where id = auth.uid()), 'consent stored on profile');
select tests.ok((select count(*) from public.privacy_log where action = 'terms_accepted') = 1, 'RA sees own consent event');
reset role;
\set who :MA
\set mail ma@x.mx
:login
select tests.ok((select count(*) from public.privacy_log where action = 'terms_accepted') = 1, 'manager sees the clinic consent event');
reset role;
\set who :MB
\set mail mb@x.mx
:login
select tests.ok((select count(*) from public.privacy_log where action = 'terms_accepted') = 0, 'other clinic sees nothing');
reset role;

-- [2] Anonymization: gated, clinic-scoped, keeps amounts, clears notes everywhere
\set who :MA
\set mail ma@x.mx
:login
select public.set_recepcion_caps('{"deleteEntries": false}'::jsonb);
reset role;
\set who :RA
\set mail ra@x.mx
:login
select tests.raises($$select public.anonymize_patient(current_setting('t.pat_juan')::uuid)$$, 'no_permission', 'anonymize needs deleteEntries');
reset role;
\set who :MB
\set mail mb@x.mx
:login
select tests.raises($$select public.anonymize_patient(current_setting('t.pat_juan')::uuid)$$, 'patient_not_found', 'cannot anonymize another clinic''s patient');
reset role;
\set who :MA
\set mail ma@x.mx
:login
select public.anonymize_patient(:'pat_juan');
select tests.ok((select name like 'Paciente eliminado %' and phone is null and phone_key is null and anonymized_at is not null from public.patients where id = :'pat_juan'), 'identity removed');
select tests.ok((select count(*) from public.entries where patient_id = :'pat_juan') = 2, 'entries kept');
select tests.ok((select sum(public.entry_mxn(id)) from public.entries where patient_id = :'pat_juan') = 25000 + 50 * 18.5 + 500, 'amounts kept');
select tests.ok((select count(notes) from public.entries where patient_id = :'pat_juan') = 0, 'entry notes cleared');
select tests.ok((select count(*) from public.entry_audit a where a.table_name = 'entries' and a.entry_id in (select id from public.entries where patient_id = :'pat_juan')
                   and (coalesce(a.old_data ->> 'notes', '') <> '' or coalesce(a.new_data ->> 'notes', '') <> '')) = 0, 'audit copies of notes cleared');
select tests.ok((select count(*) from public.entry_audit a where a.table_name = 'entries' and coalesce(a.new_data ->> 'notes', '') <> '') > 0, 'other patients'' audit notes untouched');
select tests.raises($$select public.anonymize_patient(current_setting('t.pat_juan')::uuid)$$, 'already_anonymized', 'second call rejected');
select public.anonymize_patient(:'pat_maria');
select tests.ok((select count(*) from public.patients where anonymized_at is not null) = 2, 'two anonymized patients coexist (unique index)');
select tests.ok((select count(*) from public.privacy_log where action = 'patient_anonymized') = 2, 'anonymizations logged');
reset role;

-- [3] delete_clinic: manager only, exact name, nothing left, other clinic intact
\set who :RA
\set mail ra@x.mx
:login
select tests.raises($$select public.delete_clinic('Clinica A')$$, 'no_permission', 'receptionist cannot delete the clinic');
reset role;
\set who :MA
\set mail ma@x.mx
:login
select tests.raises($$select public.delete_clinic('clinica a ')$$, 'confirm_name_mismatch', 'name must match exactly');
select id as clinic_a from public.clinics where name = 'Clinica A' \gset
select public.delete_clinic('Clinica A');
select tests.ok(public.current_clinic_id() is null, 'manager has no clinic after deletion');
select tests.ok((select count(*) from public.privacy_log where action = 'clinic_deleted' and details ->> 'clinic_name' = 'Clinica A') = 1, 'deletion logged with name');
reset role;
select tests.ok((select count(*) from public.clinics where id = :'clinic_a') = 0, 'clinic row gone');
select tests.ok((select count(*) from public.entries where clinic_id = :'clinic_a') = 0, 'entries gone');
select tests.ok((select count(*) from public.patients where clinic_id = :'clinic_a') = 0, 'patients gone');
select tests.ok((select count(*) from public.entry_audit where clinic_id = :'clinic_a') = 0, 'audit gone');
select tests.ok((select count(*) from public.profiles where id in (:'MA', :'RA') and clinic_id is null and status = 'needs_clinic') = 2, 'members detached, accounts kept');
select tests.ok((select count(*) from public.entries where id = :'ent_b') = 1, 'clinic B untouched');

-- [4] delete_my_account
\set who :MB
\set mail mb@x.mx
:login
select tests.raises($$select public.delete_my_account()$$, 'delete_clinic_first', 'sole manager with data must delete the clinic first');
select tests.ok(public.export_my_data() ? 'profile' and public.export_my_data() ? 'clinic' and (public.export_my_data() -> 'account' ->> 'email') = 'mb@x.mx', 'export_my_data has the expected sections');
reset role;
\set who :RA
\set mail ra@x.mx
:login
select public.delete_my_account();
reset role;
select tests.ok((select count(*) from public.profiles where id = :'RA') = 0, 'profile deleted');
select tests.ok((select count(*) from auth.users where id = :'RA') = 0, 'auth user deleted');
select tests.ok((select count(*) from public.privacy_log where action = 'account_deleted' and actor is null) = 1, 'deletion logged, actor nulled');

-- [5] Internals are not callable through the API
set role anon;
select set_config('request.jwt.claims', '', false) is not null as _;
select tests.raises($$select public.accept_terms('x')$$, 'permission denied', 'anon cannot accept terms');
select tests.raises($$select public.export_my_data()$$, 'permission denied', 'anon cannot export');
reset role;
set role authenticated;
select tests.raises($$select public.wipe_clinic(gen_random_uuid())$$, 'permission denied', 'wipe_clinic is internal');
select tests.raises($$select public.log_privacy_event(null, 'x', '{}')$$, 'permission denied', 'log_privacy_event is internal');
reset role;
