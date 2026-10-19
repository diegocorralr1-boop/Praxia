-- Account lifecycle, members and platform admins (0006).
\set login 'set role authenticated; select set_config(''request.jwt.claims'', format(''{"sub":"%s","email":"%s","role":"authenticated"}'', :''who'', :''mail''), false) is not null as _;'
\set U1 11111111-0000-0000-0000-000000000001
\set U2 11111111-0000-0000-0000-000000000002
\set R1 11111111-0000-0000-0000-000000000003
\set BAD 11111111-0000-0000-0000-000000000004
\set ANA 11111111-0000-0000-0000-000000000005
\set BOB 11111111-0000-0000-0000-000000000006
\set ADM 11111111-0000-0000-0000-000000000008
\set CLI 11111111-0000-0000-0000-000000000009
\set OLD 11111111-0000-0000-0000-000000000010
\set NOP 11111111-0000-0000-0000-000000000011
insert into public.platform_admins (email) values ('admin@x.mx');

-- [1] Sign-up with pending_clinic, confirmed later (the production flow)
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  (:'U1', 'u1@x.mx', null, '{"pending_clinic":"Clinica Uno","display_name":"Dra. Uno"}');
select tests.ok((select status = 'pending_email' and clinic_id is null and display_name = 'Dra. Uno' from public.profiles where id = :'U1'), 'profile created pending_email');
\set who :U1
\set mail u1@x.mx
:login
select tests.ok((public.my_account_state() ->> 'status') = 'pending_email' and (public.my_account_state() -> 'pending' ->> 'clinic_name') = 'Clinica Uno', 'state shows pending clinic before confirmation');
reset role;
update auth.users set email_confirmed_at = now() where id = :'U1';
select tests.ok((select p.status = 'active' and p.role = 'manager' and c.name = 'Clinica Uno' and c.owner_id = p.id and p.onboarded_at is not null
                   from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = :'U1'), 'confirmation trigger created the clinic');
select tests.ok((select array_agg(event order by id) from public.account_events where user_id = :'U1') = array['signup','email_confirmed','clinic_created'], 'events logged in order');
:login
select tests.ok(public.finish_onboarding() = 'active' and (select count(*) from public.clinics where name = 'Clinica Uno') = 1, 'finish_onboarding is idempotent');
reset role;

-- [2] Confirmation disabled: confirmed at insert → active immediately
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (:'U2', 'u2@x.mx', now(), '{"pending_clinic":"Clinica Dos","display_name":"Dr. Dos"}');
select tests.ok((select status = 'active' and role = 'manager' from public.profiles where id = :'U2'), 'active right after sign-up when confirmation is off');

-- [3] Invite reserved at sign-up survives expiry until the email is confirmed
\set who :U1
\set mail u1@x.mx
:login
select public.create_invite('recepcion') as code1 \gset
select public.create_invite() as code_any \gset
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (:'R1', 'r1@x.mx', null, jsonb_build_object('pending_invite', lower(:'code1'), 'display_name', 'Recepción Uno'));
select tests.ok((select reserved_by = :'R1'::uuid from public.invites where code = :'code1'), 'invite reserved for the new user');
update public.invites set expires_at = now() - interval '1 hour' where code = :'code1';
update auth.users set email_confirmed_at = now() where id = :'R1';
select tests.ok((select p.status = 'active' and p.role = 'recepcion' and c.name = 'Clinica Uno' and p.invited_by = :'U1'::uuid
                   from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = :'R1'), 'expired-but-reserved invite still redeemed on confirmation');
select tests.ok((select used_by = :'R1'::uuid from public.invites where code = :'code1'), 'invite marked used');

-- [4] Invalid code at sign-up: clear error, and the user can still create a clinic
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (:'BAD', 'bad@x.mx', null, '{"pending_invite":"NOPE-NOPE-NOPE-NOPE"}');
select tests.ok((select count(*) from public.account_events where user_id = :'BAD' and event = 'invite_invalid') = 1, 'invalid invite logged, sign-up not blocked');
update auth.users set email_confirmed_at = now() where id = :'BAD';
\set who :BAD
\set mail bad@x.mx
:login
select tests.ok((public.my_account_state() ->> 'status') = 'needs_clinic' and (public.my_account_state() ->> 'onboarding_error') = 'invalid_or_used_code', 'state exposes the onboarding error');
select tests.ok(public.bootstrap_clinic('Clinica Bad', 'Dr. Bad') is not null, 'bootstrap_clinic works from the onboarding screen');
select tests.ok((public.my_account_state() ->> 'status') = 'active' and (public.my_account_state() ->> 'onboarding_error') is null, 'error cleared once active');
reset role;

