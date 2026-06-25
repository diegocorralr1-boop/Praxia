-- ============================================================================
-- Praxia · Registro — initial schema (Supabase / Postgres)
-- Multi-tenant. Permissions enforced server-side via RLS + SECURITY DEFINER RPCs.
-- Run in: Supabase Studio → SQL Editor (or `supabase db push` with this as a migration).
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- TENANCY ROOT
-- ----------------------------------------------------------------------------
create table public.clinics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- One row per clinic: exchange rate + the Recepción capability flags.
-- recepcion_caps mirrors the prototype's toggles exactly.
create table public.clinic_settings (
  clinic_id      uuid primary key references public.clinics(id) on delete cascade,
  fx_rate        numeric(10,4) not null default 18.5,
  currency       text not null default 'MXN',
  recepcion_caps jsonb not null default jsonb_build_object(
    'dailyTotals',   true,
    'monthlyTotals', false,
    'analytics',     false,
    'editCategories',true,
    'editFx',        true,
    'exportData',    false,
    'deleteEntries', true
  ),
  updated_at     timestamptz not null default now()
);

-- Maps a Supabase auth user to a clinic + role. This replaces the
-- shared-login + PIN workaround: each staff member has their own account,
-- and `role` ('manager' | 'recepcion') drives what they can do.
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  clinic_id    uuid references public.clinics(id) on delete cascade,
  role         text not null default 'recepcion' check (role in ('manager','recepcion')),
  display_name text,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- DOMAIN
-- ----------------------------------------------------------------------------
-- Editable per-clinic category lists (conceptos, modificadores, etc.)
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  kind       text not null check (kind in ('concepto','modificador','estatus','metodo','tipo_tarjeta')),
  label      text not null,
  sort_order int not null default 0,
  active      boolean not null default true,
  unique (clinic_id, kind, label)
);

create table public.patients (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  name       text not null,
  name_key   text not null,            -- normalized (lower/trim) for dedup + auto-upsert
  phone      text,
  email      text,
  notes      text,
  created_at timestamptz not null default now(),
  unique (clinic_id, name_key)
);

