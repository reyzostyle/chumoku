import { corsHeaders } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { pitchVideos } from '../_shared/pitch.ts';

const CORS = corsHeaders({ methods: 'POST, OPTIONS' });

// "Is this an idea for ME?" before anyone pays to find out.
//
// The Ideas feed showed a competitor's title and nothing else, so every card
// was someone else's video and the only way to learn whether it suited your
// channel was to spend a credit reading it. Ivan's complaint, 2026-09-29: half
// the time the answer was no, because a tracked channel can sit in a different
// niche entirely.
//
// This reads the titles only - no video, no transcript - in one call for up to
// thirty at a time, and writes back one line per video: what this creator's
// version would be, and whether it fits their channel. It is free to the user.
// It is a guess from a title, and the card says so by being one line; the paid
// read that watches the video is still what writes the real angle.

const MAX_BATCH = 30;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { data: planRow } = await supabase.from('user_tokens').select('plan').eq('user_id', user.id).maybeSingle();
    if (!planRow?.plan || planRow.plan === 'free') return json({ error: 'subscription_required' }, 402);

    const { videoIds } = await req.json().catch(() => ({}));
    if (!Array.isArray(videoIds) || videoIds.length === 0) return json({ error: 'videoIds required' }, 400);
    const ids = [...new Set(videoIds.filter((v: unknown) => typeof v === 'string'))].slice(0, MAX_BATCH) as string[];

    // Only videos from channels this user tracks: this is free to them, so it
    // must not be a way to run the model over any string they send.
    const { data: tracked } = await supabase
      .from('competitor_channels').select('channel_id').eq('user_id', user.id);
    const trackedIds = (tracked ?? []).map(c => c.channel_id);
    if (trackedIds.length === 0) return json({ ideas: [] });

    const { data: pooled } = await supabase
      .from('competitor_videos').select('video_id, channel_id, channel_name, title, views, published_at, outlier_score')
      .in('video_id', ids).in('channel_id', trackedIds);
    if (!pooled?.length) return json({ ideas: [] });

    // Already pitched for this user: nothing to do for those.
    const { data: existing } = await supabase
      .from('competitor_ideas').select('video_id, pitch')
      .eq('user_id', user.id).in('video_id', pooled.map(p => p.video_id));
    const done = new Set((existing ?? []).filter(e => e.pitch).map(e => e.video_id));
    const todo = pooled.filter(p => !done.has(p.video_id));
    if (todo.length === 0) return json({ ideas: [] });

    const saved = await pitchVideos(supabase, user.id, todo);
    return json({ ideas: saved ?? [] });
  } catch (error) {
    console.error('[pitch-ideas]', error);
    return json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500);
  }
});
