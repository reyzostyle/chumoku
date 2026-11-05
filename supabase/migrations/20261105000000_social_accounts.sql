-- TikTok and Instagram. Competitor channels and their videos need no new
-- columns: the shared pool is keyed by text ids, and these carry their platform
-- ("tiktok:handle", "instagram:DAbc"). The creator's own profiles get tables of
-- their own so nothing written for YouTube Analytics ever meets a row it cannot read.

CREATE TABLE IF NOT EXISTS public.social_accounts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('tiktok', 'instagram')),
  handle text NOT NULL,
  name text,
  avatar text,
  followers bigint,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform)
);

CREATE TABLE IF NOT EXISTS public.social_videos (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video_id text NOT NULL,
  platform text NOT NULL,
  title text,
  views bigint DEFAULT 0,
  duration integer,
  published_at timestamptz,
  url text,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own social accounts" ON public.social_accounts;
CREATE POLICY "Users read own social accounts" ON public.social_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users read own social videos" ON public.social_videos;
CREATE POLICY "Users read own social videos" ON public.social_videos
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Written by sync-social with the service role only, so no GRANT UPDATE for clients.
ALTER TABLE public.user_tokens ADD COLUMN IF NOT EXISTS social_summary text;

-- Covers of TikToks and Reels: their CDN links expire within days.
INSERT INTO storage.buckets (id, name, public)
VALUES ('social-thumbs', 'social-thumbs', true)
ON CONFLICT (id) DO NOTHING;

-- Daily, off the same secret the other jobs use. Skipped if sync-retention's job is absent.
SELECT cron.schedule('sync-social', '41 * * * *',
  (SELECT replace(command, 'sync-retention', 'sync-social') FROM cron.job WHERE command LIKE '%sync-retention%' LIMIT 1))
WHERE EXISTS (SELECT 1 FROM cron.job WHERE command LIKE '%sync-retention%');
