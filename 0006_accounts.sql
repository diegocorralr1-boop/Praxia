-- ============================================================================
-- Praxia · Registro — cuentas: ciclo de vida, miembros y administradores
-- Run AFTER 0001–0005. Run in: Supabase Studio → SQL Editor → New query → paste → Run.
-- Safe on a live database: adds columns/tables/functions and backfills; nothing is dropped.
--
-- What this fixes / adds (see docs/PLAN-CUENTAS.md):
--   * Sign-up never finished after email confirmation: profile_read hid the new
--     user's own row (clinic_id NULL), so the app never called bootstrap_clinic.
--   * The server now finishes the sign-up itself when the email is confirmed
--     (trigger), from the metadata saved at sign-up; the app only retries/shows.
--   * Account status: pending_email → needs_clinic → active → disabled.
--   * account_events: every step of every sign-up, for support.
--   * Managers: list members, remove, change role, disable, revoke invites.
--   * Platform admins (platform_admins table): see and manage every clinic and
--     user; create clinics + invite codes for clients. They never get the
--     clinics' patient/revenue data through this (RLS unchanged for those tables).
--   * Invites: 7-day expiry, optional email binding, reserved at sign-up so a
--     slow confirmation doesn't lose the code.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. COLUMNS
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists status           text not null default 'needs_clinic'
    check (status in ('pending_email','needs_clinic','active','disabled')),
  add column if not exists onboarded_at     timestamptz,
  add column if not exists created_via      text,
  add column if not exists invited_by       uuid references public.profiles(id) on delete set null,
  add column if not exists onboarding_error text;

alter table public.clinics
  add column if not exists owner_id uuid references public.profiles(id) on delete set null,
  add column if not exists status   text not null default 'active' check (status in ('active','suspended'));

alter table public.invites
  add column if not exists email       text,
  add column if not exists reserved_by uuid references public.profiles(id) on delete set null,
  add column if not exists reserved_at timestamptz,
  add column if not exists revoked_at  timestamptz;
alter table public.invites alter column expires_at set default now() + interval '7 days';
create index if not exists invites_reserved_by on public.invites (reserved_by) where used_at is null;

-- Backfill existing accounts.
update public.profiles set status = 'active', onboarded_at = coalesce(onboarded_at, created_at)
 where clinic_id is not null and status <> 'disabled';
update public.profiles p set status = 'pending_email'
  from auth.users u where u.id = p.id and p.clinic_id is null and u.email_confirmed_at is null;
update public.clinics c set owner_id = (
  select p.id from public.profiles p where p.clinic_id = c.id and p.role = 'manager' order by p.created_at limit 1)
 where owner_id is null;

-- ----------------------------------------------------------------------------
-- 2. TABLES: account_events, platform_admins
-- ----------------------------------------------------------------------------
create table if not exists public.account_events (
  id        bigint generated always as identity primary key,
  user_id   uuid,            -- no FK: events outlive the account
  clinic_id uuid,
  actor     uuid,
  event     text not null,
  details   jsonb not null default '{}'::jsonb,
  at        timestamptz not null default now()
);
create index if not exists account_events_user_at   on public.account_events (user_id, at desc);
create index if not exists account_events_clinic_at on public.account_events (clinic_id, at desc);
alter table public.account_events enable row level security;

-- Who runs the platform. Rows are added in the SQL Editor (never through the API):
--   insert into public.platform_admins (email) values ('correo@dominio.mx');
-- The email must be the one the person uses to sign in to Praxia; the row is
-- linked to their auth user the first time they sign in after being added.
create table if not exists public.platform_admins (
  email    text primary key check (email = lower(email)),
  user_id  uuid unique,
  note     text,
  added_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

create or replace function public.jwt_email()
returns text language sql stable as $$
  select lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''));
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.platform_admins a
     where a.user_id = auth.uid()
        or (a.user_id is null and a.email <> '' and a.email = public.jwt_email()));
$$;

drop policy if exists platform_admins_read on public.platform_admins;
create policy platform_admins_read on public.platform_admins
  for select using (public.is_platform_admin());

