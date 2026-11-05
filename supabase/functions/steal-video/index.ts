import { languageRule, loadLanguage } from '../_shared/language.ts';
import { corsHeaders } from '../_shared/http.ts';
import { loadVoiceBlock } from '../_shared/voice.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { channelIdOf, fetchVideo, parseVideoLink, storeThumbnails, thumbUrl } from '../_shared/social.ts';
import { syncChannelPool } from '../_shared/channel-pool.ts';
import { loadCreditStatus, canAfford, spendCredits, CREDIT_COSTS } from '../_shared/credits.ts';
import { loadChannelScan, channelScanBlock } from '../_shared/channel-scan.ts';
import { loadBrain, brainBlock } from '../_shared/brain.ts';
import { fetchTranscript, extractConceptAndAdapt, generateOutline } from '../_shared/steal.ts';
import { channelShortsMedian, roundScore } from '../_shared/channel-baseline.ts';

const CORS = corsHeaders({ methods: 'POST, OPTIONS' });

// "Steal this format" on any Short, not just one from a tracked competitor.
//
// This is the Competitors pipeline with the discovery step removed: the user
// found the video themselves, scrolling, and pressed the button in the Chrome
// extension or shared it from their phone. So it runs the two paid passes back
// to back - read and adapt the idea, then watch it and write the outline - and
// files the result as a saved idea, where the drawer already knows how to show
// it.
//
// enrich-competitor-video refuses anything outside the user's feed, because it
// is the cheap first step of a browse and would otherwise run the model on any
// string. Here the whole price is paid up front for one video a person picked,
// so there is nothing to protect by restricting the source.

const ADMIN_EMAIL = 'reyzostyle@gmail.com';

// Longer than any Short. A watch pass on a twenty-minute video costs many times
// what a Short does and the prompts are written for a Short's structure, so the
// right answer is to say so rather than bill for a bad outline.
const MAX_SECONDS = 180;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Accepts a bare id or any of the shapes a link arrives in: /shorts/ID,
// watch?v=ID, youtu.be/ID, with or without tracking params, and the "check
// this out https://..." text a phone's share sheet sends.
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// The account's usual views, from the pool when it has been read, otherwise read
// now: three paid requests that also leave it in the pool for the next steal.
async function socialMedian(supabase: any, channelId: string): Promise<number | null> {
  const { data } = await supabase
    .from('competitor_channel_pool').select('median_views').eq('channel_id', channelId).maybeSingle();
  if (data?.median_views) return data.median_views;
  await syncChannelPool(supabase, channelId, null, '');
  const { data: fresh } = await supabase
    .from('competitor_channel_pool').select('median_views').eq('channel_id', channelId).maybeSingle();
  return fresh?.median_views || null;
}

