-- Emails asking to hear when Chumoku in Claude ships. The landing page writes
-- as a guest; nobody can read it from the client.
create table if not exists public.mcp_waitlist (
  email text primary key check (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now()
);
alter table public.mcp_waitlist enable row level security;
drop policy if exists "anyone can join" on public.mcp_waitlist;
create policy "anyone can join" on public.mcp_waitlist for insert to anon, authenticated with check (true);
grant insert on public.mcp_waitlist to anon, authenticated;
