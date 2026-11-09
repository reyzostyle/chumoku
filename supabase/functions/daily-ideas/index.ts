// deno-lint-ignore-file no-explicit-any
import { corsHeaders } from '../_shared/http.ts';
import { loadCreditStatus, canAfford, spendCredits, CREDIT_COSTS } from '../_shared/credits.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { syncChannelPool, isEnglish, isSocial, OUTLIER_THRESHOLD, SOCIAL_SYNC_TTL_MS } from '../_shared/channel-pool.ts';
import { channelIdOf, searchChannels, socialUsage } from '../_shared/social.ts';
import { pitchVideos, type PitchSource } from '../_shared/pitch.ts';
import { buildQueries } from '../_shared/niche-query.ts';
import { loadChannelScan } from '../_shared/channel-scan.ts';
import { buildVoice, VOICE_TTL_MS } from '../_shared/voice.ts';
import { buildBrain, loadBrain } from '../_shared/brain.ts';
import { suggestFromChannel, canSuggest } from '../_shared/own-ideas.ts';

const CORS = corsHeaders({ methods: 'POST, OPTIONS' });

// The daily drop: ten fresh ideas, picked and pitched for one
// creator, that turns over at 9:00 their time.
//
// Until now nothing in Ideas happened unless someone opened the tab and
// pressed Refresh, so the positioning line "a ready idea is waiting for you"
// was not true. This makes it true, and gives a reason to come back daily.
//
// Where the ideas come from matters more than the schedule. Measured
// 2026-10-06: 12 tracked channels across all users, most people tracking one,
// and ONE new outlier across all of them in the past week. A drop built from
// tracked channels alone would be empty by Wednesday. So it finds its own:
// three search phrases for the creator's niche, each from a different angle,
// up to twenty channels winning on them, pooled and drawn from alongside the
// tracked ones. Nobody has to go and find competitors first. Those channels
// are not added to the tracked list; they only feed the drop.
//
// Two callers:
// - the app, with the user's JWT, when Ideas opens: builds today's drop if it
//   is missing and returns it. This alone is enough for the feature to work.
// - pg_cron, hourly, with x-cron-secret: prebuilds for everyone seen in the
//   last two weeks whose 9:00 has passed, so the stack is there on arrival
//   (and so a badge or an email can say so).

const DROP_SIZE = 10;
// At least this many of the ten are ideas from the creator's own channel
// (own-ideas.ts), when there are uploads to learn from. They also fill any
// seats the outliers leave empty, so a thin niche no longer means a thin drop.
const OWN_MIN = 3;
// "Find more" for credits is researched ideas only: the outliers are what the
// morning already found, and asking again an hour later turns up the same.
const MORE_OWN = 5;
// A Short has to have actually been seen to count as proof. 3.9x on a channel
// whose usual is 100 views is 382 views, which proves nothing (Ivan,
// 2026-10-27).
const MIN_VIEWS = 10_000;
// Older than this and the format or the news in it has moved on (Ivan,
// 2026-11-09). Two thirds of the outlier pool is inside 60 days; the research
// ideas fill whatever seats this leaves empty.
const MAX_AGE_DAYS = 60;
const DROP_HOUR = 9;
const PITCH_POOL = 30;                       // candidates pitched to pick DROP_SIZE from
const PER_CHANNEL = 2;
const TRACKED_TTL_MS = 6 * 60 * 60 * 1000;   // tracked channels refresh before a drop
const NICHE_TTL_MS = 24 * 60 * 60 * 1000;    // niche channels refresh at most daily
const SEARCH_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const QUERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_WINDOW_DAYS = 30;
const MAX_NICHE_CHANNELS = 10;       // per phrase
const MAX_NICHE_TOTAL = 20;          // across phrases
const SOCIAL_NICHE_CHANNELS = 3;      // per platform, per phrase: each one is three paid requests
const SOCIAL_SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SYNC_BATCH = 5;                // channels refreshed in parallel
const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CRON_BUDGET_MS = 110_000;