-- [5] Email-bound invite
\set who :U1
\set mail u1@x.mx
:login
select public.create_invite('recepcion', 'Ana@x.mx') as code_ana \gset
select tests.raises($$select public.create_invite('recepcion', 'not-an-email')$$, 'bad_email', 'invite email validated');
reset role;
insert into auth.users (id, email, email_confirmed_at) values (:'BOB', 'bob@x.mx', now()), (:'ANA', 'ana@x.mx', now());
\set who :BOB
\set mail bob@x.mx
:login
select tests.ok(public.accept_invite(:'code_ana') is null, 'wrong email cannot redeem');
reset role;
\set who :ANA
\set mail ana@x.mx
:login
select tests.ok(public.accept_invite(:'code_ana') is not null, 'bound email redeems');
reset role;

-- [6] check_invite for anonymous callers
set role anon;
select set_config('request.jwt.claims', '', false) is not null as _;
select tests.ok((public.check_invite(:'code_ana') ->> 'reason') = 'used', 'used code reported');
select tests.ok((public.check_invite('xxx') ->> 'reason') = 'not_found', 'unknown code reported');
select tests.ok((public.check_invite(:'code_any') ->> 'valid') = 'true' and (public.check_invite(:'code_any') ->> 'clinic_name') = 'Clinica Uno', 'valid code shows the clinic');
reset role;

-- [7] Member management guards
\set who :U1
\set mail u1@x.mx
:login
select public.save_entry(null, 'Paciente Uno', null, public.clinic_today(), 'Completo', null, null, '[{"concepto":"REV","amount":100,"method":"Pesos (MXN)"}]'::jsonb);
select tests.ok(jsonb_array_length(public.list_members() -> 'members') = 3 and jsonb_array_length(public.list_members() -> 'invites') = 1, 'list_members shows members and open invites');
select public.set_member_role(:'ANA', 'manager');
select tests.raises($$select public.set_member_status('11111111-0000-0000-0000-000000000001', 'disabled')$$, 'cannot_change_self', 'cannot disable self');
reset role;
\set who :ANA
\set mail ana@x.mx
:login
select tests.raises($$select public.set_member_role('11111111-0000-0000-0000-000000000001', 'recepcion')$$, 'cannot_change_owner', 'only admins change the owner');
select public.set_member_status(:'R1', 'disabled');
reset role;
\set who :R1
\set mail r1@x.mx
:login
select tests.ok((public.my_account_state() ->> 'status') = 'disabled', 'disabled state reported');
select tests.ok((select count(*) from public.entries) = 0, 'disabled user sees no entries');
select tests.raises($$select public.save_entry(null,'X',null,current_date,'Completo',null,null,'[{"concepto":"REV","amount":1,"method":"Pesos (MXN)"}]'::jsonb)$$, 'no_clinic', 'disabled user cannot write');
reset role;
\set who :U1
\set mail u1@x.mx
:login
select public.set_member_status(:'R1', 'active');
select public.set_member_role(:'ANA', 'recepcion');
select public.remove_member(:'R1');
reset role;
\set who :R1
\set mail r1@x.mx
:login
select tests.ok((public.my_account_state() ->> 'status') = 'needs_clinic' and (public.my_account_state() -> 'clinic') = 'null'::jsonb, 'removed member is detached');
select tests.raises($$select public.remove_member('11111111-0000-0000-0000-000000000001')$$, 'no_permission', 'detached user cannot manage anyone');
reset role;

