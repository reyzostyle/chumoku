import { useState, useCallback } from 'react';
import { isSocialId, socialThumb } from '../lib/videoLinks';

// A Short's cover at a resolution that survives the crop.
//
// Every card used hqdefault: a 480x360 letterbox whose real picture is a strip
// about 200px wide, blown up to fill a 4:5 card - soft on any retina screen.
// maxresdefault is the same letterbox at 1280x720, so the strip is 405px, and
// YouTube serves it as WebP at roughly 30-50 KB against hqdefault's 15-20 KB.
// Same CDN, no API quota, no cost: twice the bytes for twice the pixels, and
// cards below the fold still wait for `loading="lazy"`.
//
// Not every video has a maxres frame. YouTube answers a missing one with a
// 120x90 grey placeholder - sometimes as a 404 (onError), sometimes not - so
// both paths fall back to hqdefault, which always exists.
//
// oar2.jpg was measured too: a true 9:16 frame, but 80-190 KB, absent on some
// Shorts and landscape on others. Not worth it for a grid.
const maxres = (id: string) => `https://i.ytimg.com/vi_webp/${id}/maxresdefault.webp`;
const hq = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export function ShortThumb({ videoId, src: given, eager }: {
  videoId: string;
  // A pre-cropped 4:5 image (the landing's), used as-is.
  src?: string;
  eager?: boolean;
}) {
  // A TikTok or Reel cover is already a full vertical frame, used as-is.
  const src = given ?? (isSocialId(videoId) ? socialThumb(videoId) : undefined);
  const [fallback, setFallback] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = src ?? (fallback ? hq(videoId) : maxres(videoId));

  const settle = useCallback((img: HTMLImageElement) => {
    if (!src && !fallback && img.naturalWidth > 0 && img.naturalWidth <= 120) {
      setFallback(true);
      return;
    }
    setLoaded(true);
  }, [src, fallback]);

  return (
    <img
      key={url}
      // A cached image (or one the prerendered landing loaded before React
      // arrived) has already fired its load event, so check on mount too.
      ref={img => { if (img?.complete && img.naturalWidth > 0 && !loaded) settle(img); }}
      src={url}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      data-exact={src ? 'true' : undefined}
      data-loaded={loaded ? 'true' : undefined}
      onLoad={e => settle(e.currentTarget)}
      onError={() => { if (!src && !fallback) setFallback(true); else setLoaded(true); }}
    />
  );
}