interface DropStats { search_ms: number; sync_ms: number; pitch_ms: number; own_ms: number; channels: number; social_channels: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function validTz(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

function localParts(tz: string, at: Date): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

// The drop a moment belongs to is the local date DROP_HOUR hours earlier:
// before 9:00 you are still looking at yesterday's.
function dropDateFor(tz: string, now = new Date()): string {
  return localParts(tz, new Date(now.getTime() - DROP_HOUR * 3_600_000)).date;
}

function nextDropAt(tz: string, now = new Date()): string {
  const { hour, minute } = localParts(tz, now);
  let mins = ((DROP_HOUR - hour + 24) % 24) * 60 - minute;
  if (mins <= 0) mins += 24 * 60;
  return new Date(now.getTime() + mins * 60_000).toISOString();
}

async function ensureTokensRow(supabase: any, userId: string) {
  const { data } = await supabase.from('user_tokens').select('user_id').eq('user_id', userId).maybeSingle();
  if (!data) await supabase.from('user_tokens').insert({ user_id: userId, access_token: '', refresh_token: '' });
}

// Search phrases for this creator's niche, rewritten at most weekly. Stored
// one per line in user_tokens.idea_query.
async function nicheQueries(supabase: any, userId: string, profile: any): Promise<string[]> {
  if (profile?.idea_query && profile?.idea_query_at
    && Date.now() - new Date(profile.idea_query_at).getTime() < QUERY_TTL_MS) {
    return String(profile.idea_query).split('\n').filter(Boolean);
  }
  const scan = await loadChannelScan(supabase, userId);
  const brain = await loadBrain(supabase, userId);
  const niche = brain?.niche || profile?.channel_niche || '';
  const description = brain
    ? [brain.direction, brain.summary, brain.format].filter(Boolean).join(' ')
    : (profile?.channel_description || '');
  if (!scan?.videos?.length && !niche && !description) return [];

  const queries = await buildQueries(scan, niche, description);
  if (!queries.length) return [];
  await supabase.from('user_tokens')
    .update({ idea_query: queries.join('\n'), idea_query_at: new Date().toISOString() }).eq('user_id', userId);
  return queries;
}

// Channels winning on this phrase lately, from cache when it is fresh.
async function nicheChannels(supabase: any, query: string, ytApiKey: string): Promise<{ id: string; name: string }[]> {
  const { data: cached } = await supabase
    .from('idea_search_cache').select('searched_at, channels').eq('query', query).maybeSingle();
  if (cached && Date.now() - new Date(cached.searched_at).getTime() < SEARCH_TTL_MS) {
    return cached.channels ?? [];
  }

  const publishedAfter = new Date(Date.now() - SEARCH_WINDOW_DAYS * 86_400_000).toISOString();
  const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search`
    + `?part=snippet&type=video&videoDuration=short&order=viewCount&maxResults=50`
    + `&relevanceLanguage=en&regionCode=US`
    + `&publishedAfter=${publishedAfter}&q=${encodeURIComponent(query)}&key=${ytApiKey}`);
  if (!searchRes.ok) {
    console.error('[daily-ideas] search failed:', await searchRes.text());
    return cached?.channels ?? [];
  }
  const items = (await searchRes.json()).items || [];
  const ids = items.map((it: any) => it.id?.videoId).filter(Boolean).slice(0, 50);

  // Language check on the hits themselves, same rule the pool uses.
  const english = new Set<string>();
  if (ids.length) {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${ids.join(',')}&part=snippet&key=${ytApiKey}`);
    if (res.ok) for (const v of (await res.json()).items || []) if (isEnglish(v)) english.add(v.id);
  }

  // In ranking order (by views), one entry per channel.
  const seen = new Set<string>();
  const channels: { id: string; name: string }[] = [];
  for (const it of items) {
    const id = it.snippet?.channelId;
    if (!id || seen.has(id)) continue;
    if (english.size && !english.has(it.id?.videoId)) continue;
    seen.add(id);
    channels.push({ id, name: it.snippet?.channelTitle || id });
    if (channels.length >= MAX_NICHE_CHANNELS) break;
  }

