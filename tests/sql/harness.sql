-- Tiny assertion helpers for the SQL tests. Loaded once by scripts/test-sql.sh after the migrations.
create schema if not exists tests;

-- Fails the test file (and the CI job) when cond is not true.
create or replace function tests.ok(cond boolean, msg text)
returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

-- Runs stmt and expects an error whose message contains `expect`.
create or replace function tests.raises(stmt text, expect text, msg text)
returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'ASSERT FAILED: % (no error raised, expected "%")', msg, expect;
exception when others then
  if sqlerrm like 'ASSERT FAILED:%' then raise; end if;
  if position(expect in sqlerrm) = 0 then
    raise exception 'ASSERT FAILED: % (got "%", expected "%")', msg, sqlerrm, expect;
  end if;
end $$;

grant usage on schema tests to anon, authenticated;
grant execute on all functions in schema tests to anon, authenticated;
