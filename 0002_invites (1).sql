-- ============================================================================
-- Praxia · Registro — invites (let reception join a clinic with a code)
-- Run in: Supabase Studio → SQL Editor → New query → paste → Run.
-- No secret key needed; works fully from the browser via these functions.
-- ============================================================================

create table public.invites (
  code        text primary key,
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  role        text not null default 'recepcion' check (role in ('manager','recepcion')),
  created_by  uuid references public.profiles(id),
  used_by     uuid references public.profiles(id),
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.invites enable row level security;

-- Managers can see their clinic's invite codes.
create policy inv_read on public.invites
  for select using (clinic_id = public.current_clinic_id());

-- Manager generates a 6-character invite code for their clinic.
create or replace function public.create_invite(p_role text default 'recepcion')
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if public.current_role_name() <> 'manager' then raise exception 'no_permission: manager only'; end if;
  if p_role not in ('manager','recepcion') then raise exception 'bad_role'; end if;
  c := upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6));
  insert into public.invites(code, clinic_id, role, created_by)
    values (c, public.current_clinic_id(), p_role, auth.uid());
  return c;
end; $$;

-- A signed-in user redeems a code: their profile is assigned to that clinic + role.
create or replace function public.accept_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from public.invites where code = upper(trim(p_code)) and used_at is null;
  if not found then raise exception 'invalid_or_used_code'; end if;
  update public.profiles set clinic_id = inv.clinic_id, role = inv.role where id = auth.uid();
  if not found then
    insert into public.profiles(id, clinic_id, role) values (auth.uid(), inv.clinic_id, inv.role);
  end if;
  update public.invites set used_at = now(), used_by = auth.uid() where code = inv.code;
  return inv.clinic_id;
end; $$;
