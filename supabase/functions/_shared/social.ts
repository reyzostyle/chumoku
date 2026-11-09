// deno-lint-ignore-file no-explicit-any
// TikTok and Instagram, read through ScrapeCreators. Neither platform offers an
// official way to read someone else's account for a commercial app (TikTok has
// nothing, Instagram only reaches professional accounts after App Review), so
// everything that talks to the vendor stays in this one file: replacing it, or
// moving Instagram onto Meta's API, must not touch the rest of the code.
//
// Ids carry the platform ("tiktok:7312...", "instagram:DAbc..."). The shared
// pool and every idea are keyed by plain text ids that YouTube already uses, so
// a prefix keeps them from colliding and lets any code tell where a row is from.

export type Platform = 'tiktok' | 'instagram';

export interface SocialProfile {
  platform: Platform;
  handle: string;
  channelId: string;
  name: string;
  avatar: string;
  followers: number | null;
}

export interface SocialVideo {
  videoId: string;
  platform: Platform;
  url: string;
  title: string;
  views: number;
  publishedAt: string;
  duration: number | null;   // seconds
  thumbnail: string | null;  // a signed CDN link that expires: see storeThumbnails
  downloadUrl: string | null;
  language: string | null;
  handle: string | null;
}

const BASE = 'https://api.scrapecreators.com';
// Paid requests made by this worker, read around a drop for idea_drop_stats.
export const socialUsage = { requests: 0 };

async function call(path: string, params: Record<string, string | undefined>): Promise<any> {
  const key = Deno.env.get('SCRAPECREATORS_API_KEY');
  if (!key) throw new Error('SCRAPECREATORS_API_KEY is not set');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  socialUsage.requests++;
  const res = await fetch(`${BASE}${path}?${q}`, { headers: { 'x-api-key': key } });
  const text = await res.text();
  if (!res.ok) throw new Error(`ScrapeCreators ${path} ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`ScrapeCreators ${path}: not JSON`); }
}

export const channelIdOf = (platform: Platform, handle: string) => `${platform}:${handle.toLowerCase()}`;
export const platformOf = (id: string | null | undefined): Platform | 'youtube' =>
  id?.startsWith('tiktok:') ? 'tiktok' : id?.startsWith('instagram:') ? 'instagram' : 'youtube';

const iso = (unix: any): string | null => {
  const n = Number(unix);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
const first = (v: any): string | null => (Array.isArray(v) ? v[0] : v) || null;
// TikTok lists a cover in several formats and some are HEIC, which browsers
// other than Safari cannot draw.
const image = (list: any): string | null => {
  const urls: string[] = Array.isArray(list) ? list : [];
  return urls.find(u => /\.jpe?g/i.test(u)) ?? urls.find(u => /\.webp/i.test(u)) ?? urls[0] ?? null;
};

// "tiktok.com/@name", "instagram.com/name/", "instagram.com/reel/...?" is not a
// profile. A bare "@name" says nothing about the platform: the caller decides.
export function parseProfile(input: string): { platform: Platform; handle: string } | null {
  const s = input.trim();
  const tt = s.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/i);
  if (tt) return { platform: 'tiktok', handle: tt[1] };
  const ig = s.match(/instagram\.com\/([a-zA-Z0-9_.]+)/i);
  if (ig && !['reel', 'reels', 'p', 'tv', 'stories', 'explore'].includes(ig[1].toLowerCase())) {
    return { platform: 'instagram', handle: ig[1] };
  }
  return null;
}

export async function fetchProfile(platform: Platform, handle: string): Promise<SocialProfile> {
  if (platform === 'tiktok') {
    const j = await call('/v1/tiktok/profile', { handle });
    const u = j.user ?? j.userInfo?.user;
    if (!u?.uniqueId) throw new Error(`TikTok profile not found: ${handle}`);
    return {
      platform, handle: u.uniqueId, channelId: channelIdOf(platform, u.uniqueId),
      name: u.nickname || u.uniqueId, avatar: u.avatarMedium || u.avatarThumb || '',
      followers: (j.stats ?? j.userInfo?.stats)?.followerCount ?? null,
    };
  }
  const j = await call('/v1/instagram/profile', { handle });
  const u = j.data?.user;
  if (!u?.username) throw new Error(`Instagram profile not found: ${handle}`);
  return {
    platform, handle: u.username, channelId: channelIdOf(platform, u.username),
    name: u.full_name || u.username, avatar: u.profile_pic_url_hd || u.profile_pic_url || '',
    followers: u.edge_followed_by?.count ?? null,
  };
}

function fromTikTok(a: any): SocialVideo | null {
  const publishedAt = iso(a.create_time);
  if (!a.aweme_id || !publishedAt) return null;
  const v = a.video ?? {};
  const noMark = first(v.download_no_watermark_addr?.url_list);
  const handle = a.author?.unique_id;
  return {
    videoId: `tiktok:${a.aweme_id}`, platform: 'tiktok',
    url: `https://www.tiktok.com/@${handle ?? '_'}/video/${a.aweme_id}`,
    title: a.desc || '',
    views: Number(a.statistics?.play_count ?? 0),
    publishedAt,
    duration: v.duration ? Math.round(v.duration / 1000) : null,
    thumbnail: image(v.cover?.url_list) ?? image(v.origin_cover?.url_list),
    downloadUrl: noMark ?? first(v.play_addr?.url_list),
    language: a.desc_language || null,
    handle: handle ?? null,
  };
}

