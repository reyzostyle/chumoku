// Ids from TikTok and Instagram carry their platform ("tiktok:7312...",
// "instagram:DAbc..."); anything else is a YouTube id. Their covers live in our
// own storage under a name built from the id, because the platforms' links expire.
const STORAGE = 'https://ezlousklksipvwuinpzq.supabase.co/storage/v1/object/public/social-thumbs';

export const isSocialId = (id: string) => id.startsWith('tiktok:') || id.startsWith('instagram:');

export const socialThumb = (id: string) => `${STORAGE}/${id.replace(':', '-')}.jpg`;

export function watchUrl(id: string): string {
  const [platform, native] = id.split(':');
  if (platform === 'tiktok') return `https://www.tiktok.com/@_/video/${native}`;
  if (platform === 'instagram') return `https://www.instagram.com/reel/${native}/`;
  return `https://www.youtube.com/watch?v=${id}`;
}

export const platformName = (id: string) =>
  id.startsWith('tiktok:') ? 'TikTok' : id.startsWith('instagram:') ? 'Instagram' : 'YouTube';

// A link to one TikTok or Reel, as a stored id. Short share links (vm.tiktok.com)
// hide the id, so those only work through Steal, which resolves them on the server.
export function socialIdFrom(s: string): string | null {
  const tt = s.match(/tiktok\.com\/@[\w.]+\/video\/(\d+)/i);
  if (tt) return `tiktok:${tt[1]}`;
  const ig = s.match(/instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/i);
  return ig ? `instagram:${ig[1]}` : null;
}