-- A visit. One payment method/status per visit; services live in entry_items.
create table public.entries (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  patient_id  uuid not null references public.patients(id) on delete restrict,
  entry_date  date not null default current_date,
  status      text not null,           -- Completo / Descuento / Cortesía (free-form per clinic)
  method      text not null,           -- Pesos (MXN) / Dolares (USD) / Tarjeta / ...
  card_type   text,                    -- DEBITO / CREDITO (when method is card)
  invoice_no  text,
  notes       text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index on public.entries (clinic_id, entry_date);
create index on public.entries (patient_id);

-- Multi-service: each visit can have several billed lines.
create table public.entry_items (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.entries(id) on delete cascade,
  clinic_id   uuid not null references public.clinics(id) on delete cascade,  -- denormalized for RLS
  concepto    text not null,
  modificador text,
  amount      numeric(12,2) not null default 0
);
create index on public.entry_items (entry_id);

-- File attachments: blob lives in Storage bucket 'entry-files'; this is metadata.
create table public.entry_files (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references public.entries(id) on delete cascade,
  clinic_id    uuid not null references public.clinics(id) on delete cascade,  -- denormalized for RLS
  storage_path text not null,          -- '{clinic_id}/{entry_id}/{file_id}'
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index on public.entry_files (entry_id);

-- ----------------------------------------------------------------------------
-- AUTH HELPERS (security definer so they read profiles past RLS)
-- ----------------------------------------------------------------------------
create or replace function public.current_clinic_id()
returns uuid language sql stable security definer set search_path = public as $$
  select clinic_id from public.profiles where id = auth.uid();
$$;

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Manager => always true. Recepción => the clinic's toggle for that capability.
create or replace function public.has_cap(cap text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p.role = 'manager' then true
    else coalesce((s.recepcion_caps ->> cap)::boolean, false)
  end
  from public.profiles p
  join public.clinic_settings s on s.clinic_id = p.clinic_id
  where p.id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- ROW-LEVEL SECURITY
-- Every table: a member can only touch rows of their own clinic (tenant isolation).
-- Sensitive operations layer a capability check on top.
-- ----------------------------------------------------------------------------
alter table public.clinics         enable row level security;
alter table public.clinic_settings enable row level security;
alter table public.profiles        enable row level security;
alter table public.categories      enable row level security;
alter table public.patients        enable row level security;
alter table public.entries         enable row level security;
alter table public.entry_items     enable row level security;
alter table public.entry_files     enable row level security;

-- clinics: read your own clinic.
create policy clinic_read on public.clinics
  for select using (id = public.current_clinic_id());

-- profiles: read profiles in your clinic; update only your own display_name (role changes via RPC).
create policy profile_read on public.profiles
  for select using (clinic_id = public.current_clinic_id());
create policy profile_self_update on public.profiles
  for update using (id = auth.uid());

-- clinic_settings: read your clinic's settings. Writes go through RPCs only (no direct UPDATE policy).
create policy settings_read on public.clinic_settings
  for select using (clinic_id = public.current_clinic_id());

-- categories: read all in clinic; write requires editCategories capability.
create policy cat_read on public.categories
  for select using (clinic_id = public.current_clinic_id());
create policy cat_write on public.categories
  for all
  using  (clinic_id = public.current_clinic_id() and public.has_cap('editCategories'))
  with check (clinic_id = public.current_clinic_id() and public.has_cap('editCategories'));

-- patients: full CRUD within clinic for any member (front desk creates/edits patients).
create policy pat_all on public.patients
  for all
  using  (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

-- entries: read/insert/update within clinic; DELETE requires deleteEntries capability.
create policy ent_select on public.entries
  for select using (clinic_id = public.current_clinic_id());
create policy ent_insert on public.entries
  for insert with check (clinic_id = public.current_clinic_id());
create policy ent_update on public.entries
  for update using (clinic_id = public.current_clinic_id())
            with check (clinic_id = public.current_clinic_id());
create policy ent_delete on public.entries
  for delete using (clinic_id = public.current_clinic_id() and public.has_cap('deleteEntries'));

-- entry_items / entry_files: mirror the parent clinic; delete gated by deleteEntries.
create policy item_rw on public.entry_items
  for all
  using  (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy file_select on public.entry_files
  for select using (clinic_id = public.current_clinic_id());
create policy file_insert on public.entry_files
  for insert with check (clinic_id = public.current_clinic_id());
create policy file_delete on public.entry_files
  for delete using (clinic_id = public.current_clinic_id() and public.has_cap('deleteEntries'));

-- ----------------------------------------------------------------------------
-- SETTINGS WRITES (RPC, so capability is enforced per field)
-- ----------------------------------------------------------------------------
create or replace function public.set_fx_rate(p_rate numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_cap('editFx') then raise exception 'no_permission: editFx'; end if;
  update public.clinic_settings
     set fx_rate = p_rate, updated_at = now()
   where clinic_id = public.current_clinic_id();
end; $$;

-- Only managers can rewrite the capability flags (Recepción can't grant itself access).
create or replace function public.set_recepcion_caps(p_caps jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() <> 'manager' then raise exception 'no_permission: manager only'; end if;
  update public.clinic_settings
     set recepcion_caps = p_caps, updated_at = now()
   where clinic_id = public.current_clinic_id();
end; $$;

-- ----------------------------------------------------------------------------
-- AGGREGATES (RPC + capability check = real enforcement of totals/analytics)
-- These are the only path to roll-up numbers; if the cap is off, they refuse.
-- ----------------------------------------------------------------------------
-- Amount of one entry in MXN (USD methods converted at the clinic rate).
create or replace function public.entry_mxn(p_entry uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(ei.amount * case when e.method ilike '%USD%' then s.fx_rate else 1 end), 0)
  from public.entries e
  join public.entry_items ei on ei.entry_id = e.id
  join public.clinic_settings s on s.clinic_id = e.clinic_id
  where e.id = p_entry;
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
           coalesce(sum(ei.amount * case when e.method ilike '%USD%' then s.fx_rate else 1 end),0)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and date_trunc('month', e.entry_date) = date_trunc('month', p_month)
    group by e.entry_date
    order by e.entry_date;
end; $$;

create or replace function public.get_monthly_total(p_month date)
returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_cap('monthlyTotals') then raise exception 'no_permission: monthlyTotals'; end if;
  return coalesce((
    select sum(ei.amount * case when e.method ilike '%USD%' then s.fx_rate else 1 end)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and date_trunc('month', e.entry_date) = date_trunc('month', p_month)
  ), 0);
end; $$;

-- Revenue grouped by concepto (for the analytics bar chart). Gated by 'analytics'.
create or replace function public.get_revenue_by_concepto(p_from date, p_to date)
returns table (concepto text, total_mxn numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_cap('analytics') then raise exception 'no_permission: analytics'; end if;
  return query
    select ei.concepto,
           coalesce(sum(ei.amount * case when e.method ilike '%USD%' then s.fx_rate else 1 end),0)
    from public.entries e
    join public.entry_items ei on ei.entry_id = e.id
    join public.clinic_settings s on s.clinic_id = e.clinic_id
    where e.clinic_id = public.current_clinic_id()
      and e.entry_date between p_from and p_to
    group by ei.concepto
    order by 2 desc;
end; $$;

-- ----------------------------------------------------------------------------
-- ONBOARDING
-- On first sign-up the user has no clinic. They call this once to create their
-- clinic, seed default settings, and become its manager.
-- ----------------------------------------------------------------------------
create or replace function public.bootstrap_clinic(p_clinic_name text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_clinic uuid;
begin
  if (select clinic_id from public.profiles where id = auth.uid()) is not null then
    raise exception 'already_in_clinic';
  end if;
  insert into public.clinics (name) values (p_clinic_name) returning id into new_clinic;
  insert into public.clinic_settings (clinic_id) values (new_clinic);
  insert into public.profiles (id, clinic_id, role, display_name)
    values (auth.uid(), new_clinic, 'manager', coalesce(p_display_name, 'Gerente'))
  on conflict (id) do update set clinic_id = excluded.clinic_id, role = 'manager';
  return new_clinic;
end; $$;

-- Create an empty profile row automatically when a new auth user signs up
-- (clinic_id stays null until bootstrap_clinic or an invite assigns one).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role) values (new.id, 'recepcion')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- STORAGE (run after creating a PRIVATE bucket named 'entry-files' in Studio)
-- Path convention: '{clinic_id}/{entry_id}/{file_id}'. First folder = clinic_id,
-- so members can only read/write files under their own clinic's folder.
-- ----------------------------------------------------------------------------
-- insert into storage.buckets (id, name, public) values ('entry-files','entry-files',false)
--   on conflict do nothing;

create policy "entry_files_read" on storage.objects for select
  using (bucket_id = 'entry-files'
         and (storage.foldername(name))[1] = public.current_clinic_id()::text);

create policy "entry_files_write" on storage.objects for insert
  with check (bucket_id = 'entry-files'
              and (storage.foldername(name))[1] = public.current_clinic_id()::text);

create policy "entry_files_delete" on storage.objects for delete
  using (bucket_id = 'entry-files'
         and (storage.foldername(name))[1] = public.current_clinic_id()::text
         and public.has_cap('deleteEntries'));
