// deno-lint-ignore-file no-explicit-any
import { corsHeaders } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { fetchProfile, fetchRecentVideos, parseProfile, type Platform } from '../_shared/social.ts';
import { median } from '../_shared/channel-baseline.ts';
import { buildBrain } from '../_shared/brain.ts';

// The creator's own TikTok and Instagram, connected by handle. Public numbers
// only, so no login and no platform review: views per video are all the ideas
// need to tell what worked for them from what did not.
//
// - signed in: {action:'add', input, platform} / {action:'remove', platform}
// - pg_cron, hourly, x-cron-secret: accounts not read for a day, newest page only
//   (one paid request each). The first read takes three pages for a baseline.

const CORS = corsHeaders({ methods: 'POST, OPTIONS' });
const STALE_MS = 20 * 60 * 60 * 1000;
const CRON_BUDGET_MS = 110_000;
const BASELINE_MIN_AGE_DAYS = 3;
const NAMES: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function readVideos(supabase: any, userId: string, platform: Platform, handle: string, pages: number) {
  const videos = await fetchRecentVideos(platform, handle, pages);
  if (videos.length) {
    await supabase.from('social_videos').upsert(videos.map(v => ({
      user_id: userId, video_id: v.videoId, platform, title: v.title, views: v.views,
      duration: v.duration, published_at: v.publishedAt, url: v.url,
      refreshed_at: new Date().toISOString(),
    })), { onConflict: 'user_id,video_id' });
  }
  await supabase.from('social_accounts').update({ synced_at: new Date().toISOString() })
    .eq('user_id', userId).eq('platform', platform);
}

// What every prompt gets: each platform's usual, and what beat it or fell under.
// A fresh video is left out of the comparison, it has not finished performing.
async function summarize(supabase: any, userId: string) {
  const { data: accounts } = await supabase.from('social_accounts').select('platform, handle').eq('user_id', userId);
  const parts: string[] = [];
  for (const a of accounts ?? []) {
    const { data: rows } = await supabase.from('social_videos')
      .select('title, views, published_at').eq('user_id', userId).eq('platform', a.platform)
      .order('published_at', { ascending: false }).limit(60);
    const old = (rows ?? []).filter((r: any) =>
      Date.now() - new Date(r.published_at).getTime() >= BASELINE_MIN_AGE_DAYS * 86_400_000);
    if (old.length < 3) continue;
    const usual = median(old.map((r: any) => Number(r.views ?? 0)));
    if (!usual) continue;
    const ranked = [...old].sort((x: any, y: any) => y.views - x.views);
    const line = (r: any) => `- "${(r.title || 'untitled').replace(/#\S+/g, '').trim().slice(0, 90)}": ${Number(r.views).toLocaleString()} views, ${(r.views / usual).toFixed(1)}x their usual`;
    // A video at 1.0x taught nothing, so only clear gaps make either list.
    const beat = ranked.filter((r: any) => r.views / usual >= 1.3).slice(0, 4);
    const fell = ranked.filter((r: any) => r.views / usual <= 0.7).slice(-3);
    parts.push([
      `${NAMES[a.platform]} @${a.handle}, usually ${Math.round(usual).toLocaleString()} views over ${old.length} videos.`,
      beat.length ? `Beat it:\n${beat.map(line).join('\n')}` : 'Nothing clearly beat it yet.',
      fell.length ? `Fell under it:\n${fell.map(line).join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  }
  await supabase.from('user_tokens').update({ social_summary: parts.join('\n\n') || null }).eq('user_id', userId);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  const started = Date.now();
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    );
    const body = await req.json().catch(() => ({}));

    const provided = req.headers.get('x-cron-secret');
    if (provided) {
      const secret = Deno.env.get('CRON_SECRET');
      if (!secret || provided !== secret) return json({ error: 'Unauthorized' }, 401);
      const cutoff = new Date(Date.now() - STALE_MS).toISOString();
      const { data: due } = await supabase.from('social_accounts')
        .select('user_id, platform, handle').or(`synced_at.is.null,synced_at.lt.${cutoff}`)
        .order('synced_at', { ascending: true, nullsFirst: true }).limit(200);
      let done = 0;
      for (const a of due ?? []) {
        if (Date.now() - started > CRON_BUDGET_MS) break;
        try {
          await readVideos(supabase, a.user_id, a.platform, a.handle, 1);
          await summarize(supabase, a.user_id);
          done++;
        } catch (e) {
          console.error('[sync-social]', a.platform, a.handle, e);
        }
      }
      return json({ success: true, done, due: due?.length ?? 0 });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    if (body.action === 'remove') {
      if (body.platform !== 'tiktok' && body.platform !== 'instagram') return json({ error: 'Unknown platform' }, 400);
      await supabase.from('social_accounts').delete().eq('user_id', user.id).eq('platform', body.platform);
      await supabase.from('social_videos').delete().eq('user_id', user.id).eq('platform', body.platform);
      await summarize(supabase, user.id);
      return json({ success: true });
    }

    if (body.action === 'add') {
      const input = String(body.input ?? '').trim();
      const parsed = parseProfile(input);
      const platform: Platform | null = parsed?.platform ?? (body.platform === 'tiktok' || body.platform === 'instagram' ? body.platform : null);
      const handle = parsed?.handle ?? input.replace(/^@/, '').replace(/\/+$/, '');
      if (!platform || !/^[\w.]{1,40}$/.test(handle)) return json({ error: 'Paste a link or @name.' }, 400);

      let profile;
      try {
        profile = await fetchProfile(platform, handle);
      } catch {
        return json({ error: `Couldn't find @${handle} on ${NAMES[platform]}.` }, 404);
      }
      // A different account on this platform replaces the old one, numbers included.
      await supabase.from('social_videos').delete().eq('user_id', user.id).eq('platform', platform);
      await supabase.from('social_accounts').upsert({
        user_id: user.id, platform, handle: profile.handle, name: profile.name,
        avatar: profile.avatar, followers: profile.followers,
      }, { onConflict: 'user_id,platform' });
      await readVideos(supabase, user.id, platform, profile.handle, 3);
      await summarize(supabase, user.id);
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil(buildBrain(supabase, user.id).catch(e => console.error('[sync-social] brain', e)));
      return json({ success: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (error) {
    console.error('[sync-social]', error);
    return json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500);
  }
});
