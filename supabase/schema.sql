-- HOMEBASE database — run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again; nothing is dropped.

-- 1) The data. Same three keys the app has always used:
--    properties, appreciation, compPool  (each value is the same JSON as before).
create table if not exists public.kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- 2) Version history, so a bad overwrite is recoverable (Backup page -> Version history).
create table if not exists public.kv_history (
  id       bigint generated always as identity primary key,
  key      text not null,
  value    text not null,
  saved_at timestamptz not null default now()
);
create index if not exists kv_history_key_saved_idx on public.kv_history (key, saved_at desc);

-- 3) On every change: stamp updated_at, and keep the PREVIOUS value as a restore
--    point — at most one per hour per key, but ALWAYS when the new value is less
--    than half the size of the old one (the signature of an accidental wipe).
--    The newest 40 restore points per key are kept.
create or replace function public.kv_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if old.value is distinct from new.value then
    if length(new.value) < length(old.value) * 0.5
       or not exists (select 1 from public.kv_history h where h.key = old.key and h.saved_at > now() - interval '1 hour') then
      insert into public.kv_history (key, value) values (old.key, old.value);
      delete from public.kv_history
       where key = old.key
         and id not in (select id from public.kv_history where key = old.key order by saved_at desc limit 40);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists kv_before_update_trg on public.kv;
create trigger kv_before_update_trg before update on public.kv
  for each row execute function public.kv_before_update();

-- 4) Open access, as requested: anyone with the link can read and edit (no login).
alter table public.kv         enable row level security;
alter table public.kv_history enable row level security;

drop policy if exists "kv open access" on public.kv;
create policy "kv open access" on public.kv
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "kv_history read" on public.kv_history;
create policy "kv_history read" on public.kv_history
  for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.kv to anon, authenticated;
grant select on public.kv_history to anon, authenticated;
