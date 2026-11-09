-- How long each daily drop takes and what it costs. Written by daily-ideas with
-- the service role; nobody reads it from the client, so RLS with no policies.
create table if not exists public.idea_drop_stats (
  user_id uuid not null references auth.users(id) on delete cascade,
  drop_date date not null,
  total_ms integer not null,
  search_ms integer not null default 0,
  sync_ms integer not null default 0,
  pitch_ms integer not null default 0,
  own_ms integer not null default 0,
  channels integer not null default 0,
  social_channels integer not null default 0,
  paid_requests integer not null default 0,
  outliers integer not null default 0,
  own_ideas integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, drop_date)
);
alter table public.idea_drop_stats enable row level security;
