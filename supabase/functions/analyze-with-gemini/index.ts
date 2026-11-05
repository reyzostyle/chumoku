import { loadLanguage } from '../_shared/language.ts';
import { corsHeaders } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { fetchVideo, platformOf, videoLink, videoSource } from '../_shared/social.ts';
import { loadCreditStatus, canAfford, spendCredits, CREDIT_COSTS } from '../_shared/credits.ts';
import { analyzeVideo } from '../_shared/analyze-video.ts';
import { parseImages, type AttachedImage } from '../_shared/images.ts';
import { loadBrain } from '../_shared/brain.ts';
import { freshAccessToken } from '../_shared/youtube-token.ts';
import { ownVideoRetention, retentionBlock, loadUsual, beatsFromTimeline, attachBeats, type RetentionRow } from '../_shared/retention.ts';

const CORS = corsHeaders({ methods: 'GET, POST, PUT, DELETE, OPTIONS' });

const MAX_SHORT_SECONDS = 180;

interface RequestBody {
  videoId: string; // YouTube video ID
  videoContext?: string;
  // Screenshots sent with the link. Retention for someone else's video, or for
  // a channel that is not connected, exists nowhere this function can fetch it.
  images?: AttachedImage[];
}

async function fetchPublicVideoData(videoId: string, accessTokenOrApiKey: string, useApiKey = false): Promise<any> {
  const url = useApiKey
    ? `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics,contentDetails&key=${accessTokenOrApiKey}`
    : `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics,contentDetails`;
  const res = await fetch(url, useApiKey ? {} : { headers: { Authorization: `Bearer ${accessTokenOrApiKey}` } });
  if (!res.ok) throw new Error(`YouTube API error: ${await res.text()}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error('Video not found on YouTube');

  // Parse ISO 8601 duration (PT1M30S → 90)
  const dur = item.contentDetails.duration || 'PT0S';
  const durMatch = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const durationSec = durMatch
    ? (parseInt(durMatch[1] || '0') * 3600 + parseInt(durMatch[2] || '0') * 60 + parseInt(durMatch[3] || '0'))
    : 0;

  return {
    video_id: videoId,
    channel_id: item.snippet.channelId,
    title: item.snippet.title,
    thumbnail_url: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    views: parseInt(item.statistics.viewCount || '0'),
    likes_count: parseInt(item.statistics.likeCount || '0'),
    comment_count: parseInt(item.statistics.commentCount || '0'),
    duration: durationSec,
    retention_percentage: null,
    average_view_duration: null,
    is_external: true,
  };
}

// The connected account's own channel id (authoritative for ownership).
async function getOwnChannelId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.items?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || serviceKey;

    // Admin client for DB operations
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }
    const token = authHeader.replace('Bearer ', '');

    // Verify the JWT signature via the auth server, then read id/email from the
    // VERIFIED user. Never trust raw token claims — the signature isn't checked
    // by the gateway, so a decoded-only token could be forged (e.g. admin email).
    let userId: string;
    let userEmail: string;
    try {
      const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !authUser) throw new Error('invalid token');
      userId = authUser.id;
      userEmail = authUser.email || '';
    } catch {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    const { videoId, videoContext, images: rawImages }: RequestBody = await req.json();
    const { images, error: imageError } = parseImages(rawImages);
    if (imageError) {
      return new Response(
        JSON.stringify({ error: imageError }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }
    console.log(`[analyze-with-gemini] user=${userId}, videoId=${videoId}`);

    // Check plan limits
    const { data: tokenRow } = await supabase
      .from('user_tokens')
      .select('plan, channel_niche, channel_description, channel_context, creator_level, access_token, refresh_token, token_expiry')
      .eq('user_id', userId)
      .maybeSingle();

    const plan = tokenRow?.plan || 'free';
    const isAdmin = userEmail === 'reyzostyle@gmail.com';

    // Every plan, including free, spends from the shared credit pool — free's
    // allowance is just a one-time grant that never resets (_shared/credits.ts).
    const creditStatus = await loadCreditStatus(supabase, userId);
    if (!canAfford(creditStatus, CREDIT_COSTS.video_analysis, isAdmin)) {
      const message = plan === 'agency'
        ? "You've hit this month's fair-use credit limit. Contact us if you need more."
        : plan === 'free'
          ? 'Your free credits are used up. Upgrade to keep analyzing.'
          : "You've used all your credits this month. Upgrade for more.";
      return new Response(
        JSON.stringify({ error: message }),
        { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Get video data — own channel first, then fall back to public YouTube API
    const { data: ownVideo } = await supabase
      .from('videos')
      .select('*')
      .eq('user_id', userId)
      .eq('video_id', videoId)
      .maybeSingle();

    let video = ownVideo;

    const social = platformOf(videoId) !== 'youtube' ? await fetchVideo(videoLink(videoId)).catch(() => null) : null;
    if (social) {
      video = { video_id: videoId, title: social.title, views: social.views, likes_count: null, comment_count: null, duration: social.duration, published_at: social.publishedAt };
    }

    if (!video) {
      console.log('[analyze-with-gemini] External video — fetching public stats via API key...');
      const ytApiKey = Deno.env.get('YOUTUBE_API_KEY');
      if (ytApiKey) {
        try {
          video = await fetchPublicVideoData(videoId, ytApiKey, true);
          console.log('[analyze-with-gemini] External video stats fetched:', video.title);
        } catch (e) {
          console.log('[analyze-with-gemini] Could not fetch stats, proceeding without:', e);
          video = { video_id: videoId, title: `youtube.com/watch?v=${videoId}`, views: null, likes_count: null, comment_count: null, duration: null, retention_percentage: null, average_view_duration: null, is_external: true };
        }
      } else {
        video = { video_id: videoId, title: `youtube.com/watch?v=${videoId}`, views: null, likes_count: null, comment_count: null, duration: null, retention_percentage: null, average_view_duration: null, is_external: true };
      }
    }

    // Shorts only. A Short can run up to 3 minutes; anything longer is a
    // long-form video, and the whole review (beat timeline, hook, retention
    // score) is built for the other format. It watched a 15-minute video and
    // scored it 94. Checked before the model call, so nothing is spent.
    // Unknown duration (API down) goes through rather than blocking real Shorts.
    if (video.duration && video.duration > MAX_SHORT_SECONDS) {
      return new Response(
        JSON.stringify({ error: 'This works on Shorts only. That video is longer than 3 minutes.' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Whose video this is, as three states rather than two.
    //
    // `is_my_video` below is a boolean, so "we could not check" has always been
    // recorded as "not theirs" - and an account with no YouTube connected can
    // never be checked. That is half of why the chat talks about someone
    // else's Short as though the creator made it, and it would be just as
    // wrong in the other direction. A claim nobody verified is not a finding.
    //
    // Kept in the hook_analysis jsonb rather than a new column: nothing here
    // needs a migration, and every consumer already reads that object.
    let ownership: 'mine' | 'theirs' | 'unknown' = 'unknown';
    // A video already synced into `videos` for this account is known-own
    // without asking YouTube anything.
    if (ownVideo) ownership = 'mine';

    // ── Own-video deep stats ────────────────────────────────────────────────
    // If this video belongs to the connected YouTube account, pull its private
    // retention curve (Analytics API) and treat it as the user's own content.
    // Requires the yt-analytics.readonly scope; degrades silently without it.
    //
    // The curve is read in seconds and stored by _shared/retention.ts, and the
    // prompt gets the drops with their exact seconds. Until 2026-10-28 this
    // passed "at ~12% of the video: -25% viewers" and let the model convert.
    let retentionRow: RetentionRow | null = null;
    if (tokenRow?.access_token) {
      try {
        const accessToken = await freshAccessToken(supabase, userId);
        if (!accessToken) throw new Error('YouTube token could not be refreshed');

        // Synced videos are already known-own. For pasted/unsynced videos, match
        // the video's channel against the connected account's channel.
        let isOwn = !!ownVideo;
        if (!isOwn && video.channel_id) {
          const ownChannelId = await getOwnChannelId(accessToken);
          isOwn = !!ownChannelId && ownChannelId === video.channel_id;
          // Only a comparison that actually ran can say "theirs". If YouTube
          // did not hand back a channel id, we still do not know.
          if (!isOwn && ownChannelId) ownership = 'theirs';
        }
        if (isOwn) ownership = 'mine';

        if (isOwn) {
          video.is_external = false;
          const { row } = await ownVideoRetention(supabase, userId, videoId, {
            token: accessToken,
            meta: { title: video.title, duration: video.duration, published_at: video.published_at ?? null },
          });
          if (row) {
            retentionRow = row;
            if (row.avg_view_pct != null) video.retention_percentage = Math.round(row.avg_view_pct);
            if (row.avg_view_s != null) video.average_view_duration = Math.round(row.avg_view_s);
            video.retention_block = retentionBlock(row, await loadUsual(supabase, userId, videoId));
            console.log(`[analyze-with-gemini] Own video: stayed=${row.stayed_pct}, avg%=${row.avg_view_pct}, drops=${JSON.stringify(row.drops)}`);
          }
        }
      } catch (e) {
        console.log('[analyze-with-gemini] Retention fetch skipped:', e);
      }
    }

    const profile = {
      // Built once in Settings or at the end of onboarding, never here: an
      // account waiting on a video analysis should not also be paying for a
      // second model call it did not ask for. See _shared/brain.ts.
      brain: await loadBrain(supabase, userId),
      language: await loadLanguage(supabase, userId),
      channel_niche: tokenRow?.channel_niche || '',
      channel_description: tokenRow?.channel_description || '',
      channel_context: tokenRow?.channel_context || '',
      creator_level: tokenRow?.creator_level || 'intermediate',
    };

    // One pass: the same model watches the video and writes the verdict.
    console.log('[analyze-with-gemini] Analyzing video...');
    const analysis = await analyzeVideo(
      await videoSource(videoId),
      video, profile, videoContext, supabase, profile.creator_level, images,
    );
    console.log('[analyze-with-gemini] Done, transcript length:', analysis.transcript?.length);

    // The review watched it beat by beat; that timeline is what is said and
    // shown at each second, so the drops get pinned without a second watch.
    if (retentionRow && !retentionRow.beats_at) {
      const beats = beatsFromTimeline(analysis.timeline);
      if (beats) await attachBeats(supabase, retentionRow, beats).catch(e => console.log('[analyze-with-gemini] beats not stored:', e));
    }

    // Save transcript only for own videos
    if (analysis.transcript && !video.is_external) {
      await supabase
        .from('videos')
        .update({ transcript: analysis.transcript })
        .eq('user_id', userId)
        .eq('video_id', videoId);
    }

    // Save analysis
    const { data: analysisData, error: analysisError } = await supabase
      .from('analyses')
      .insert({
        user_id: userId,
        video_ids: [videoId],
        hook_analysis: { overall_assessment: analysis.overall_assessment, overall_score: analysis.overall_score, score_breakdown: analysis.score_breakdown || null, title: video.title || null, source: 'youtube', ownership },
        strong_spots: analysis.strong_spots || [],
        weak_spots: analysis.weak_spots,
        new_hook_ideas: [],
        analysis_type: 'advanced',
        is_my_video: video.is_external === false,
      })
      .select()
      .single();

    if (analysisError) throw analysisError;

    await spendCredits(supabase, userId, creditStatus, CREDIT_COSTS.video_analysis);

    return new Response(
      JSON.stringify({
        success: true,
        analysis: analysisData,
        gemini: {
          transcript: analysis.transcript,
          hook_visual: analysis.hook_visual,
          visual_observations: analysis.visual_observations,
          overall_energy: analysis.overall_energy,
          technical_audit: analysis.technical_audit,
          timeline: analysis.timeline || [],
        },
      }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[analyze-with-gemini] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