  await supabase.from('idea_search_cache')
    .upsert({ query, searched_at: new Date().toISOString(), channels }, { onConflict: 'query' });
  return channels;
}

// The same search on TikTok and Instagram, cached a week. The results are paid
// for, and the accounts winning a phrase do not change daily.
async function socialNicheChannels(supabase: any, query: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for (const platform of ['tiktok', 'instagram'] as const) {
    const key = `${platform}|${query}`;
    const { data: cached } = await supabase
      .from('idea_search_cache').select('searched_at, channels').eq('query', key).maybeSingle();
    if (cached && Date.now() - new Date(cached.searched_at).getTime() < SOCIAL_SEARCH_TTL_MS) {
      out.push(...(cached.channels ?? []));
      continue;
    }
    try {
      const channels = await searchChannels(platform, query, SOCIAL_NICHE_CHANNELS);
      await supabase.from('idea_search_cache')
        .upsert({ query: key, searched_at: new Date().toISOString(), channels }, { onConflict: 'query' });
      out.push(...channels);
    } catch (e) {
      console.error('[daily-ideas] social search', platform, query, e);
      out.push(...(cached?.channels ?? []));
    }
  }
  return out;
}

// Builds one creator's drop for `dropDate`. Assumes the claim on
// user_tokens.idea_drop_date is already held. Returns how many ideas landed.
// Other channels' outliers first, then ideas from their own channel in the
// seats left (at least OWN_MIN of them).
async function buildDrop(supabase: any, userId: string, dropDate: string, profile: any, ytApiKey: string): Promise<number> {
  const started = Date.now();
  const paidBefore = socialUsage.requests;
  const stats: DropStats = { search_ms: 0, sync_ms: 0, pitch_ms: 0, own_ms: 0, channels: 0, social_channels: 0 };
  const save = async (outliers: number, own: number) => {
    // Never let the measuring break the drop.
    try {
      await supabase.from('idea_drop_stats').upsert({
        user_id: userId, drop_date: dropDate, total_ms: Date.now() - started, ...stats,
        paid_requests: socialUsage.requests - paidBefore, outliers, own_ideas: own,
      }, { onConflict: 'user_id,drop_date' });
    } catch (e) { console.error('[daily-ideas] stats', e); }
  };
  const [scan, brain] = await Promise.all([loadChannelScan(supabase, userId), loadBrain(supabase, userId)]);
  const own = canSuggest(scan, brain);
  const outliers = await dropOutliers(supabase, userId, dropDate, profile, ytApiKey, own ? DROP_SIZE - OWN_MIN : DROP_SIZE, stats);
  if (!own) { await save(outliers, 0); return outliers; }
  let suggested = 0;
  const ownStart = Date.now();
  try {
    suggested = await suggestFromChannel(supabase, userId, DROP_SIZE - outliers, dropDate);
  } catch (e) {
    console.error('[daily-ideas] own ideas failed:', e);
  }
  stats.own_ms = Date.now() - ownStart;
  await save(outliers, suggested);
  return outliers + suggested;
}

