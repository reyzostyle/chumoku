-- What the creator wants from their videos, picked in onboarding or Settings.
alter table public.user_tokens add column if not exists channel_goal text;
grant update (channel_goal) on public.user_tokens to authenticated;