function isoSeconds(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
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

    const { url } = await req.json().catch(() => ({}));
    const socialLink = typeof url === 'string' ? parseVideoLink(url) : null;
    const social = socialLink ? await fetchVideo(socialLink).catch(() => null) : null;
    if (socialLink && !social) return json({ error: "Couldn't find that video. It may be private or deleted." }, 404);
    const videoId = social?.videoId ?? (typeof url === 'string' ? parseVideoId(url) : null);
    if (!videoId) return json({ error: "That doesn't look like a link to a Short, TikTok or Reel." }, 400);

    // Stolen before. Hand back what is stored; charge only for the half that
    // is missing, so a video opened in the feed and read there (concept, no
    // outline) costs just the outline now.
    const { data: existing } = await supabase
      .from('competitor_ideas').select('*')
      .eq('user_id', user.id).eq('video_id', videoId).maybeSingle();
    if (existing?.concept && existing?.outline) {
      const now = new Date().toISOString();
      await supabase.from('competitor_ideas').update({ liked: true, created_at: now }).eq('id', existing.id);
      return json({ success: true, idea: { ...existing, liked: true, created_at: now }, charged: 0 });
    }

    const needsRead = !existing?.concept;
    // One price for a steal, read or not (2026-10-28).
    const cost = CREDIT_COSTS.script;
    const isAdmin = user.email === ADMIN_EMAIL;
    const creditStatus = await loadCreditStatus(supabase, user.id);
    if (!canAfford(creditStatus, cost, isAdmin)) return json({ error: 'limit_reached', cost });

    // Public facts about the video. It also tells us the video exists and is
    // short enough to be worth watching.
    let title = '', views = 0, channelId = '', channelName = '', thumbnail: string | null = null, publishedAt: string | null = null;
    let medianPromise: Promise<number | null> = Promise.resolve(null);
    if (social) {
      if ((social.duration ?? 0) > MAX_SECONDS) {
        return json({ error: 'Steal works on short videos. That one is longer than three minutes.' }, 400);
      }
      title = social.title;
      views = social.views;
      channelId = social.handle ? channelIdOf(social.platform, social.handle) : '';
      channelName = social.handle ? `@${social.handle}` : '';
      publishedAt = social.publishedAt;
      await storeThumbnails(supabase, [social]);
      thumbnail = thumbUrl(social.videoId);
      medianPromise = channelId ? socialMedian(supabase, channelId).catch(() => null) : medianPromise;
    } else {
      const apiKey = Deno.env.get('YOUTUBE_API_KEY');
      if (!apiKey) throw new Error('YOUTUBE_API_KEY is not set');
      const ytRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${apiKey}`,
      );
      if (!ytRes.ok) throw new Error(`YouTube lookup failed (${ytRes.status})`);
      const video = (await ytRes.json()).items?.[0];
      if (!video) return json({ error: "Couldn't find that video. It may be private or deleted." }, 404);
      if (isoSeconds(video.contentDetails?.duration || '') > MAX_SECONDS) {
        return json({ error: 'Steal works on Shorts. That video is longer than three minutes.' }, 400);
      }

      title = video.snippet?.title || '';
      views = Number(video.statistics?.viewCount || 0);
      channelId = video.snippet?.channelId || '';
      channelName = video.snippet?.channelTitle || '';
      thumbnail = video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.default?.url || null;
      publishedAt = video.snippet?.publishedAt || null;

      // How far this Short beat its own channel: the number the steal card leads
      // with. Started now, read after the profile loads, so it costs no extra
      // wait. A row the feed already scored keeps its score if this comes back
      // empty (too little history, or the API said no).
      medianPromise = channelId ? channelShortsMedian(channelId, apiKey).catch(() => null) : medianPromise;
    }

    // Same profile the feed adapts against: the brain if built, the four typed
    // boxes if not. A steal is always adapted - adapting is the point of it.
    const [brain, language] = await Promise.all([loadBrain(supabase, user.id), loadLanguage(supabase, user.id)]);
    const { data: profile } = await supabase
      .from('user_tokens').select('channel_niche, channel_description, channel_context, target_audience')
      .eq('user_id', user.id).maybeSingle();
    const niche = brain?.niche || profile?.channel_niche || '';
    const profileBlock = brain ? brainBlock(brain) : `## What they told us about their channel
Niche: ${profile?.channel_niche || 'not set'}
Description: ${profile?.channel_description || 'not set'}
Audience: ${profile?.target_audience || 'not set'}
Extra context: ${profile?.channel_context || 'not set'}`;
    const scanBlock = channelScanBlock(await loadChannelScan(supabase, user.id));

    const channelMedian = await medianPromise;
    const outlierScore = channelMedian ? roundScore(views / channelMedian) : (existing?.outlier_score ?? null);

    let concept: string = existing?.concept || '';
    let adaptedIdea: string = existing?.adapted_idea || '';
    if (needsRead) {
      const transcript = await fetchTranscript(videoId);
      const read = await extractConceptAndAdapt(videoId, title, views, outlierScore, transcript, profileBlock + languageRule(language), scanBlock, niche);
      concept = read.concept;
      adaptedIdea = read.adapted_idea;
    }
    if (!concept && !adaptedIdea) throw new Error('Could not read that video. Nothing was charged.');

    const outline = await generateOutline(videoId, title, adaptedIdea, profileBlock + languageRule(language), scanBlock, await loadVoiceBlock(supabase, user.id));

    const { data: idea, error: upsertError } = await supabase
      .from('competitor_ideas')
      .upsert({
        user_id: user.id,
        channel_id: channelId,
        channel_name: channelName,
        video_id: videoId,
        video_title: title,
        video_thumbnail: thumbnail,
        video_views: views,
        outlier_score: outlierScore,
        video_published_at: publishedAt,
        concept,
        adapted_idea: adaptedIdea,
        outline,
        // Pressing Steal is a save. It lands in Saved, next to everything
        // else they kept from the feed.
        liked: true,
        // A save made now. Without this a video that was already a row (seen
        // in the feed weeks ago) kept its old date, and "my last idea" in the
        // chat skipped straight past the thing just stolen.
        created_at: new Date().toISOString(),
      }, { onConflict: 'user_id,video_id' })
      .select()
      .single();
    if (upsertError) throw upsertError;

    await spendCredits(supabase, user.id, creditStatus, cost);

    return json({ success: true, idea, charged: cost });
  } catch (error) {
    console.error('[steal-video]', error);
    return json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500);
  }
});
