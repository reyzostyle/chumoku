// deno-lint-ignore-file no-explicit-any
import { BASELINE_SIZE, MIN_BASELINE, BASELINE_MIN_AGE_DAYS, isShort, median, ageDays, roundScore } from './channel-baseline.ts';
import { fetchRecentVideos, platformOf, storeThumbnails, type Platform } from './social.ts';

// Building one channel's slice of the shared competitor pool: which of its
// last fifty Shorts beat its own median, and by how much. Lives here because
// two callers need it - the Ideas refresh (tracked channels) and the daily
// drop (tracked channels plus the ones a niche search turned up).

// A video is worth surfacing when it out-performs what this channel normally
// does. The obvious way to normalise for age is views-per-day, and that is what
// this used to do - but it is wrong for Shorts, and badly so. A Short collects
// almost all of its views in the first week, so dividing by lifetime makes the
// number collapse as the video ages: on a live pool, Cluely's 4.2M-view Short
// from four months ago scored 70x while a 1.1M-view one from four days ago
// scored 552x. The metric was measuring age, and "Top outliers" had quietly
// become "Newest".
//
// So: compare total views against the channel's median total views, and only
// judge videos that have had a fair run at it. A two-day-old Short has not
// beaten anything yet; it enters the pool a week later, on the same footing as
// everything else, because the pool is rebuilt hourly and spans the last 50
// uploads either way.
export const OUTLIER_THRESHOLD = 1.5; // times the channel's median views
export const POOL_PER_CHANNEL = 30;   // how deep the pool goes per channel

// YouTube reads are free, so its channels can refresh hourly. A TikTok or
// Instagram channel costs three paid requests, and an outlier takes days to
// show anyway.
export const SOCIAL_SYNC_TTL_MS = 48 * 60 * 60 * 1000;
const SOCIAL_BASELINE_MIN_AGE_DAYS = 2;
export const isSocial = (channelId: string) => platformOf(channelId) !== 'youtube';

// English only. Auto-find pulled in a Portuguese channel and its videos landed
// in the feed, which is worse than useless: an idea you cannot read is an idea
// you cannot adapt. Videos that declare no language at all are KEPT - plenty of
// creators never set the field, and dropping them would empty the feed to
// enforce a rule most uploads do not answer.
export function isEnglish(item: any): boolean {
  const lang = item.snippet?.defaultAudioLanguage || item.snippet?.defaultLanguage;
  return !lang || String(lang).toLowerCase().startsWith('en');
}
// BASELINE_MIN_AGE_DAYS (channel-baseline.ts) applies to the baseline only,
// not to what gets surfaced: under this formula a fresh video is understated,
// not overstated, so it can be shown honestly the day it goes up.

export interface PoolVideo {
  videoId: string;
  title: string;
  views: number;
  publishedAt: string;
  outlierScore: number | null;
  thumbnail?: string | null;
}

// A TikTok or Instagram account by its id, "tiktok:handle". Same output as the
// YouTube read below: from here on the pool does not care where a video is from.
async function socialShorts(channelId: string) {
  const handle = channelId.slice(channelId.indexOf(':') + 1);
  const videos = await fetchRecentVideos(platformOf(channelId) as Platform, handle);
  return videos
    .filter(v => v.duration == null || v.duration <= 180)
    .filter(v => !v.language || v.language.startsWith('en'))
    .map(v => ({ videoId: v.videoId, title: v.title, views: v.views, publishedAt: v.publishedAt, thumbnail: v.thumbnail }));
}

