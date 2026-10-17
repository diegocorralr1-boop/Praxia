-- ============================================================================
-- Praxia · Registro — security + correctness fixes
-- Run AFTER 0001–0003. Run in: Supabase Studio → SQL Editor → New query → paste → Run.
-- Safe to run once on a live database; existing data is backfilled, not dropped.
--
-- What this fixes:
--   * Users could rewrite their own role / clinic_id (privilege escalation).
--   * Recepción could read invite codes and redeem a manager invite.
--   * Invite codes were short, never expired and could be brute-forced.
--   * Recepción could delete/alter charge lines without the deleteEntries cap.
--   * Recepción could read full history, bypassing monthlyTotals/analytics/export.
--   * Entry edits were non-atomic (items deleted, insert could fail).
--   * No audit trail of who changed money records.
--   * Server totals ignored per-line payment method (split payments).
--   * Exchange-rate changes rewrote historical revenue.
--   * USD detection depended on the method label containing "USD".
--   * Patients deduped by exact name only (accents, homonyms).
--   * fx_rate accepted 0 / negative values; caps JSON accepted anything.
--   * A manager redeeming another clinic's invite orphaned their clinic.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. HELPERS
-- ----------------------------------------------------------------------------
-- Clinic-local "today" (Tijuana). Used for the Recepción history window.
create or replace function public.clinic_today()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'America/Tijuana')::date;
$$;

-- Never returns null: unknown user / no clinic / missing key => false.
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

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'manager' and clinic_id is not null
                   from public.profiles where id = auth.uid()), false);
$$;

-- Recepción without monthlyTotals/analytics/exportData only sees the last 7 days.
-- Otherwise they could add up any month themselves from the raw rows.
create or replace function public.can_read_entry_date(d date)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_manager()
      or public.has_cap('monthlyTotals')
      or public.has_cap('analytics')
      or public.has_cap('exportData')
      or d >= public.clinic_today() - 7;
$$;

-- Accent/case/whitespace-insensitive patient key.
create or replace function public.norm_name(t text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(
           translate(lower(trim(coalesce(t, ''))),
                     'áàäâãéèëêíìïîóòöôõúùüûñç',
                     'aaaaaeeeeiiiiooooouuuunc'),
           '\s+', ' ', 'g');
$$;

-- ----------------------------------------------------------------------------
-- 1. PROFILES — users may only change their own display_name
-- ----------------------------------------------------------------------------
drop policy if exists profile_self_update on public.profiles;
create policy profile_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Belt and braces: even if grants are reset, API roles can't touch role/clinic_id.
-- SECURITY DEFINER RPCs run as the function owner, so they pass this check.
create or replace function public.guard_profile_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.role is distinct from old.role
          or new.clinic_id is distinct from old.clinic_id
          or new.id is distinct from old.id) then
    raise exception 'no_permission: role/clinic can only change via RPC';
  end if;
  return new;
end; $$;

drop trigger if exists guard_profile_update on public.profiles;
create trigger guard_profile_update before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ----------------------------------------------------------------------------
-- 2. INVITES — manager-only visibility, long codes, expiry, rate limit
-- ----------------------------------------------------------------------------
alter table public.invites
  add column if not exists expires_at timestamptz not null default now() + interval '48 hours';

-- Old 6-character codes are guessable: expire every unused one now.
update public.invites set expires_at = now() where used_at is null and expires_at > now();

drop policy if exists inv_read on public.invites;
create policy inv_read on public.invites
  for select using (clinic_id = public.current_clinic_id() and public.is_manager());