// Picks up to `limit` outliers from tracked and niche channels into the drop.
async function dropOutliers(supabase: any, userId: string, dropDate: string, profile: any, ytApiKey: string, limit: number, stats: DropStats): Promise<number> {
  // 1. Tracked channels, refreshed if stale.
  const { data: tracked } = await supabase
    .from('competitor_channels').select('channel_id, channel_title').eq('user_id', userId);
  const trackedIds = (tracked ?? []).map((c: any) => c.channel_id);

  // 2. Channels the niche search turns up.
  //    Every phrase, merged: the top of each list first, so no single angle
  //    crowds out the others.
  const searchStart = Date.now();
  let niche: { id: string; name: string }[] = [];
  try {
    const queries = await nicheQueries(supabase, userId, profile);
    const lists = await Promise.all(queries.map(q =>
      nicheChannels(supabase, q, ytApiKey).catch(e => { console.error('[daily-ideas] search', q, e); return []; })));
    // Paid requests, so paid plans. A free account still gets the TikTok and
    // Instagram channels it tracks by hand.
    const { data: planRow } = await supabase.from('user_tokens').select('plan').eq('user_id', userId).maybeSingle();
    if (planRow?.plan && planRow.plan !== 'free') {
      lists.push(...await Promise.all(queries.slice(0, 2).map(q => socialNicheChannels(supabase, q))));
    }
    const seen = new Set<string>();
    for (let i = 0; i < MAX_NICHE_CHANNELS; i++) {
      for (const list of lists) {
        const c = list[i];
        if (c && !seen.has(c.id)) { seen.add(c.id); niche.push(c); }
      }
    }
  } catch (e) {
    console.error('[daily-ideas] niche search error:', e);
  }

  // Own channel never counts as a competitor.
  const scan = await loadChannelScan(supabase, userId);
  const ownTitle = (scan?.channelTitle || '').toLowerCase();
  const { data: mine } = await supabase.from('social_accounts').select('platform, handle').eq('user_id', userId);
  const ownSocial = new Set((mine ?? []).map((a: any) => channelIdOf(a.platform, a.handle)));
  niche = niche.filter(c => !trackedIds.includes(c.id) && !ownSocial.has(c.id) && c.name.toLowerCase() !== ownTitle).slice(0, MAX_NICHE_TOTAL);

  const all = [
    ...(tracked ?? []).map((c: any) => ({ id: c.channel_id, name: c.channel_title, ttl: isSocial(c.channel_id) ? SOCIAL_SYNC_TTL_MS : TRACKED_TTL_MS })),
    ...niche.map(c => ({ id: c.id, name: c.name, ttl: isSocial(c.id) ? SOCIAL_SYNC_TTL_MS : NICHE_TTL_MS })),
  ];
  stats.search_ms = Date.now() - searchStart;
  stats.channels = all.length;
  stats.social_channels = all.filter(c => isSocial(c.id)).length;
  if (all.length === 0) return 0;

  const { data: syncRows } = await supabase
    .from('competitor_channel_pool').select('channel_id, synced_at').in('channel_id', all.map(c => c.id));
  const syncedAt = new Map((syncRows ?? []).map((r: any) => [r.channel_id, new Date(r.synced_at).getTime()]));
  const stale = all.filter(c => {
    const last = syncedAt.get(c.id) as number | undefined;
    return !last || Date.now() - last >= c.ttl;
  });
  const syncStart = Date.now();
  for (let i = 0; i < stale.length; i += SYNC_BATCH) {
    await Promise.all(stale.slice(i, i + SYNC_BATCH).map(c =>
      syncChannelPool(supabase, c.id, c.name, ytApiKey)
        .catch(e => console.error(`[daily-ideas] pool ${c.id} failed:`, e))));
  }

  stats.sync_ms = Date.now() - syncStart;

  // 3. Candidates: outliers from all of them, minus anything already ruled on
  //    or already shown in an earlier drop.
  const { data: pooled } = await supabase
    .from('competitor_videos')
    .select('video_id, channel_id, channel_name, title, views, published_at, outlier_score')
    .in('channel_id', all.map(c => c.id))
    .gte('outlier_score', OUTLIER_THRESHOLD)
    .gte('views', MIN_VIEWS)
    .gte('published_at', new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString());
  if (!pooled?.length) return 0;

  const { data: known } = await supabase
    .from('competitor_ideas').select('video_id, liked, drop_date, pitch, fit')
    .eq('user_id', userId).in('video_id', pooled.map((p: any) => p.video_id));
  const knownBy = new Map((known ?? []).map((k: any) => [k.video_id, k]));

  // Fresh beats old at the same multiple: last month's format is still live,
  // last spring's might not be.
  const freshness = (iso: string | null) => {
    if (!iso) return 0.6;
    const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
    return days <= 30 ? 1.6 : days <= 90 ? 1 : 0.6;
  };
  const ranked = (pooled as PitchSource[])
    .filter(p => {
      const k: any = knownBy.get(p.video_id);
      return !k || (k.liked == null && !k.drop_date && k.fit !== 'no');
    })
    .sort((a, b) =>
      Math.log(b.outlier_score ?? 1) * freshness(b.published_at)
      - Math.log(a.outlier_score ?? 1) * freshness(a.published_at))
    // Spread the pitching budget too: no channel takes more than four seats.
    .filter((p, _i, all) => all.filter(q => q.channel_id === p.channel_id).indexOf(p) < PER_CHANNEL * 2)
    .slice(0, PITCH_POOL);
  if (ranked.length === 0) return 0;

  // 4. Pitch what has no pitch yet (one call), then pick: fits first.
  const unpitched = ranked.filter(p => !(knownBy.get(p.video_id) as any)?.pitch);
  const pitchStart = Date.now();
  const fresh = await pitchVideos(supabase, userId, unpitched);
  stats.pitch_ms = Date.now() - pitchStart;
  const fitBy = new Map<string, string | null>();
  for (const k of known ?? []) fitBy.set(k.video_id, k.fit);
  for (const r of fresh) fitBy.set(r.video_id, r.fit);

  const pitchedRank = ranked.filter(p => fitBy.has(p.video_id) && fitBy.get(p.video_id) !== 'no');
  const ordered = [
    ...pitchedRank.filter(p => fitBy.get(p.video_id) === 'yes'),
    ...pitchedRank.filter(p => fitBy.get(p.video_id) === 'stretch'),
  ];
  // At most two per channel, or one prolific channel fills the whole drop
  // (first live run: five of seven from the same one). Topped up past the
  // cap only if there is nothing else.
  const perChannel = new Map<string, number>();
  const picked: string[] = [];
  for (const p of ordered) {
    if (picked.length >= limit) break;
    const n = perChannel.get(p.channel_id) ?? 0;
    if (n >= PER_CHANNEL) continue;
    perChannel.set(p.channel_id, n + 1);
    picked.push(p.video_id);
  }
  for (const p of ordered) {
    if (picked.length >= limit) break;
    if (!picked.includes(p.video_id)) picked.push(p.video_id);
  }
  const chosen = picked;
  if (chosen.length === 0) return 0;

  const { error } = await supabase.from('competitor_ideas')
    .update({ drop_date: dropDate }).eq('user_id', userId).in('video_id', chosen);
  if (error) throw error;
  return chosen.length;
}