export async function fetchChannelPool(
  channelId: string,
  ytApiKey: string,
): Promise<{ videos: PoolVideo[]; medianViews: number }> {
  if (isSocial(channelId)) return scorePool(await socialShorts(channelId), SOCIAL_BASELINE_MIN_AGE_DAYS);

  const channelRes = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&part=contentDetails&key=${ytApiKey}`
  );
  if (!channelRes.ok) throw new Error(`YouTube channels API error: ${await channelRes.text()}`);
  const channelData = await channelRes.json();
  const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return { videos: [], medianViews: 0 };

  const playlistRes = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?playlistId=${uploadsPlaylistId}&part=snippet,contentDetails&maxResults=${BASELINE_SIZE}&key=${ytApiKey}`
  );
  if (!playlistRes.ok) throw new Error(`YouTube playlistItems API error: ${await playlistRes.text()}`);
  const playlistData = await playlistRes.json();
  const videoIds = (playlistData.items || [])
    .map((item: any) => item.contentDetails?.videoId)
    .filter(Boolean)
    .slice(0, 50); // videos.list caps at 50 ids per call

  if (videoIds.length === 0) return { videos: [], medianViews: 0 };

  // One stats call covers the whole baseline (same quota cost as fetching five).
  const statsRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?id=${videoIds.join(',')}&part=snippet,statistics,contentDetails,liveStreamingDetails&key=${ytApiKey}`
  );
  if (!statsRes.ok) throw new Error(`YouTube videos API error: ${await statsRes.text()}`);
  const statsData = await statsRes.json();

  const shorts = (statsData.items || [])
    .filter(isShort)
    .filter(isEnglish)
    .map((item: any) => ({
      videoId: item.id,
      title: item.snippet.title,
      views: parseInt(item.statistics?.viewCount || '0', 10),
      publishedAt: item.snippet.publishedAt,
    }))
    .filter((v: any) => v.publishedAt);

  return scorePool(shorts);
}

function scorePool(shorts: any[], minAgeDays = BASELINE_MIN_AGE_DAYS): { videos: PoolVideo[]; medianViews: number } {
  // What "normal" means for this channel is decided by videos that have
  // finished performing. What gets SHOWN is every short, measured against that.
  let baseline = shorts.filter((v: any) => ageDays(v.publishedAt) >= minAgeDays);
  // Three pages of a daily poster can all be days old, which left no baseline
  // at all (@garyvee on TikTok). Fresh views understate, which only makes the
  // bar lower: better than never scoring the account.
  if (minAgeDays < BASELINE_MIN_AGE_DAYS && baseline.length < MIN_BASELINE) baseline = shorts;

  if (shorts.length === 0) return { videos: [], medianViews: 0 };

  const medianViews = median(baseline.map((v: any) => v.views));

  // Too little history (or a channel with no views at all) to call anything an
  // outlier - pool the most recent handful unscored rather than nothing.
  if (baseline.length < MIN_BASELINE || medianViews <= 0) {
    const recent = [...shorts]
      .sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, POOL_PER_CHANNEL)
      .map((v: any) => ({
        videoId: v.videoId, title: v.title, views: v.views,
        publishedAt: v.publishedAt, outlierScore: null, thumbnail: v.thumbnail,
      }));
    return { videos: recent, medianViews: 0 };
  }

  // No age limit either way. A video that tripled its channel is worth seeing
  // whether it went up yesterday or in March: the old 14-day ceiling is half of
  // why the inbox used to run dry, and a floor would have hidden exactly the
  // thing people open this tab for. Age is an input to the feed's sort, never a
  // gate on what exists.
  const videos = shorts
    .map((v: any) => ({ ...v, outlierScore: v.views / medianViews }))
    .filter((v: any) => v.outlierScore >= OUTLIER_THRESHOLD)
    .sort((a: any, b: any) => b.outlierScore - a.outlierScore)
    .slice(0, POOL_PER_CHANNEL)
    .map((v: any) => ({
      videoId: v.videoId,
      title: v.title,
      views: v.views,
      publishedAt: v.publishedAt,
      outlierScore: roundScore(v.outlierScore),
      thumbnail: v.thumbnail,
    }));

  return { videos, medianViews };
}

// Fetches a channel and makes the pool authoritative for it: prunes what no
// longer qualifies, upserts what does, stamps the sync. Returns the videos.
export async function syncChannelPool(
  supabase: any,
  channelId: string,
  channelName: string | null,
  ytApiKey: string,
): Promise<PoolVideo[]> {
  const result = await fetchChannelPool(channelId, ytApiKey);

  // Prune first. Upsert alone can only ever add: rows pooled under an older
  // rule stayed forever, so tightening the filter (English only, a new
  // scoring formula) left the feed carrying videos it would no longer
  // accept. The pool is derived data, so the refresh is allowed to be
  // authoritative about what belongs in it.
  const keep = new Set(result.videos.map(v => v.videoId));
  const { data: pooled } = await supabase
    .from('competitor_videos').select('video_id').eq('channel_id', channelId);
  const stale = (pooled ?? []).map((r: any) => r.video_id).filter((id: string) => !keep.has(id));
  if (isSocial(channelId)) {
    const have = new Set((pooled ?? []).map((r: any) => r.video_id));
    await storeThumbnails(supabase, result.videos.filter(v => !have.has(v.videoId)));
  }
  if (stale.length) {
    await supabase.from('competitor_videos').delete().in('video_id', stale);
  }

  if (result.videos.length > 0) {
    const { error: upsertError } = await supabase.from('competitor_videos').upsert(
      result.videos.map(v => ({
        video_id: v.videoId,
        channel_id: channelId,
        channel_name: channelName,
        title: v.title,
        views: v.views,
        published_at: v.publishedAt,
        outlier_score: v.outlierScore,
        refreshed_at: new Date().toISOString(),
      })),
      { onConflict: 'video_id' },
    );
    if (upsertError) console.error('[pool] upsert error:', upsertError);
  }

  await supabase.from('competitor_channel_pool').upsert({
    channel_id: channelId,
    synced_at: new Date().toISOString(),
    median_views: result.medianViews,
    video_count: result.videos.length,
  }, { onConflict: 'channel_id' });

  return result.videos;
}