drop policy if exists account_events_read on public.account_events;
create policy account_events_read on public.account_events
  for select using (user_id = auth.uid()
                    or (clinic_id is not null and clinic_id = public.current_clinic_id() and public.is_manager())
                    or public.is_platform_admin());

create or replace function public.log_account_event(p_user uuid, p_clinic uuid, p_event text, p_details jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.account_events (user_id, clinic_id, actor, event, details)
  values (p_user, p_clinic, auth.uid(), p_event, coalesce(p_details, '{}'::jsonb));
$$;

-- ----------------------------------------------------------------------------
-- 3. IDENTITY HELPERS — only ACTIVE members of ACTIVE clinics have a clinic.
-- Every existing RLS policy builds on these, so disabled users and suspended
-- clinics are locked out everywhere at once.
-- ----------------------------------------------------------------------------
create or replace function public.current_clinic_id()
returns uuid language sql stable security definer set search_path = public as $$
  select p.clinic_id from public.profiles p
  join public.clinics c on c.id = p.clinic_id
  where p.id = auth.uid() and p.status = 'active' and c.status = 'active';
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'manager' from public.profiles p
                   where p.id = auth.uid() and p.clinic_id is not null
                     and p.clinic_id = public.current_clinic_id()), false);
$$;

-- The fix for the sign-up bug: a user can always read their own profile row.
drop policy if exists profile_read on public.profiles;
create policy profile_read on public.profiles
  for select using (id = auth.uid() or clinic_id = public.current_clinic_id() or public.is_platform_admin());

drop policy if exists clinic_read on public.clinics;
create policy clinic_read on public.clinics
  for select using (id = public.current_clinic_id() or public.is_platform_admin());

drop policy if exists settings_read on public.clinic_settings;
create policy settings_read on public.clinic_settings
  for select using (clinic_id = public.current_clinic_id() or public.is_platform_admin());

drop policy if exists inv_read on public.invites;
create policy inv_read on public.invites
  for select using ((clinic_id = public.current_clinic_id() and public.is_manager()) or public.is_platform_admin());

drop policy if exists privacy_log_read on public.privacy_log;
create policy privacy_log_read on public.privacy_log
  for select using (actor = auth.uid()
                    or (clinic_id is not null and clinic_id = public.current_clinic_id() and public.is_manager())
                    or public.is_platform_admin());