function fromInstagram(raw: any): SocialVideo | null {
  const m = raw.media ?? raw;
  const publishedAt = iso(m.taken_at);
  if (!m.code || !publishedAt) return null;
  return {
    videoId: `instagram:${m.code}`, platform: 'instagram',
    url: `https://www.instagram.com/reel/${m.code}/`,
    title: m.caption?.text ?? (typeof m.caption === 'string' ? m.caption : ''),
    views: Number(m.play_count ?? m.ig_play_count ?? 0),
    publishedAt,
    duration: m.video_duration ? Math.round(Number(m.video_duration)) : null,
    thumbnail: m.image_versions2?.candidates?.[0]?.url ?? m.display_uri ?? null,
    downloadUrl: m.video_versions?.[0]?.url ?? null,
    language: null,
    handle: m.user?.username ?? m.owner?.username ?? null,
  };
}

// Pages of 10-12 videos, one credit each. Pinned videos stay out: a creator pins
// their biggest hit, which would skew the median.
export async function fetchRecentVideos(platform: Platform, handle: string, pages = 3): Promise<SocialVideo[]> {
  const out: SocialVideo[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    if (platform === 'tiktok') {
      const j = await call('/v3/tiktok/profile/videos', { handle, include_pinned: 'false', max_cursor: cursor });
      out.push(...(j.aweme_list ?? []).map(fromTikTok).filter(Boolean) as SocialVideo[]);
      cursor = j.has_more && j.max_cursor ? String(j.max_cursor) : undefined;
    } else {
      const j = await call('/v1/instagram/user/reels', { handle, require_play_counts: 'true', max_id: cursor });
      out.push(...(j.items ?? []).map(fromInstagram).filter(Boolean) as SocialVideo[]);
      cursor = j.paging_info?.more_available ? j.paging_info?.max_id : undefined;
    }
    if (!cursor) break;
  }
  return out;
}

// The first link to a single TikTok or Reel in whatever text a share sheet sent.
export function parseVideoLink(input: string): string | null {
  const tt = input.match(/https?:\/\/(?:[\w-]+\.)?tiktok\.com\/[^\s]+/i);
  if (tt) return tt[0];
  const ig = input.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/[\w-]+/i);
  return ig ? ig[0] : null;
}

export async function fetchVideo(url: string): Promise<SocialVideo | null> {
  if (/tiktok\.com/i.test(url)) {
    const j = await call('/v2/tiktok/video', { url });
    return j.aweme_detail ? fromTikTok(j.aweme_detail) : null;
  }
  const j = await call('/v1/instagram/post', { url });
  const m = j.data?.xdt_shortcode_media;
  if (!m?.shortcode) return null;
  return {
    videoId: `instagram:${m.shortcode}`, platform: 'instagram',
    url: `https://www.instagram.com/reel/${m.shortcode}/`,
    title: m.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
    views: Number(m.video_play_count ?? m.video_view_count ?? 0),
    publishedAt: iso(m.taken_at_timestamp) ?? new Date().toISOString(),
    duration: m.video_duration ? Math.round(Number(m.video_duration)) : null,
    thumbnail: m.thumbnail_src ?? m.display_url ?? null,
    downloadUrl: m.video_url ?? null,
    language: null,
    handle: m.owner?.username ?? null,
  };
}

