import { useCallback, useEffect, useState } from 'react';
import { supabase, getSessionToken, getUserId } from '../lib/supabase';
import { callFunction, formatViews } from '../lib/competitors';
import { Button } from './Page';

// The creator's own TikTok and Instagram, by handle. Public view counts are all
// this reads, so there is no login: they feed the brain, and through it every
// idea and script, with what worked for this person and what did not.
type Platform = 'tiktok' | 'instagram';
interface Account { platform: Platform; handle: string; name: string | null }
interface Video { video_id: string; platform: Platform; title: string | null; views: number | null; url: string | null }

const PLATFORMS: { id: Platform; label: string; hint: string }[] = [
  { id: 'tiktok', label: 'TikTok', hint: 'tiktok.com/@name' },
  { id: 'instagram', label: 'Instagram', hint: 'instagram.com/name' },
];

function Row({ p, account, videos, onChange }: {
  p: typeof PLATFORMS[number]; account?: Account; videos: Video[]; onChange: () => Promise<void>;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (body: Record<string, string>) => {
    setBusy(true);
    setError('');
    try {
      const token = await getSessionToken();
      if (!token) throw new Error('Not authenticated');
      const res = await callFunction('sync-social', token, body);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      setInput('');
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  if (account) {
    const top = [...videos].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 3);
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm" style={{ color: 'var(--text)' }}>{p.label} · @{account.handle}</p>
          <Button variant="text" className="t-small" disabled={busy}
            onClick={() => send({ action: 'remove', platform: p.id })}>
            {busy ? 'Removing' : 'Remove'}
          </Button>
        </div>
        {top.map(v => (
          <a key={v.video_id} href={v.url ?? undefined} target="_blank" rel="noopener noreferrer"
             className="flex justify-between gap-3 text-sm transition-colors hover:text-[var(--text)]"
             style={{ color: 'var(--text-muted)' }}>
            <span className="truncate">{v.title?.replace(/#\S+/g, '').trim() || 'Untitled'}</span>
            <span className="tabular-nums shrink-0">{formatViews(v.views ?? 0)}</span>
          </a>
        ))}
        {error && <p className="t-small" style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>
    );
  }

  return (
    <form className="space-y-2" onSubmit={e => {
      e.preventDefault();
      if (input.trim() && !busy) send({ action: 'add', platform: p.id, input: input.trim() });
    }}>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={p.hint}
          aria-label={`Your ${p.label}`}
          disabled={busy}
          className="flex-1 min-w-0 px-3 py-2.5 rounded-[var(--r-sm)] text-sm focus:outline-none disabled:opacity-50"
          style={{ background: 'var(--bg-app)', border: '1px solid var(--line)', color: 'var(--text)' }}
        />
        <Button variant="secondary" size="sm" type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Reading' : 'Add'}
        </Button>
      </div>
      {error && <p className="t-small" style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  );
}

export function SocialProfiles() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);

  const load = useCallback(async () => {
    const userId = await getUserId();
    if (!userId) return;
    const [{ data: a }, { data: v }] = await Promise.all([
      supabase.from('social_accounts').select('platform, handle, name').eq('user_id', userId),
      supabase.from('social_videos').select('video_id, platform, title, views, url').eq('user_id', userId)
        .order('views', { ascending: false }).limit(60),
    ]);
    setAccounts((a ?? []) as Account[]);
    setVideos((v ?? []) as Video[]);
  }, []);

  useEffect(() => { load().catch(e => console.error('[SocialProfiles] load error:', e)); }, [load]);

  return (
    <div className="space-y-5">
      {PLATFORMS.map(p => (
        <Row key={p.id} p={p} account={accounts.find(a => a.platform === p.id)}
             videos={videos.filter(v => v.platform === p.id)} onChange={load} />
      ))}
    </div>
  );
}