-- ----------------------------------------------------------------------------
-- 4. INTERNAL ONBOARDING FUNCTIONS (not callable through the API)
-- ----------------------------------------------------------------------------
-- Profile row for a user, creating it if a trigger failed earlier (self-healing).
create or replace function public.ensure_profile(p_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  if exists (select 1 from public.profiles where id = p_uid) then return; end if;
  select email, email_confirmed_at, raw_user_meta_data into u from auth.users where id = p_uid;
  if u is null then raise exception 'no_auth_user'; end if;
  insert into public.profiles (id, role, display_name, status, created_via)
  values (p_uid, 'recepcion',
          left(nullif(trim(coalesce(u.raw_user_meta_data ->> 'display_name', '')), ''), 80),
          case when u.email_confirmed_at is null then 'pending_email' else 'needs_clinic' end,
          case when u.raw_user_meta_data ? 'pending_invite' then 'invite_code'
               when u.raw_user_meta_data ? 'pending_clinic' then 'signup' else 'unknown' end)
  on conflict (id) do nothing;
end; $$;

create or replace function public.normalize_code(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- Marks an invite as reserved for a user at sign-up, so it can't expire before
-- the email is confirmed. Never raises: an invalid code is just logged.
create or replace function public.reserve_invite(p_code text, p_uid uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare inv record; v_code text := public.normalize_code(p_code);
begin
  select * into inv from public.invites where code = v_code for update;
  if inv is null or inv.used_at is not null or inv.revoked_at is not null or inv.expires_at < now()
     or (inv.reserved_by is not null and inv.reserved_by <> p_uid)
     or (inv.email is not null and lower(inv.email) <> lower(coalesce(p_email, ''))) then
    perform public.log_account_event(p_uid, null, 'invite_invalid', jsonb_build_object('code', v_code));
    return;
  end if;
  update public.invites set reserved_by = p_uid, reserved_at = now() where code = v_code;
  perform public.log_account_event(p_uid, inv.clinic_id, 'invite_reserved', jsonb_build_object('code', v_code, 'role', inv.role));
end; $$;

create or replace function public.create_clinic_for(p_uid uuid, p_name text, p_display text)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_clinic uuid; p record;
begin
  perform public.ensure_profile(p_uid);
  select * into p from public.profiles where id = p_uid for update;
  if p.clinic_id is not null then raise exception 'already_in_clinic'; end if;
  if p.status = 'disabled' then raise exception 'account_disabled'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'bad_clinic_name'; end if;
  insert into public.clinics (name, owner_id, status) values (trim(p_name), p_uid, 'active') returning id into new_clinic;
  insert into public.clinic_settings (clinic_id) values (new_clinic);
  update public.profiles
     set clinic_id = new_clinic, role = 'manager', status = 'active',
         onboarded_at = coalesce(onboarded_at, now()), onboarding_error = null,
         display_name = coalesce(nullif(trim(coalesce(p_display, '')), ''), display_name, 'Gerente')
   where id = p_uid;
  perform public.log_account_event(p_uid, new_clinic, 'clinic_created', jsonb_build_object('name', trim(p_name)));
  return new_clinic;
end; $$;

create or replace function public.redeem_invite_for(p_code text, p_uid uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv record; p record; u record; v_code text := public.normalize_code(p_code);
begin
  perform public.ensure_profile(p_uid);
  select * into p from public.profiles where id = p_uid for update;
  if p.clinic_id is not null then raise exception 'already_in_clinic'; end if;
  if p.status = 'disabled' then raise exception 'account_disabled'; end if;
  select email into u from auth.users where id = p_uid;
  select * into inv from public.invites where code = v_code for update;
  if inv is null or inv.used_at is not null or inv.revoked_at is not null then raise exception 'invalid_or_used_code'; end if;
  if inv.expires_at < now() and inv.reserved_by is distinct from p_uid then raise exception 'expired_code'; end if;
  if inv.reserved_by is not null and inv.reserved_by <> p_uid then raise exception 'code_reserved_by_other'; end if;
  if inv.email is not null and lower(inv.email) <> lower(coalesce(u.email, '')) then raise exception 'invite_for_other_email'; end if;
  if not exists (select 1 from public.clinics where id = inv.clinic_id and status = 'active') then raise exception 'clinic_not_active'; end if;
  update public.profiles
     set clinic_id = inv.clinic_id, role = inv.role, status = 'active',
         onboarded_at = coalesce(onboarded_at, now()), onboarding_error = null,
         invited_by = inv.created_by, created_via = coalesce(created_via, 'invite_code')
   where id = p_uid;
  update public.invites set used_at = now(), used_by = p_uid where code = v_code;
  perform public.log_account_event(p_uid, inv.clinic_id, 'invite_redeemed', jsonb_build_object('code', v_code, 'role', inv.role));
  return inv.clinic_id;
end; $$;

-- Finishes a sign-up from what was saved at registration. Idempotent. Returns the
-- resulting status. Failures are recorded in profiles.onboarding_error, never raised.
create or replace function public.finish_onboarding_for(p_uid uuid)
returns text language plpgsql security definer set search_path = public as $$
declare p record; u record; md jsonb; inv record; v_name text;
begin
  perform public.ensure_profile(p_uid);
  select * into p from public.profiles where id = p_uid;
  if p.status = 'disabled' then return 'disabled'; end if;
  if p.clinic_id is not null then return p.status; end if;
  select email, email_confirmed_at, raw_user_meta_data into u from auth.users where id = p_uid;
  if u.email_confirmed_at is null then return 'pending_email'; end if;
  if p.status = 'pending_email' then update public.profiles set status = 'needs_clinic' where id = p_uid; end if;
  md := coalesce(u.raw_user_meta_data, '{}'::jsonb);
  begin
    select * into inv from public.invites
     where reserved_by = p_uid and used_at is null and revoked_at is null limit 1;
    if inv is not null then
      perform public.redeem_invite_for(inv.code, p_uid);
      return 'active';
    end if;
    if nullif(trim(coalesce(md ->> 'pending_invite', '')), '') is not null then
      perform public.redeem_invite_for(md ->> 'pending_invite', p_uid);   -- raises if invalid
      return 'active';
    end if;
    v_name := nullif(trim(coalesce(md ->> 'pending_clinic', '')), '');
    if v_name is not null then
      perform public.create_clinic_for(p_uid, v_name, md ->> 'display_name');
      return 'active';
    end if;
    return 'needs_clinic';
  exception when others then
    update public.profiles set onboarding_error = sqlerrm where id = p_uid;
    perform public.log_account_event(p_uid, null, 'onboarding_failed', jsonb_build_object('error', sqlerrm));
    return 'needs_clinic';
  end;
end; $$;

-- ----------------------------------------------------------------------------
-- 5. TRIGGERS ON auth.users — defensive: they never make the auth operation fail
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare md jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  begin
    perform public.ensure_profile(new.id);
    perform public.log_account_event(new.id, null, 'signup',
      jsonb_build_object('via', case when md ? 'pending_invite' then 'invite_code' when md ? 'pending_clinic' then 'signup' else 'unknown' end,
                         'confirmed_at_signup', new.email_confirmed_at is not null));
    if md ? 'pending_invite' then perform public.reserve_invite(md ->> 'pending_invite', new.id, new.email); end if;
    update public.platform_admins set user_id = new.id where user_id is null and email = lower(coalesce(new.email, ''));
    -- Email confirmation disabled (or admin-created user): finish right away.
    if new.email_confirmed_at is not null then perform public.finish_onboarding_for(new.id); end if;
  exception when others then
    begin perform public.log_account_event(new.id, null, 'trigger_error', jsonb_build_object('where', 'handle_new_user', 'error', sqlerrm));
    exception when others then null; end;
  end;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_email_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    begin
      perform public.ensure_profile(new.id);
      update public.profiles set status = 'needs_clinic' where id = new.id and status = 'pending_email';
      perform public.log_account_event(new.id, null, 'email_confirmed', '{}'::jsonb);
      update public.platform_admins set user_id = new.id where user_id is null and email = lower(coalesce(new.email, ''));
      perform public.finish_onboarding_for(new.id);
    exception when others then
      begin perform public.log_account_event(new.id, null, 'trigger_error', jsonb_build_object('where', 'handle_email_confirmed', 'error', sqlerrm));
      exception when others then null; end;
    end;
  end if;
  return new;
end; $$;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function public.handle_email_confirmed();

-- ----------------------------------------------------------------------------
-- 6. RPCs FOR THE SIGNED-IN USER
-- ----------------------------------------------------------------------------
-- One call that tells the app what to show. Self-heals a missing profile and
-- links a platform admin row on first sign-in.
create or replace function public.my_account_state()
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record; u record; md jsonb; v_admin boolean;
        c_id uuid; c_name text; c_status text; c_owner uuid; s_fx numeric; s_caps jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform public.ensure_profile(auth.uid());
  update public.platform_admins set user_id = auth.uid() where user_id is null and email = public.jwt_email();
  v_admin := public.is_platform_admin();
  select * into p from public.profiles where id = auth.uid();
  select email_confirmed_at, raw_user_meta_data into u from auth.users where id = auth.uid();
  md := coalesce(u.raw_user_meta_data, '{}'::jsonb);
  if p.clinic_id is not null then
    select id, name, status, owner_id into c_id, c_name, c_status, c_owner from public.clinics where id = p.clinic_id;
    select fx_rate, recepcion_caps into s_fx, s_caps from public.clinic_settings where clinic_id = p.clinic_id;
  end if;
  return jsonb_build_object(
    'status', case when p.status = 'active' and c_status = 'suspended' then 'clinic_suspended' else p.status end,
    'role', p.role,
    'display_name', p.display_name,
    'terms_version', p.terms_version,
    'email_confirmed', u.email_confirmed_at is not null,
    'is_admin', v_admin,
    'clinic', case when c_id is null then null else jsonb_build_object('id', c_id, 'name', c_name, 'status', c_status, 'is_owner', c_owner = p.id) end,
    'fx_rate', s_fx,
    'caps', s_caps,
    'pending', case when p.clinic_id is null then jsonb_strip_nulls(jsonb_build_object(
                 'clinic_name', nullif(trim(coalesce(md ->> 'pending_clinic', '')), ''),
                 'invite', case when (md ? 'pending_invite') or exists (select 1 from public.invites where reserved_by = p.id and used_at is null) then true else null end))
               else '{}'::jsonb end,
    'onboarding_error', p.onboarding_error
  );
end; $$;

-- The "Reintentar" button; also called automatically when the app sees a pending sign-up.
create or replace function public.finish_onboarding()
returns text language sql security definer set search_path = public as $$
  select public.finish_onboarding_for(auth.uid());
$$;

create or replace function public.bootstrap_clinic(p_clinic_name text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  return public.create_clinic_for(auth.uid(), p_clinic_name, p_display_name);
end; $$;

-- Same contract as 0004: NULL on a bad code (attempt recorded), 10 failures/hour.
create or replace function public.accept_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if (select count(*) from public.invite_attempts where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_attempts';
  end if;
  begin
    v := public.redeem_invite_for(p_code, auth.uid());
  exception when others then
    if sqlerrm in ('already_in_clinic', 'account_disabled') then raise; end if;
    insert into public.invite_attempts (user_id) values (auth.uid());
    perform public.log_account_event(auth.uid(), null, 'invite_invalid', jsonb_build_object('reason', sqlerrm));
    return null;
  end;
  return v;
end; $$;

-- Before registering: is this code good, and for which clinic? Codes have 64 random
-- bits, so exposing this to anonymous callers reveals nothing guessable.
create or replace function public.check_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select i.*, c.name as clinic_name, c.status as clinic_status into inv
    from public.invites i join public.clinics c on c.id = i.clinic_id
   where i.code = public.normalize_code(p_code);
  if inv is null then return jsonb_build_object('valid', false, 'reason', 'not_found'); end if;
  if inv.used_at is not null then return jsonb_build_object('valid', false, 'reason', 'used'); end if;
  if inv.revoked_at is not null then return jsonb_build_object('valid', false, 'reason', 'revoked'); end if;
  if inv.expires_at < now() then return jsonb_build_object('valid', false, 'reason', 'expired'); end if;
  if inv.clinic_status <> 'active' then return jsonb_build_object('valid', false, 'reason', 'clinic_suspended'); end if;
  return jsonb_build_object('valid', true, 'clinic_name', inv.clinic_name, 'role', inv.role,
                            'expires_at', inv.expires_at, 'email', inv.email);
end; $$;

-- ----------------------------------------------------------------------------
-- 7. MEMBER MANAGEMENT — managers of the clinic, or platform admins
-- ----------------------------------------------------------------------------
create or replace function public.can_manage_user(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or (public.is_manager() and exists (select 1 from public.profiles where id = p_uid and clinic_id = public.current_clinic_id()));
$$;

-- Internal invite creation shared by managers and admins.
create or replace function public.make_invite(p_clinic uuid, p_role text, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare c text; a text; b text;
begin
  if p_role not in ('manager', 'recepcion') then raise exception 'bad_role'; end if;
  if p_email is not null and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  a := replace(gen_random_uuid()::text, '-', '');
  b := replace(gen_random_uuid()::text, '-', '');
  c := upper(substr(a, 1, 12) || substr(b, 21, 4));
  insert into public.invites (code, clinic_id, role, created_by, email)
    values (c, p_clinic, p_role, auth.uid(), lower(nullif(trim(coalesce(p_email, '')), '')));
  perform public.log_account_event(null, p_clinic, 'invite_created', jsonb_build_object('role', p_role, 'email', lower(nullif(trim(coalesce(p_email, '')), ''))));
  return c;
end; $$;

create or replace function public.create_invite(p_role text default 'recepcion', p_email text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'no_permission: manager only'; end if;
  return public.make_invite(public.current_clinic_id(), p_role, p_email);
end; $$;

create or replace function public.revoke_invite(p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from public.invites where code = public.normalize_code(p_code) for update;
  if inv is null then raise exception 'not_found'; end if;
  if not (public.is_platform_admin() or (public.is_manager() and inv.clinic_id = public.current_clinic_id())) then
    raise exception 'no_permission';
  end if;
  if inv.used_at is not null then raise exception 'already_used'; end if;
  update public.invites set revoked_at = now() where code = inv.code;
  perform public.log_account_event(inv.reserved_by, inv.clinic_id, 'invite_revoked', jsonb_build_object('code', inv.code));
end; $$;

create or replace function public.list_members()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.is_manager() then null else jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'display_name', p.display_name, 'role', p.role, 'status', p.status,
        'is_owner', c.owner_id = p.id, 'is_me', p.id = auth.uid(),
        'joined_at', p.onboarded_at, 'created_via', p.created_via) order by c.owner_id = p.id desc, p.role, p.created_at)
      from public.profiles p join public.clinics c on c.id = p.clinic_id
      where p.clinic_id = public.current_clinic_id()), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object(
        'code', i.code, 'role', i.role, 'email', i.email, 'created_at', i.created_at, 'expires_at', i.expires_at,
        'reserved', i.reserved_by is not null, 'expired', i.expires_at < now() and i.reserved_by is null) order by i.created_at desc)
      from public.invites i
      where i.clinic_id = public.current_clinic_id() and i.used_at is null and i.revoked_at is null
        and (i.expires_at > now() or i.reserved_by is not null)), '[]'::jsonb)) end;
$$;

-- Guards shared by remove / role / status: the clinic keeps at least one active
-- manager, and only a platform admin may touch the owner.
create or replace function public.guard_member_change(p_uid uuid, p_losing_manager boolean)
returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from public.profiles where id = p_uid;
  if t is null or t.clinic_id is null then raise exception 'not_a_member'; end if;
  if not public.can_manage_user(p_uid) then raise exception 'no_permission'; end if;
  if exists (select 1 from public.clinics where id = t.clinic_id and owner_id = p_uid) and not public.is_platform_admin() then
    raise exception 'cannot_change_owner';
  end if;
  if p_losing_manager and t.role = 'manager' and t.status = 'active'
     and (select count(*) from public.profiles where clinic_id = t.clinic_id and role = 'manager' and status = 'active' and id <> p_uid) = 0 then
    raise exception 'last_manager';
  end if;
end; $$;

create or replace function public.remove_member(p_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if p_uid = auth.uid() and not public.is_platform_admin() then raise exception 'cannot_remove_self'; end if;
  perform public.guard_member_change(p_uid, true);
  select * into t from public.profiles where id = p_uid;
  update public.profiles set clinic_id = null, role = 'recepcion', status = 'needs_clinic' where id = p_uid;
  perform public.log_account_event(p_uid, t.clinic_id, 'member_removed', jsonb_build_object('role', t.role));
end; $$;

create or replace function public.set_member_role(p_uid uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if p_role not in ('manager', 'recepcion') then raise exception 'bad_role'; end if;
  perform public.guard_member_change(p_uid, p_role = 'recepcion');
  select * into t from public.profiles where id = p_uid;
  if t.role = p_role then return; end if;
  update public.profiles set role = p_role where id = p_uid;
  perform public.log_account_event(p_uid, t.clinic_id, 'role_changed', jsonb_build_object('from', t.role, 'to', p_role));
end; $$;

create or replace function public.set_member_status(p_uid uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if p_status not in ('active', 'disabled') then raise exception 'bad_status'; end if;
  if p_uid = auth.uid() then raise exception 'cannot_change_self'; end if;
  perform public.guard_member_change(p_uid, p_status = 'disabled');
  select * into t from public.profiles where id = p_uid;
  if t.status = p_status then return; end if;
  update public.profiles set status = p_status where id = p_uid;
  perform public.log_account_event(p_uid, t.clinic_id, 'status_changed', jsonb_build_object('from', t.status, 'to', p_status));
end; $$;

-- ----------------------------------------------------------------------------
-- 8. PLATFORM ADMIN RPCs
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_clinics()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.is_platform_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'status', c.status, 'created_at', c.created_at,
      'owner', (select display_name from public.profiles where id = c.owner_id),
      'members', (select count(*) from public.profiles where clinic_id = c.id),
      'entries', (select count(*) from public.entries where clinic_id = c.id),
      'last_entry', (select max(entry_date) from public.entries where clinic_id = c.id),
      'open_invites', (select count(*) from public.invites where clinic_id = c.id and used_at is null and revoked_at is null and expires_at > now()))
      order by c.created_at desc)
    from public.clinics c), '[]'::jsonb) end;
$$;

create or replace function public.admin_list_users(p_search text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.is_platform_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'email', u.email, 'display_name', p.display_name, 'role', p.role, 'status', coalesce(p.status, 'no_profile'),
      'clinic_id', p.clinic_id, 'clinic_name', c.name, 'created_at', u.created_at,
      'email_confirmed', u.email_confirmed_at is not null, 'last_sign_in_at', u.last_sign_in_at,
      'onboarding_error', p.onboarding_error, 'created_via', p.created_via,
      'is_admin', exists (select 1 from public.platform_admins a where a.user_id = u.id or a.email = lower(u.email)))
      order by u.created_at desc)
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.clinics c on c.id = p.clinic_id
    where p_search is null or p_search = '' or u.email ilike '%' || p_search || '%' or p.display_name ilike '%' || p_search || '%' or c.name ilike '%' || p_search || '%'), '[]'::jsonb) end;
