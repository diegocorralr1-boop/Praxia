-- ============================================================================
-- Praxia · Registro — privacidad y cumplimiento (LFPDPPP)
-- Run AFTER 0001–0004. Run in: Supabase Studio → SQL Editor → New query → paste → Run.
-- Safe on a live database: adds columns/tables/functions only; no data is dropped.
--
-- What this adds:
--   * Proof of consent: which version of the Aviso/Términos each user accepted, and when.
--   * privacy_log: consents, patient anonymizations, account and clinic deletions.
--   * anonymize_patient(): "cancelación" for a patient without losing the fiscal
--     revenue records (CFF art. 30 requires keeping them 5 years).
--   * delete_clinic(): a manager removes every record of their practice.
--   * delete_my_account(): any user removes their own account (ARCO: cancelación).
--   * export_my_data(): a user downloads the data Praxia holds about them (ARCO: acceso).
-- The app works with or without this migration; the Privacidad tab shows a notice
-- until it is applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CONSENT RECORD
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists terms_version     text;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;

-- ----------------------------------------------------------------------------
-- 2. PRIVACY LOG — written only by the RPCs below (no insert policy for API roles)
-- ----------------------------------------------------------------------------
create table if not exists public.privacy_log (
  id         bigint generated always as identity primary key,
  clinic_id  uuid references public.clinics(id) on delete set null,   -- null once the clinic is deleted
  actor      uuid references public.profiles(id) on delete set null,  -- null once the account is deleted
  actor_name text,                                                    -- snapshot, survives both deletions
  action     text not null,                                           -- terms_accepted | patient_anonymized | account_deleted | clinic_deleted
  details    jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index if not exists privacy_log_clinic_at on public.privacy_log (clinic_id, at desc);
create index if not exists privacy_log_actor_at  on public.privacy_log (actor, at desc);
alter table public.privacy_log enable row level security;
drop policy if exists privacy_log_read on public.privacy_log;
create policy privacy_log_read on public.privacy_log
  for select using (actor = auth.uid()
                    or (clinic_id is not null and clinic_id = public.current_clinic_id() and public.is_manager()));

create or replace function public.log_privacy_event(p_clinic uuid, p_action text, p_details jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.privacy_log (clinic_id, actor, actor_name, action, details)
  values (p_clinic, auth.uid(),
          (select display_name from public.profiles where id = auth.uid()),
          p_action, coalesce(p_details, '{}'::jsonb));
$$;
revoke execute on function public.log_privacy_event(uuid, text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. accept_terms(version) — called by the app after the user ticks the box
-- ----------------------------------------------------------------------------
create or replace function public.accept_terms(p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_version is null or length(trim(p_version)) not between 1 and 32 then raise exception 'bad_version'; end if;
  update public.profiles
     set terms_version = trim(p_version), terms_accepted_at = now()
   where id = auth.uid();
  if not found then raise exception 'no_profile'; end if;
  perform public.log_privacy_event(public.current_clinic_id(), 'terms_accepted',
                                   jsonb_build_object('version', trim(p_version)));
end; $$;

-- ----------------------------------------------------------------------------
-- 4. anonymize_patient(id) — cancelación compatible with fiscal retention
-- Keeps the entries (amounts, dates, concepts) and removes everything that
-- identifies the person: name, phone, email, notes, and the free-text notes on
-- their visits (including the copies in entry_audit).
-- ----------------------------------------------------------------------------
alter table public.patients add column if not exists anonymized_at timestamptz;

create or replace function public.anonymize_patient(p_patient uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_label  text;
  v_n      int;
begin
  if v_clinic is null then raise exception 'no_clinic'; end if;
  if not (public.is_manager() or public.has_cap('deleteEntries')) then
    raise exception 'no_permission: deleteEntries';
  end if;
  if not exists (select 1 from public.patients where id = p_patient and clinic_id = v_clinic) then
    raise exception 'patient_not_found';
  end if;
  if exists (select 1 from public.patients where id = p_patient and anonymized_at is not null) then
    raise exception 'already_anonymized';
  end if;

  v_label := 'Paciente eliminado ' || left(replace(p_patient::text, '-', ''), 8);
  update public.patients
     set name = v_label, name_key = public.norm_name(v_label),
         phone = null, phone_key = null, email = null, notes = null,
         anonymized_at = now()
   where id = p_patient;

  update public.entries set notes = null
   where patient_id = p_patient and clinic_id = v_clinic and notes is not null;
  get diagnostics v_n = row_count;

  -- entry_audit keeps before/after snapshots of entries; strip the notes from those too.
  update public.entry_audit
     set old_data = case when old_data ? 'notes' then jsonb_set(old_data, '{notes}', 'null'::jsonb) else old_data end,
         new_data = case when new_data ? 'notes' then jsonb_set(new_data, '{notes}', 'null'::jsonb) else new_data end
   where clinic_id = v_clinic and table_name = 'entries'
     and entry_id in (select id from public.entries where patient_id = p_patient);

  perform public.log_privacy_event(v_clinic, 'patient_anonymized',
                                   jsonb_build_object('patient_id', p_patient, 'entries_with_notes_cleared', v_n));
end; $$;

-- ----------------------------------------------------------------------------
-- 5. delete_clinic(confirm_name) — manager wipes the whole practice
-- Members keep their accounts but leave the clinic (clinic_id = null).
-- Deletion order respects entries.patient_id ON DELETE RESTRICT.
-- ----------------------------------------------------------------------------
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
  update public.profiles set clinic_id = null, role = 'recepcion' where clinic_id = v_clinic;
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
revoke execute on function public.wipe_clinic(uuid) from public, anon, authenticated;

create or replace function public.delete_clinic(p_confirm_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_clinic uuid := public.current_clinic_id(); v_name text; c jsonb;
begin
  if v_clinic is null then raise exception 'no_clinic'; end if;
  if not public.is_manager() then raise exception 'no_permission: manager only'; end if;
  select name into v_name from public.clinics where id = v_clinic;
  if trim(coalesce(p_confirm_name, '')) <> trim(v_name) then raise exception 'confirm_name_mismatch'; end if;
  -- Log first (while the actor still has a clinic to show in their own history), then wipe.
  c := public.wipe_clinic(v_clinic);
  perform public.log_privacy_event(null, 'clinic_deleted', c);
end; $$;

-- ----------------------------------------------------------------------------
-- 6. delete_my_account() — the user removes themself (profile + auth user)
-- A manager who is the only manager of a clinic that still has data or other
-- members must delete the clinic (or invite another manager) first.
-- ----------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_clinic uuid;
  v_role   text;
  v_others int;
  v_mgrs   int;
  v_data   int;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select clinic_id, role into v_clinic, v_role from public.profiles where id = v_uid;

  if v_clinic is not null and v_role = 'manager' then
    select count(*) into v_mgrs   from public.profiles where clinic_id = v_clinic and role = 'manager' and id <> v_uid;
    select count(*) into v_others from public.profiles where clinic_id = v_clinic and id <> v_uid;
    select count(*) into v_data   from public.patients where clinic_id = v_clinic;
    if v_mgrs = 0 then
      if v_others > 0 or v_data > 0 then raise exception 'delete_clinic_first'; end if;
      -- Sole member of an empty practice: remove the empty clinic as well.
      perform public.wipe_clinic(v_clinic);
      v_clinic := null;
    end if;
  end if;

  perform public.log_privacy_event(v_clinic, 'account_deleted', jsonb_build_object('role', v_role));
  delete from public.profiles where id = v_uid;
  delete from auth.users where id = v_uid;   -- ends every session of this user
end; $$;

-- ----------------------------------------------------------------------------
-- 7. export_my_data() — ARCO "acceso": what Praxia holds about this user
-- (Patients' data belongs to the clinic and is exported from Ajustes → Datos.)
-- ----------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'account', jsonb_build_object(
        'id', auth.uid(),
        'email', (current_setting('request.jwt.claims', true)::jsonb ->> 'email')),
    'profile', (select to_jsonb(p) - 'id' from public.profiles p where p.id = auth.uid()),
    'clinic',  (select jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at)
                  from public.clinics c where c.id = public.current_clinic_id()),
    'privacy_events', coalesce((select jsonb_agg(to_jsonb(l) - 'actor' order by l.at)
                                  from public.privacy_log l where l.actor = auth.uid()), '[]'::jsonb),
    'entries_created', (select count(*) from public.entries where created_by = auth.uid())
  );
$$;

-- ----------------------------------------------------------------------------
-- 8. EXECUTE GRANTS — signed-in users only
-- ----------------------------------------------------------------------------
revoke execute on function
  public.accept_terms(text), public.anonymize_patient(uuid), public.delete_clinic(text),
  public.delete_my_account(), public.export_my_data()
from public, anon;
grant execute on function
  public.accept_terms(text), public.anonymize_patient(uuid), public.delete_clinic(text),
  public.delete_my_account(), public.export_my_data()
to authenticated;