create table if not exists public.invite_attempts (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists invite_attempts_user_at on public.invite_attempts (user_id, at);
alter table public.invite_attempts enable row level security;   -- no policies: RPC-only

-- 16 hex chars (64 random bits) from two UUIDv4s, skipping their fixed nibbles.
create or replace function public.create_invite(p_role text default 'recepcion')
returns text language plpgsql security definer set search_path = public as $$
declare c text; a text; b text;
begin
  if not public.is_manager() then raise exception 'no_permission: manager only'; end if;
  if p_role not in ('manager','recepcion') then raise exception 'bad_role'; end if;
  a := replace(gen_random_uuid()::text, '-', '');
  b := replace(gen_random_uuid()::text, '-', '');
  c := upper(substr(a, 1, 12) || substr(b, 21, 4));
  insert into public.invites(code, clinic_id, role, created_by)
    values (c, public.current_clinic_id(), p_role, auth.uid());
  return c;
end; $$;

-- Returns the clinic id on success, NULL on a bad/expired/used code (so the failed
-- attempt is recorded instead of rolled back). Max 10 failures per user per hour.
-- A user already in a clinic cannot switch clinics this way.
create or replace function public.accept_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv record; v_code text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if (select clinic_id from public.profiles where id = auth.uid()) is not null then
    raise exception 'already_in_clinic';
  end if;
  if (select count(*) from public.invite_attempts
       where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_attempts';
  end if;

  v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select * into inv from public.invites
   where code = v_code and used_at is null and expires_at > now()
   for update;
  if not found then
    insert into public.invite_attempts(user_id) values (auth.uid());
    return null;
  end if;

  update public.profiles set clinic_id = inv.clinic_id, role = inv.role where id = auth.uid();
  if not found then
    insert into public.profiles(id, clinic_id, role) values (auth.uid(), inv.clinic_id, inv.role);
  end if;
  update public.invites set used_at = now(), used_by = auth.uid() where code = inv.code;
  return inv.clinic_id;
end; $$;

-- ----------------------------------------------------------------------------
-- 3. SETTINGS — validated writes
-- ----------------------------------------------------------------------------
create or replace function public.set_fx_rate(p_rate numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_cap('editFx') then raise exception 'no_permission: editFx'; end if;
  if p_rate is null or p_rate <= 0 or p_rate > 1000 then raise exception 'bad_fx_rate'; end if;
  update public.clinic_settings
     set fx_rate = p_rate, updated_at = now()
   where clinic_id = public.current_clinic_id();
end; $$;

-- Only known keys, only booleans.
create or replace function public.set_recepcion_caps(p_caps jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare clean jsonb := '{}'::jsonb; k text;
begin
  if not public.is_manager() then raise exception 'no_permission: manager only'; end if;
  foreach k in array array['dailyTotals','monthlyTotals','analytics','editCategories',
                           'editFx','exportData','deleteEntries','editEntries'] loop
    if p_caps ? k then
      if jsonb_typeof(p_caps -> k) <> 'boolean' then raise exception 'bad_caps: %', k; end if;
      clean := clean || jsonb_build_object(k, (p_caps ->> k)::boolean);
    end if;
  end loop;
  update public.clinic_settings
     set recepcion_caps = recepcion_caps || clean, updated_at = now()
   where clinic_id = public.current_clinic_id();
end; $$;

-- New cap: editing existing entries (default on, matching previous behaviour).
alter table public.clinic_settings
  alter column recepcion_caps set default jsonb_build_object(
    'dailyTotals',   true,
    'monthlyTotals', false,
    'analytics',     false,
    'editCategories',true,
    'editFx',        true,
    'exportData',    false,
    'deleteEntries', true,
    'editEntries',   true
  );
update public.clinic_settings
   set recepcion_caps = recepcion_caps || '{"editEntries": true}'::jsonb
 where not (recepcion_caps ? 'editEntries');

create or replace function public.bootstrap_clinic(p_clinic_name text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_clinic uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if (select clinic_id from public.profiles where id = auth.uid()) is not null then
    raise exception 'already_in_clinic';
  end if;
  if length(trim(coalesce(p_clinic_name, ''))) not between 1 and 120 then
    raise exception 'bad_clinic_name';
  end if;
  insert into public.clinics (name) values (trim(p_clinic_name)) returning id into new_clinic;
  insert into public.clinic_settings (clinic_id) values (new_clinic);
  insert into public.profiles (id, clinic_id, role, display_name)
    values (auth.uid(), new_clinic, 'manager', left(coalesce(nullif(trim(p_display_name), ''), 'Gerente'), 80))
  on conflict (id) do update set clinic_id = excluded.clinic_id, role = 'manager',
                                 display_name = excluded.display_name;
  return new_clinic;
end; $$;

-- ----------------------------------------------------------------------------
-- 4. CURRENCY PER METHOD + FX SNAPSHOT PER ENTRY
-- ----------------------------------------------------------------------------
alter table public.categories
  add column if not exists currency text not null default 'MXN' check (currency in ('MXN','USD'));
update public.categories set currency = 'USD'
 where kind = 'metodo' and label ~* '(usd|d[oó]lar)';

create or replace function public.categories_default_currency()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.kind = 'metodo' and tg_op = 'INSERT' and new.label ~* '(usd|d[oó]lar)' then
    new.currency := 'USD';
  end if;
  return new;
end; $$;
drop trigger if exists categories_default_currency on public.categories;
create trigger categories_default_currency before insert on public.categories
  for each row execute function public.categories_default_currency();

alter table public.entry_items add column if not exists currency text
  check (currency in ('MXN','USD'));
update public.entry_items ei
   set currency = case when coalesce(ei.method, e.method) ilike '%USD%' then 'USD' else 'MXN' end
  from public.entries e
 where ei.entry_id = e.id and ei.currency is null;
update public.entry_items ei set method = e.method
  from public.entries e where ei.entry_id = e.id and ei.method is null;
alter table public.entry_items alter column currency set default 'MXN';
alter table public.entry_items alter column currency set not null;

-- Rate in force when the charge was recorded. Existing rows get today's rate
-- (the best value available); from now on it is frozen per entry.
alter table public.entries add column if not exists fx_rate numeric(10,4);
update public.entries e set fx_rate = s.fx_rate
  from public.clinic_settings s where s.clinic_id = e.clinic_id and e.fx_rate is null;

-- ----------------------------------------------------------------------------
-- 5. PATIENTS — normalized key + optional phone to tell homonyms apart
-- ----------------------------------------------------------------------------
alter table public.patients add column if not exists phone_key text;
update public.patients
   set phone_key = nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')
 where phone_key is null;

alter table public.patients drop constraint if exists patients_clinic_id_name_key_key;

-- Re-key with accent folding, except where that would merge two existing records
-- (those keep their old key; merge them manually if they are the same person).
update public.patients p set name_key = public.norm_name(p.name)
 where p.name_key <> public.norm_name(p.name)
   and not exists (select 1 from public.patients q
                    where q.clinic_id = p.clinic_id and q.id <> p.id
                      and public.norm_name(q.name) = public.norm_name(p.name)
                      and coalesce(q.phone_key, '') = coalesce(p.phone_key, ''));

create unique index if not exists patients_clinic_name_phone
  on public.patients (clinic_id, name_key, coalesce(phone_key, ''));

-- Any member can create/edit patients, but deleting one needs deleteEntries.
drop policy if exists pat_all on public.patients;
create policy pat_select on public.patients
  for select using (clinic_id = public.current_clinic_id());
create policy pat_insert on public.patients
  for insert with check (clinic_id = public.current_clinic_id());
create policy pat_update on public.patients
  for update using (clinic_id = public.current_clinic_id())
            with check (clinic_id = public.current_clinic_id());
create policy pat_delete on public.patients
  for delete using (clinic_id = public.current_clinic_id() and public.has_cap('deleteEntries'));

-- ----------------------------------------------------------------------------
-- 6. ENTRIES / ITEMS / FILES — reads windowed, writes only via save_entry()
-- ----------------------------------------------------------------------------
drop policy if exists ent_select on public.entries;
drop policy if exists ent_insert on public.entries;
drop policy if exists ent_update on public.entries;
drop policy if exists ent_delete on public.entries;
create policy ent_select on public.entries
  for select using (clinic_id = public.current_clinic_id()
                    and public.can_read_entry_date(entry_date));
create policy ent_delete on public.entries
  for delete using (clinic_id = public.current_clinic_id()
                    and public.has_cap('deleteEntries')
                    and public.can_read_entry_date(entry_date));

drop policy if exists item_rw on public.entry_items;
create policy item_select on public.entry_items
  for select using (clinic_id = public.current_clinic_id()
                    and exists (select 1 from public.entries e where e.id = entry_id));

drop policy if exists file_insert on public.entry_files;
create policy file_insert on public.entry_files
  for insert with check (clinic_id = public.current_clinic_id()
                         and exists (select 1 from public.entries e
                                      where e.id = entry_id and e.clinic_id = public.current_clinic_id()));

-- One transaction: patient match/create, entry insert/update, items replace.
-- p_items: [{"concepto":"REV","modificador":"OD","amount":500,"method":"Pesos (MXN)"}, ...]
create or replace function public.save_entry(
  p_entry_id      uuid,
  p_patient_name  text,
  p_patient_phone text,
  p_entry_date    date,
  p_status        text,
  p_invoice_no    text,
  p_notes         text,
  p_items         jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_key    text := public.norm_name(p_patient_name);
  v_phone  text := nullif(regexp_replace(coalesce(p_patient_phone, ''), '\D', '', 'g'), '');
  v_pid    uuid;
  v_eid    uuid;
  v_fx     numeric;
  v_n      int;
  it       jsonb;
  v_amt    numeric;
  v_meth   text;
  v_cur    text;
  v_first  text;
begin
  if v_clinic is null then raise exception 'no_clinic'; end if;
  if v_key = '' or length(p_patient_name) > 160 then raise exception 'bad_patient_name'; end if;
  if p_entry_date is null or p_entry_date < date '2000-01-01'
     or p_entry_date > public.clinic_today() + 1 then raise exception 'bad_date'; end if;
  if not public.can_read_entry_date(p_entry_date) then raise exception 'no_permission: date outside window'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_items'; end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 50 then raise exception 'bad_items'; end if;
  -- entries.method kept for older readers: first line's method.
  v_first := coalesce(nullif(trim(p_items -> 0 ->> 'method'), ''), 'Pesos (MXN)');

  -- Patient: exact name+phone, else name without phone (adopts the phone),
  -- else the single same-name patient, else new. Two same-name patients and no
  -- phone given => ask the user to disambiguate.
  if v_phone is not null then
    select id into v_pid from public.patients
     where clinic_id = v_clinic and name_key = v_key and phone_key = v_phone;
    if v_pid is null then
      update public.patients set phone_key = v_phone, phone = coalesce(phone, p_patient_phone)
       where id = (select id from public.patients
                    where clinic_id = v_clinic and name_key = v_key and phone_key is null limit 1)
      returning id into v_pid;
    end if;
  else
    select id into v_pid from public.patients
     where clinic_id = v_clinic and name_key = v_key and phone_key is null;
    if v_pid is null then
      if (select count(*) from public.patients where clinic_id = v_clinic and name_key = v_key) > 1 then
        raise exception 'ambiguous_patient';
      end if;
      select id into v_pid from public.patients where clinic_id = v_clinic and name_key = v_key;
    end if;
  end if;
  if v_pid is null then
    insert into public.patients (clinic_id, name, name_key, phone, phone_key)
      values (v_clinic, trim(p_patient_name), v_key, nullif(trim(coalesce(p_patient_phone, '')), ''), v_phone)
      returning id into v_pid;
  end if;

  if p_entry_id is null then
    select fx_rate into v_fx from public.clinic_settings where clinic_id = v_clinic;
    insert into public.entries (clinic_id, patient_id, entry_date, status, method, invoice_no, notes, created_by, fx_rate)
      values (v_clinic, v_pid, p_entry_date, coalesce(nullif(trim(p_status), ''), 'Completo'), v_first,
              nullif(trim(coalesce(p_invoice_no, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
              auth.uid(), v_fx)
      returning id into v_eid;
  else
    if not public.has_cap('editEntries') then raise exception 'no_permission: editEntries'; end if;
    select id into v_eid from public.entries
     where id = p_entry_id and clinic_id = v_clinic
       and public.can_read_entry_date(entry_date)
     for update;
    if v_eid is null then raise exception 'entry_not_found'; end if;
    update public.entries
       set patient_id = v_pid, entry_date = p_entry_date,
           status = coalesce(nullif(trim(p_status), ''), status), method = v_first,
           invoice_no = nullif(trim(coalesce(p_invoice_no, '')), ''),
           notes = nullif(trim(coalesce(p_notes, '')), '')
     where id = v_eid;
    delete from public.entry_items where entry_id = v_eid;
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_amt := round((it ->> 'amount')::numeric, 2);
    if v_amt is null or v_amt < 0 or v_amt > 10000000 then raise exception 'bad_amount'; end if;
    if length(trim(coalesce(it ->> 'concepto', ''))) = 0 then raise exception 'bad_concepto'; end if;
    v_meth := coalesce(nullif(trim(it ->> 'method'), ''), 'Pesos (MXN)');
    select currency into v_cur from public.categories
     where clinic_id = v_clinic and kind = 'metodo' and label = v_meth limit 1;
    v_cur := coalesce(v_cur, case when v_meth ~* '(usd|d[oó]lar)' then 'USD' else 'MXN' end);
    insert into public.entry_items (entry_id, clinic_id, concepto, modificador, amount, method, currency)
      values (v_eid, v_clinic, trim(it ->> 'concepto'), nullif(trim(coalesce(it ->> 'modificador', '')), ''),
              v_amt, v_meth, v_cur);
  end loop;

  return v_eid;
end; $$;

-- ----------------------------------------------------------------------------
-- 7. AUDIT LOG — every insert/update/delete on entries and entry_items
-- ----------------------------------------------------------------------------
create table if not exists public.entry_audit (
  id         bigint generated always as identity primary key,
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  table_name text not null,
  row_id     uuid not null,
  entry_id   uuid,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  actor      uuid references public.profiles(id) on delete set null,
  at         timestamptz not null default now()
);
create index if not exists entry_audit_clinic_at on public.entry_audit (clinic_id, at desc);
alter table public.entry_audit enable row level security;
drop policy if exists audit_read on public.entry_audit;
create policy audit_read on public.entry_audit
  for select using (clinic_id = public.current_clinic_id() and public.is_manager());

create or replace function public.audit_entry_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  -- Skip item rows removed by a clinic/entry cascade whose parent is already gone.
  if not exists (select 1 from public.clinics where id = (r ->> 'clinic_id')::uuid) then
    return null;
  end if;
  insert into public.entry_audit (clinic_id, table_name, row_id, entry_id, action, old_data, new_data, actor)
  values ((r ->> 'clinic_id')::uuid, tg_table_name, (r ->> 'id')::uuid,
          case when tg_table_name = 'entries' then (r ->> 'id')::uuid else (r ->> 'entry_id')::uuid end,
          lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          auth.uid());
  return null;
end; $$;

drop trigger if exists audit_entries on public.entries;
create trigger audit_entries after insert or update or delete on public.entries
  for each row execute function public.audit_entry_change();
drop trigger if exists audit_entry_items on public.entry_items;
create trigger audit_entry_items after insert or update or delete on public.entry_items
  for each row execute function public.audit_entry_change();

-- ----------------------------------------------------------------------------
-- 8. AGGREGATES — per-line currency, per-entry fx, history window
-- ----------------------------------------------------------------------------
create or replace function public.entry_mxn(p_entry uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(ei.amount * case when ei.currency = 'USD' then coalesce(e.fx_rate, s.fx_rate) else 1 end), 0)
  from public.entries e
  join public.entry_items ei on ei.entry_id = e.id
  join public.clinic_settings s on s.clinic_id = e.clinic_id
  where e.id = p_entry
    and e.clinic_id = public.current_clinic_id()
    and public.can_read_entry_date(e.entry_date);
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
           coalesce(sum(ei.amount * case when ei.currency = 'USD' then coalesce(e.fx_rate, s.fx_rate) else 1 end), 0)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and date_trunc('month', e.entry_date) = date_trunc('month', p_month)
      and public.can_read_entry_date(e.entry_date)
    group by e.entry_date
    order by e.entry_date;
end; $$;

create or replace function public.get_monthly_total(p_month date)
returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_cap('monthlyTotals') then raise exception 'no_permission: monthlyTotals'; end if;
  return coalesce((
    select sum(ei.amount * case when ei.currency = 'USD' then coalesce(e.fx_rate, s.fx_rate) else 1 end)
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
           coalesce(sum(ei.amount * case when ei.currency = 'USD' then coalesce(e.fx_rate, s.fx_rate) else 1 end), 0)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and e.entry_date between p_from and p_to
    group by ei.concepto
    order by 2 desc;
end; $$;

-- ----------------------------------------------------------------------------
-- 9. FUNCTION EXECUTE GRANTS — signed-in users only
-- ----------------------------------------------------------------------------
revoke execute on function
  public.current_clinic_id(), public.current_role_name(), public.has_cap(text),
  public.is_manager(), public.can_read_entry_date(date),
  public.set_fx_rate(numeric), public.set_recepcion_caps(jsonb),
  public.entry_mxn(uuid), public.get_daily_totals(date), public.get_monthly_total(date),
  public.get_revenue_by_concepto(date, date), public.bootstrap_clinic(text, text),
  public.create_invite(text), public.accept_invite(text),
  public.save_entry(uuid, text, text, date, text, text, text, jsonb)
from public, anon;
grant execute on function
  public.current_clinic_id(), public.current_role_name(), public.has_cap(text),
  public.is_manager(), public.can_read_entry_date(date),
  public.set_fx_rate(numeric), public.set_recepcion_caps(jsonb),
  public.entry_mxn(uuid), public.get_daily_totals(date), public.get_monthly_total(date),
  public.get_revenue_by_concepto(date, date), public.bootstrap_clinic(text, text),
  public.create_invite(text), public.accept_invite(text),
  public.save_entry(uuid, text, text, date, text, text, text, jsonb)
to authenticated;