$$;

-- Creates a clinic for a client and returns a manager invite code to hand over.
create or replace function public.admin_create_clinic(p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare new_clinic uuid; code text;
begin
  if not public.is_platform_admin() then raise exception 'no_permission: admin only'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'bad_clinic_name'; end if;
  insert into public.clinics (name, status) values (trim(p_name), 'active') returning id into new_clinic;
  insert into public.clinic_settings (clinic_id) values (new_clinic);
  perform public.log_account_event(null, new_clinic, 'clinic_created', jsonb_build_object('name', trim(p_name), 'by_admin', true));
  code := public.make_invite(new_clinic, 'manager', null);
  return jsonb_build_object('clinic_id', new_clinic, 'invite_code', code);
end; $$;

create or replace function public.admin_create_invite(p_clinic uuid, p_role text default 'recepcion', p_email text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'no_permission: admin only'; end if;
  if not exists (select 1 from public.clinics where id = p_clinic) then raise exception 'clinic_not_found'; end if;
  return public.make_invite(p_clinic, p_role, p_email);
end; $$;

create or replace function public.admin_set_clinic_status(p_clinic uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'no_permission: admin only'; end if;
  if p_status not in ('active', 'suspended') then raise exception 'bad_status'; end if;
  update public.clinics set status = p_status where id = p_clinic;
  if not found then raise exception 'clinic_not_found'; end if;
  perform public.log_account_event(null, p_clinic, 'clinic_status_changed', jsonb_build_object('to', p_status));
end; $$;

create or replace function public.admin_delete_clinic(p_clinic uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  if not public.is_platform_admin() then raise exception 'no_permission: admin only'; end if;
  if not exists (select 1 from public.clinics where id = p_clinic) then raise exception 'clinic_not_found'; end if;
  c := public.wipe_clinic(p_clinic);
  perform public.log_privacy_event(null, 'clinic_deleted', c || '{"by_admin": true}'::jsonb);
  perform public.log_account_event(null, p_clinic, 'clinic_deleted', c);
end; $$;

-- Deletes another user's account (test accounts, leavers). The owner of a clinic
-- with other members or data must be handled by deleting the clinic first.
create or replace function public.admin_delete_user(p_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not public.is_platform_admin() then raise exception 'no_permission: admin only'; end if;
  if p_uid = auth.uid() then raise exception 'cannot_delete_self'; end if;
  select * into t from public.profiles where id = p_uid;
  if t.clinic_id is not null then
    if exists (select 1 from public.clinics where id = t.clinic_id and owner_id = p_uid)
       and ((select count(*) from public.profiles where clinic_id = t.clinic_id) > 1
            or exists (select 1 from public.patients where clinic_id = t.clinic_id)) then
      raise exception 'delete_clinic_first';
    end if;
    if exists (select 1 from public.clinics where id = t.clinic_id and owner_id = p_uid) then
      perform public.wipe_clinic(t.clinic_id);
    end if;
  end if;
  perform public.log_account_event(p_uid, t.clinic_id, 'account_deleted', jsonb_build_object('by_admin', true));
  update public.platform_admins set user_id = null where user_id = p_uid;
  delete from public.profiles where id = p_uid;
  delete from auth.users where id = p_uid;
end; $$;

-- wipe_clinic (0005) must also reset the members' status now that it exists.
create or replace function public.wipe_clinic(v_clinic uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  select jsonb_build_object(
           'clinic_name', (select name from public.clinics where id = v_clinic),
           'members',  (select count(*) from public.profiles    where clinic_id = v_clinic),
           'patients', (select count(*) from public.patients    where clinic_id = v_clinic),
           'entries',  (select count(*) from public.entries     where clinic_id = v_clinic),
           'items',    (select count(*) from public.entry_items where clinic_id = v_clinic))
    into c;
  update public.profiles set clinic_id = null, role = 'recepcion',
         status = case when status = 'disabled' then 'disabled' else 'needs_clinic' end
   where clinic_id = v_clinic;
  delete from public.entry_files  where clinic_id = v_clinic;
  delete from public.entry_items  where clinic_id = v_clinic;
  delete from public.entries      where clinic_id = v_clinic;
  delete from public.patients     where clinic_id = v_clinic;
  delete from public.categories   where clinic_id = v_clinic;
  delete from public.invites      where clinic_id = v_clinic;
  delete from public.entry_audit  where clinic_id = v_clinic;
  delete from public.clinic_settings where clinic_id = v_clinic;
  delete from public.clinics      where id = v_clinic;
  return c;
end; $$;

-- ----------------------------------------------------------------------------
-- 9. GRANTS
-- ----------------------------------------------------------------------------
revoke execute on function
  public.log_account_event(uuid, uuid, text, jsonb), public.ensure_profile(uuid), public.reserve_invite(text, uuid, text),
  public.create_clinic_for(uuid, text, text), public.redeem_invite_for(text, uuid), public.finish_onboarding_for(uuid),
  public.make_invite(uuid, text, text), public.guard_member_change(uuid, boolean), public.wipe_clinic(uuid),
  public.handle_new_user(), public.handle_email_confirmed()
from public, anon, authenticated;

revoke execute on function
  public.jwt_email(), public.is_platform_admin(), public.normalize_code(text), public.can_manage_user(uuid),
  public.my_account_state(), public.finish_onboarding(), public.bootstrap_clinic(text, text), public.accept_invite(text),
  public.check_invite(text), public.create_invite(text, text), public.revoke_invite(text), public.list_members(),
  public.remove_member(uuid), public.set_member_role(uuid, text), public.set_member_status(uuid, text),
  public.admin_list_clinics(), public.admin_list_users(text), public.admin_create_clinic(text),
  public.admin_create_invite(uuid, text, text), public.admin_set_clinic_status(uuid, text),
  public.admin_delete_clinic(uuid), public.admin_delete_user(uuid)
from public, anon;

grant execute on function
  public.jwt_email(), public.is_platform_admin(), public.normalize_code(text), public.can_manage_user(uuid),
  public.my_account_state(), public.finish_onboarding(), public.bootstrap_clinic(text, text), public.accept_invite(text),
  public.check_invite(text), public.create_invite(text, text), public.revoke_invite(text), public.list_members(),
  public.remove_member(uuid), public.set_member_role(uuid, text), public.set_member_status(uuid, text),
  public.admin_list_clinics(), public.admin_list_users(text), public.admin_create_clinic(text),
  public.admin_create_invite(uuid, text, text), public.admin_set_clinic_status(uuid, text),
  public.admin_delete_clinic(uuid), public.admin_delete_user(uuid)
to authenticated;
grant execute on function public.check_invite(text), public.normalize_code(text) to anon;

-- The old create_invite(text) signature from 0002/0004 is replaced by create_invite(text, text).
drop function if exists public.create_invite(text);