// The link a stored id opens at. TikTok ignores the handle in the path.
export function videoLink(videoId: string): string {
  const [platform, id] = videoId.split(':');
  return platform === 'tiktok'
    ? `https://www.tiktok.com/@_/video/${id}`
    : `https://www.instagram.com/reel/${id}/`;
}

// Accounts winning on a phrase, best video first. One credit.
export async function searchChannels(platform: Platform, query: string, max: number): Promise<{ id: string; name: string }[]> {
  // deno-lint-ignore no-explicit-any
  const authors: any[] = platform === 'tiktok'
    ? ((await call('/v1/tiktok/search/keyword', { query, date_posted: 'this-month', sort_by: 'most-liked' })).search_item_list ?? [])
        .map((r: any) => r.aweme_info).filter((a: any) => !a?.desc_language || a.desc_language.startsWith('en'))
        .map((a: any) => ({ handle: a?.author?.unique_id, name: a?.author?.nickname, views: a?.statistics?.play_count }))
    : ((await call('/v2/instagram/reels/search', { query })).reels ?? [])
        .map((r: any) => ({ handle: r.owner?.username ?? r.user?.username, name: r.owner?.full_name ?? r.user?.full_name, views: r.video_play_count ?? r.play_count }));
  const seen = new Set<string>();
  return authors
    .filter(a => a.handle)
    .sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0))
    .filter(a => !seen.has(a.handle) && seen.add(a.handle))
    .slice(0, max)
    .map(a => ({ id: channelIdOf(platform, a.handle), name: a.name || a.handle }));
}

// Covers go to our own storage: the CDN links die within days, and a card must
// still draw weeks later. The name comes from the id, so every client can build
// the address without a column to read.
export async function storeThumbnails(supabase: any, videos: { videoId: string; thumbnail?: string | null }[]): Promise<void> {
  await Promise.all(videos.filter(v => v.thumbnail).map(async v => {
    try {
      const res = await fetch(v.thumbnail!);
      if (!res.ok) return;
      const type = res.headers.get('content-type') || 'image/jpeg';
      await supabase.storage.from('social-thumbs').upload(
        `${v.videoId.replace(':', '-')}.jpg`, await res.arrayBuffer(), { contentType: type, upsert: true },
      );
    } catch (e) {
      console.error('[social] thumbnail', v.videoId, e);
    }
  }));
}

export const thumbUrl = (videoId: string) =>
  `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/social-thumbs/${videoId.replace(':', '-')}.jpg`;

const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

// What the model watches. YouTube it can open by link. Anything else has to be
// handed over: pull a fresh download link (they expire, so a stored one is no
// use), pass the bytes to the Gemini Files API, which holds them for 48 hours
// at no charge. Nothing stays on our side.
export async function videoSource(videoId: string): Promise<{ fileUri: string; mimeType: string }> {
  if (platformOf(videoId) === 'youtube') {
    return { fileUri: `https://www.youtube.com/watch?v=${videoId}`, mimeType: 'video/mp4' };
  }
  const video = await fetchVideo(videoLink(videoId));
  if (!video?.downloadUrl) throw new Error('That video could not be opened.');
  const res = await fetch(video.downloadUrl);
  if (!res.ok) throw new Error(`Video download failed (${res.status})`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new Error('That video is too large to watch.');

  const key = Deno.env.get('GEMINI_API_KEY');
  const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: videoId.replace(':', '-') } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw new Error(`Gemini upload failed (${start.status})`);
  const done = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: bytes,
  });
  if (!done.ok) throw new Error(`Gemini upload failed (${done.status})`);
  const file = (await done.json()).file;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${key}`);
    const state = (await r.json()).state;
    if (state === 'ACTIVE') return { fileUri: file.uri, mimeType: 'video/mp4' };
    if (state === 'FAILED') throw new Error('Gemini could not read that video.');
    await new Promise(ok => setTimeout(ok, 1000));
  }
  throw new Error('Gemini took too long to read that video.');
}