-- [8] Platform admin
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (:'ADM', 'admin@x.mx', now(), '{}');
select tests.ok((select user_id = :'ADM'::uuid from public.platform_admins where email = 'admin@x.mx'), 'admin row linked by the sign-up trigger');
\set who :ADM
\set mail admin@x.mx
:login
select tests.ok((public.my_account_state() -> 'is_admin')::boolean and (public.my_account_state() ->> 'status') = 'needs_clinic', 'admin without a clinic is still an admin');
select tests.ok(jsonb_array_length(public.admin_list_clinics()) = 3, 'admin lists all clinics');
select tests.ok(jsonb_array_length(public.admin_list_users('bad')) = 1 and (public.admin_list_users('bad') -> 0 ->> 'email') = 'bad@x.mx', 'admin searches users and sees emails');
select public.admin_create_clinic('Cliente X') as cx \gset
select tests.ok(length(:'cx'::jsonb ->> 'invite_code') = 16, 'admin_create_clinic returns a manager code');
select (:'cx'::jsonb ->> 'clinic_id')::uuid as cx_id \gset
select (:'cx'::jsonb ->> 'invite_code') as cx_code \gset
select tests.ok((select count(*) from public.platform_admins) = 1, 'admin can read platform_admins');
reset role;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (:'CLI', 'cliente@x.mx', now(), jsonb_build_object('pending_invite', :'cx_code'));
select tests.ok((select p.status = 'active' and p.role = 'manager' and c.name = 'Cliente X' from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = :'CLI'), 'client became manager of the admin-created clinic');
\set who :ADM
\set mail admin@x.mx
:login
select public.admin_set_clinic_status(:'cx_id', 'suspended');
reset role;
\set who :CLI
\set mail cliente@x.mx
:login
select tests.ok((public.my_account_state() ->> 'status') = 'clinic_suspended', 'suspended clinic reported to its members');
select tests.ok((select count(*) from public.clinics) = 0, 'suspended member cannot read the clinic');
select tests.ok(public.admin_list_clinics() is null, 'client gets nothing from admin RPCs');
select tests.raises($$select public.admin_create_clinic('Hack')$$, 'no_permission', 'client cannot create clinics as admin');
reset role;
\set who :ADM
\set mail admin@x.mx
:login
select public.admin_set_clinic_status(:'cx_id', 'active');
select tests.ok(length(public.admin_create_invite(:'cx_id', 'recepcion')) = 16, 'admin can invite into any clinic');
select tests.raises($$select public.remove_member('11111111-0000-0000-0000-000000000006')$$, 'not_a_member', 'cannot remove a user who has no clinic');
reset role;

-- [9] Legacy stuck user and self-healing profile
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (:'OLD', 'old@x.mx', now(), '{"pending_clinic":"Clinica Vieja"}');
update public.profiles set clinic_id = null, status = 'needs_clinic', role = 'recepcion' where id = :'OLD';
delete from public.clinics where name = 'Clinica Vieja';
\set who :OLD
\set mail old@x.mx
:login
select tests.ok((public.my_account_state() -> 'pending' ->> 'clinic_name') = 'Clinica Vieja', 'stuck user still has the pending clinic');
select tests.ok(public.finish_onboarding() = 'active' and (public.my_account_state() -> 'clinic' ->> 'name') = 'Clinica Vieja', 'finish_onboarding rescues the stuck user');
reset role;
insert into auth.users (id, email, email_confirmed_at) values (:'NOP', 'nop@x.mx', now());
delete from public.profiles where id = :'NOP';
\set who :NOP
\set mail nop@x.mx
:login
select tests.ok((public.my_account_state() ->> 'status') = 'needs_clinic', 'missing profile is recreated');
reset role;

-- [10] Admin deletions and the 0005 flows still work
\set who :ADM
\set mail admin@x.mx
:login
select tests.raises($$select public.admin_delete_user('11111111-0000-0000-0000-000000000001')$$, 'delete_clinic_first', 'owner with members cannot be deleted directly');
select public.admin_delete_user(:'NOP');
select public.admin_delete_clinic(:'cx_id');
reset role;
select tests.ok((select count(*) from auth.users where id = :'NOP') = 0, 'admin deleted the user');
select tests.ok((select status = 'needs_clinic' and clinic_id is null from public.profiles where id = :'CLI'), 'client detached after clinic deletion');
\set who :U2
\set mail u2@x.mx
:login
select public.delete_clinic('Clinica Dos');
select tests.ok((public.my_account_state() ->> 'status') = 'needs_clinic', 'owner detached after deleting own clinic');
select public.delete_my_account();
reset role;
select tests.ok((select count(*) from auth.users where id = :'U2') = 0, 'account deleted');
