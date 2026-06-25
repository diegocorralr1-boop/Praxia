-- ============================================================================
-- Praxia · Registro — split payments
-- Each charge line (entry_item) can have its own payment method, so a single
-- visit can be paid partly in MXN and partly in USD without a second entry.
-- Run in: Supabase Studio → SQL Editor → New query → paste → Run.
-- ============================================================================

alter table public.entry_items add column if not exists method    text;
alter table public.entry_items add column if not exists card_type text;

-- Backfill existing lines with their entry's payment method.
update public.entry_items ei
   set method = e.method, card_type = e.card_type
  from public.entries e
 where ei.entry_id = e.id and ei.method is null;