// Takes the claim and builds. A second caller that loses the race returns
// without building: the first one's drop is on its way.
async function claimAndBuild(supabase: any, userId: string, dropDate: string, ytApiKey: string): Promise<number | null> {
  const { data: profile } = await supabase
    .from('user_tokens')
    .select('idea_drop_date, idea_query, idea_query_at, channel_niche, channel_description')
    .eq('user_id', userId).maybeSingle();
  if (profile?.idea_drop_date === dropDate) return null;

  const { data: claimed } = await supabase
    .from('user_tokens').update({ idea_drop_date: dropDate })
    .eq('user_id', userId)
    .or(`idea_drop_date.is.null,idea_drop_date.neq.${dropDate}`)
    .select('user_id');
  if (!claimed?.length) return null;

  try {
    const n = await buildDrop(supabase, userId, dropDate, profile, ytApiKey);
    // An empty drop is usually "nothing to search for yet". Hand the claim
    // back so it is tried again once they connect a channel or fill in the
    // brain, instead of waiting for tomorrow.
    if (n === 0) {
      await supabase.from('user_tokens')
        .update({ idea_drop_date: profile?.idea_drop_date ?? null }).eq('user_id', userId);
    }
    return n;
  } catch (e) {
    // Give the claim back so the next open can try again.
    await supabase.from('user_tokens')
      .update({ idea_drop_date: profile?.idea_drop_date ?? null }).eq('user_id', userId);
    throw e;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });

  try {
    const ytApiKey = Deno.env.get('YOUTUBE_API_KEY');
    if (!ytApiKey) throw new Error('YouTube API key not configured');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    );

    // ── Cron: prebuild for everyone whose morning has come ──
    const cronSecret = Deno.env.get('CRON_SECRET');
    const provided = req.headers.get('x-cron-secret');
    if (provided) {
      if (!cronSecret || provided !== cronSecret) return json({ error: 'Unauthorized' }, 401);
      const started = Date.now();
      const { data: users } = await supabase
        .from('user_tokens').select('user_id, plan, timezone, idea_drop_date')
        .gte('idea_seen_at', new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString());
      let built = 0, skipped = 0;
      // Subscribers only since 2026-11-09: no plan, no model calls.
      for (const u of (users ?? []).filter((x: any) => x.plan && x.plan !== 'free')) {
        if (Date.now() - started > CRON_BUDGET_MS) { skipped++; continue; }
        const tz = validTz(u.timezone) ?? 'UTC';
        const dropDate = dropDateFor(tz);
        if (u.idea_drop_date === dropDate) continue;
        try {
          const n = await claimAndBuild(supabase, u.user_id, dropDate, ytApiKey);
          if (n != null) built++;
        } catch (e) {
          console.error(`[daily-ideas] cron build ${u.user_id} failed:`, e);
        }
      }

      // Tidy Saved and Dismissed so they stay short (Ivan, 2026-10-11).
      // Nothing is deleted: the row keeps a drop_date, which is what stops the
      // same video coming back in a later drop. It just leaves both tabs.
      // - dismissed: after a week;
      // - saved: after a month, but only if nothing was done with it. An idea
      //   with an outline, a read or a project is work someone paid for.
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const today = new Date().toISOString().slice(0, 10);
      const { data: oldDismissed } = await supabase.from('competitor_ideas')
        .select('id, drop_date').eq('liked', false).lt('created_at', weekAgo).limit(500);
      const { data: oldSaved } = await supabase.from('competitor_ideas')
        .select('id, drop_date').eq('liked', true).lt('created_at', monthAgo)
        .is('outline', null).is('concept', null).is('project_id', null).limit(500);
      let tidied = 0;
      for (const r of [...(oldDismissed ?? []), ...(oldSaved ?? [])]) {
        await supabase.from('competitor_ideas').update({ liked: null, drop_date: r.drop_date ?? today }).eq('id', r.id);
        tidied++;
      }

      // With the time left, keep everyone's profile current, not just the
      // people who open Ideas. The brain is rebuilt weekly from their latest
      // and best uploads (one cheap call each, five a run); the voice is
      // checked weekly and only re-heard when the month's top Shorts changed
      // (two a run, since that means watching video). Created at signup by
      // onboarding; these keep it from going stale.
      const WEEK = 7 * 24 * 60 * 60 * 1000;
      const { data: everyone } = await supabase
        .from('user_tokens').select('user_id, plan, brain_at, voice_at, access_token, channel_description');
      const subscribers = (everyone ?? []).filter((x: any) => x.plan && x.plan !== 'free');
      const hasChannel = (u: any) => !!u.access_token;
      const due = (at: string | null) => !at || Date.now() - new Date(at).getTime() > WEEK;

      let brains = 0;
      for (const u of subscribers) {
        if (brains >= 5 || Date.now() - started > CRON_BUDGET_MS - 30_000) break;
        if (!due(u.brain_at) || (!hasChannel(u) && !u.channel_description)) continue;
        try {
          brains++;
          // Nothing to read still counts as a visit, so it is not retried hourly.
          if (!await buildBrain(supabase, u.user_id)) {
            await supabase.from('user_tokens').update({ brain_at: new Date().toISOString() }).eq('user_id', u.user_id);
          }
        } catch (e) {
          console.error(`[daily-ideas] brain ${u.user_id} failed:`, e);
        }
      }

      let voices = 0;
      for (const u of subscribers) {
        if (voices >= 2 || Date.now() - started > CRON_BUDGET_MS - 40_000) break;
        if (!hasChannel(u) || u.voice_at && Date.now() - new Date(u.voice_at).getTime() < VOICE_TTL_MS) continue;
        try {
          voices++;
          // Stamped first, so a creator with no Shorts is not retried hourly.
          await supabase.from('user_tokens').update({ voice_at: new Date().toISOString() }).eq('user_id', u.user_id);
          await buildVoice(supabase, u.user_id);
        } catch (e) {
          console.error(`[daily-ideas] voice ${u.user_id} failed:`, e);
          // A failed build (the model was down) tries again tomorrow, not in a week.
          await supabase.from('user_tokens')
            .update({ voice_at: new Date(Date.now() - VOICE_TTL_MS + 86_400_000).toISOString() }).eq('user_id', u.user_id);
        }
      }
      return json({ ok: true, built, skipped, tidied, brains, voices });
    }

    // ── App: today's drop for this user, built on the spot if missing ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    await ensureTokensRow(supabase, user.id);
    const { data: row } = await supabase
      .from('user_tokens').select('timezone, plan').eq('user_id', user.id).maybeSingle();
    if (!row?.plan || row.plan === 'free') return json({ error: 'subscription_required' }, 402);
    const tz = validTz(body.timezone) ?? validTz(row?.timezone) ?? 'UTC';
    await supabase.from('user_tokens')
      .update({ timezone: tz, idea_seen_at: new Date().toISOString() }).eq('user_id', user.id);

    const dropDate = dropDateFor(tz);
    await claimAndBuild(supabase, user.id, dropDate, ytApiKey);

    // More, for credits: researched ideas only (MORE_OWN). Same date, so they
    // sit with today's and go at the next drop like the rest. Charged only
    // when something was actually written.
    let more: { added: number; error?: string } | undefined;
    if (body.more === true) {
      const isAdmin = user.email === 'reyzostyle@gmail.com';
      const status = await loadCreditStatus(supabase, user.id);
      const cost = CREDIT_COSTS.more_ideas;
      if (!canAfford(status, cost, isAdmin)) {
        more = { added: 0, error: 'limit_reached' };
      } else {
        const added = await suggestFromChannel(supabase, user.id, MORE_OWN, dropDate)
          .catch(e => { console.error('[daily-ideas] more failed:', e); return 0; });
        if (added > 0) await spendCredits(supabase, user.id, status, cost);
        more = { added };
      }
    }

    const { data: rows } = await supabase
      .from('competitor_ideas').select('*')
      .eq('user_id', user.id).eq('drop_date', dropDate)
      .order('outlier_score', { ascending: false, nullsFirst: false });
    // Own-channel ideas dealt in among the outliers (one after every two),
    // not left in a block at the end where the grid buries them.
    const ownRows = (rows ?? []).filter((r: any) => r.source === 'ai');
    const items: any[] = [];
    for (const r of (rows ?? []).filter((r: any) => r.source !== 'ai')) {
      items.push(r);
      if (items.length % 3 === 2 && ownRows.length) items.push(ownRows.shift());
    }
    items.push(...ownRows);

    let needsProfile = false;
    if (!items.length) {
      const [brain, scan] = await Promise.all([loadBrain(supabase, user.id), loadChannelScan(supabase, user.id)]);
      needsProfile = !brain && !scan?.videos?.length;
    }

    return json({ date: dropDate, nextAt: nextDropAt(tz), size: DROP_SIZE, items, needsProfile, more });
  } catch (error) {
    console.error('[daily-ideas]', error);
    return json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500);
  }
});
