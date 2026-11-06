import { corsHeaders } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { syncChannelPool, isSocial, SOCIAL_SYNC_TTL_MS } from '../_shared/channel-pool.ts';

const CORS = corsHeaders({ methods: 'GET, POST, PUT, DELETE, OPTIONS' });

// Refreshes the competitor video POOL. Nothing here reads a transcript, calls a
// model or spends a credit - it is public YouTube data and arithmetic.
//
// This function used to do the whole job: find outliers AND have the model
// write an angle for each one, billing a credit per video, before the user had
// seen anything. That is what capped the feed at eight videos per channel
// inside a two-week window, and why triaging the inbox emptied it. Now it fills
// a pool the feed can draw from indefinitely, and enrich-competitor-video runs
// the model on the one video the user actually picked.
//
// The name is unchanged on purpose: the client calls it by this path, and the
// browser and the functions deploy separately, so renaming would break the feed
// for the length of whichever deploy landed second.

async function getUserIdFromToken(supabase: any, token: string): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) throw new Error('invalid token');
  return user.id;
}

// A channel synced this recently is left alone, no matter who asked. Two
// creators tracking the same competitor cost one API call between them, which
// is what keeps the daily quota from scaling with the subscriber count.
const CHANNEL_SYNC_TTL_MS = 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ytApiKey = Deno.env.get('YOUTUBE_API_KEY');
    if (!ytApiKey) throw new Error('YouTube API key not configured');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    let userId: string;
    try {
      userId = await getUserIdFromToken(supabase, authHeader.replace('Bearer ', ''));
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: CORS });
    }

    // No plan gate: building the pool is YouTube reads and arithmetic, it costs
    // no credits, and a feature nobody can look at before paying does not sell
    // itself. What separates the plans here is how many channels you may track
    // (add-competitor-channel) and the credits the paid steps spend.

    let onlyChannelId: string | null = null;
    try {
      const body = await req.json();
      if (body && typeof body.channelId === 'string') onlyChannelId = body.channelId;
    } catch { /* no body / not JSON - a normal refresh */ }

    // The 12h rate limit and the idle throttle that used to guard this endpoint
    // are gone with the thing they were guarding. They existed because every
    // refresh spent credits on model calls; a refresh is now three YouTube
    // reads per stale channel, and the hour-long per-channel TTL below is what
    // keeps that honest.
    let channelsQuery = supabase.from('competitor_channels').select('*').eq('user_id', userId);
    if (onlyChannelId) channelsQuery = channelsQuery.eq('channel_id', onlyChannelId);
    const { data: channels, error: channelsError } = await channelsQuery;
    if (channelsError) throw channelsError;

    if (!channels || channels.length === 0) {
      return new Response(JSON.stringify({ success: true, videos: [], refreshed: 0 }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const channelIds = channels.map((c: any) => c.channel_id);
    const { data: syncRows } = await supabase
      .from('competitor_channel_pool').select('channel_id, synced_at').in('channel_id', channelIds);
    const syncedAt = new Map((syncRows ?? []).map((r: any) => [r.channel_id, new Date(r.synced_at).getTime()]));

    let refreshed = 0;
    const failures: string[] = [];

    for (const channel of channels) {
      const last = syncedAt.get(channel.channel_id);
      const ttl = isSocial(channel.channel_id) ? SOCIAL_SYNC_TTL_MS : CHANNEL_SYNC_TTL_MS;
      if (last && Date.now() - last < ttl) continue;

      try {
        await syncChannelPool(supabase, channel.channel_id, channel.channel_title, ytApiKey);
      } catch (e) {
        console.error(`[pool] ${channel.channel_id} failed:`, e);
        failures.push(channel.channel_title || channel.channel_id);
        continue;
      }

      refreshed++;
    }

    // The whole pool for the tracked channels, not just what this run touched -
    // the caller renders the feed off this, and most refreshes legitimately
    // touch nothing because another user already synced the same channel.
    const { data: videos, error: videosError } = await supabase
      .from('competitor_videos')
      .select('*')
      .in('channel_id', channelIds)
      .order('outlier_score', { ascending: false, nullsFirst: false });
    if (videosError) throw videosError;

    return new Response(
      JSON.stringify({
        success: true,
        videos: videos || [],
        refreshed,
        message: failures.length
          ? `Could not reach ${failures.join(', ')}. The rest is up to date.`
          : refreshed === 0
            ? 'Already up to date. Competitor channels refresh at most once an hour.'
            : undefined,
      }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[fetch-competitor-ideas] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
