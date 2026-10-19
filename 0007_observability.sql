-- ============================================================================
-- Praxia · Registro — observabilidad: errores del cliente
-- Run AFTER 0006. Run in: Supabase Studio → SQL Editor → New query → paste → Run.
--
-- The app reports uncaught JavaScript errors here (message, stack, page, version,
-- browser) so the platform admins can see what users hit without asking them.
-- Signed-in users only, at most 20 reports per user per hour; rows older than
-- 90 days are pruned. Readable only by platform admins (Administración → Errores).
-- ============================================================================
create table if not exists public.client_errors (
  id          bigint generated always as identity primary key,
  user_id     uuid,
  clinic_id   uuid,
  app_version text,
  url         text,
  message     text not null,
  stack       text,
  user_agent  text,
  at          timestamptz not null default now()
);
create index if not exists client_errors_at on public.client_errors (at desc);
create index if not exists client_errors_user_at on public.client_errors (user_id, at desc);
alter table public.client_errors enable row level security;
drop policy if exists client_errors_read on public.client_errors;
create policy client_errors_read on public.client_errors
  for select using (public.is_platform_admin());

create or replace function public.log_client_error(p_message text, p_stack text default null, p_url text default null,
                                                   p_version text default null, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from public.client_errors where user_id = auth.uid() and at > now() - interval '1 hour') >= 20 then return; end if;
  insert into public.client_errors (user_id, clinic_id, app_version, url, message, stack, user_agent)
  values (auth.uid(), public.current_clinic_id(), left(p_version, 40), left(p_url, 300),
          left(coalesce(nullif(trim(p_message), ''), '(sin mensaje)'), 500), left(p_stack, 4000), left(p_user_agent, 300));
  delete from public.client_errors where at < now() - interval '90 days';
end; $$;

create or replace function public.admin_list_client_errors(p_limit int default 100)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.is_platform_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id, 'at', e.at, 'message', e.message, 'stack', e.stack, 'url', e.url, 'app_version', e.app_version,
      'user_agent', e.user_agent, 'email', u.email, 'clinic_name', c.name) order by e.at desc)
    from (select * from public.client_errors order by at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) e
    left join auth.users u on u.id = e.user_id
    left join public.clinics c on c.id = e.clinic_id), '[]'::jsonb) end;
$$;

revoke execute on function public.log_client_error(text, text, text, text, text), public.admin_list_client_errors(int) from public, anon;
grant execute on function public.log_client_error(text, text, text, text, text), public.admin_list_client_errors(int) to authenticated;
