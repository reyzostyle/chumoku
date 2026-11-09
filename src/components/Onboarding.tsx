import { useState, useEffect, useRef } from 'react';
import { FUNCTIONS_URL, getSessionToken, supabase } from '../lib/supabase';
import { callFunction } from '../lib/competitors';
import { useAuth } from '../contexts/AuthContext';
import { RefreshOutlineIcon as Loader2 } from '@solar-icons/react';
import { Youtube } from './BrandIcons';
import { requestBrain, CHANNEL_GOALS } from '../lib/brain';

// The first minutes after signing up.
//
// 2026-10-30 this was cut to one question, YouTube, because uploads answer
// level, niche and voice better than anyone describes them. 2026-11-09 (Ivan):
// uploads cannot say where you are heading, who you look up to or what you want
// from it, and the ideas showed it: months of old uploads kept pulling them back
// to a topic he had left. So: one screen for the things only the creator knows,
// then their Shorts land while the brain is read, then ideas.

const STORAGE_KEY = 'chumoku_onboarding';
const MAX_INSPIRATIONS = 3; // the free plan's tracked-channel limit

type Step = 'setup' | 'reading' | 'ready';
interface Draft { tiktok: string; instagram: string; links: string[]; goal: string; about: string }
const EMPTY: Draft = { tiktok: '', instagram: '', links: [], goal: '', about: '' };

// Survives the trip to Google's consent screen and back.
function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return d && typeof d === 'object' ? { ...EMPTY, ...d } : EMPTY;
  } catch { return EMPTY; }
}

const accent = 'var(--accent)';
const onAccent = 'var(--on-accent)';
const cardBase: React.CSSProperties = {
  background:
    'linear-gradient(rgba(255,255,255,0.04), rgba(255,255,255,0.04)), linear-gradient(180deg, rgba(var(--glass-tint-rgb),0.05), rgba(var(--glass-tint-rgb),0.03))',
  border: '1px solid rgba(255,255,255,0.08)',
};

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { user, signOut } = useAuth();
  const [step, setStep] = useState<Step>('setup');
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [link, setLink] = useState('');
  const [failed, setFailed] = useState<string[]>([]);
  const [ytChannel, setYtChannel] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch { /* private mode */ }
  }, [draft]);
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));

  // Back from Google's consent screen: the form is restored, YouTube ticked.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('youtube_connected') === 'true') {
      window.history.replaceState({}, '', '/');
    } else if (params.get('youtube_error')) {
      window.history.replaceState({}, '', '/');
      setError('YouTube did not connect. Try again, or go on without it.');
    }
  }, []);

  // Already connected (from Settings, or an earlier attempt): say so.
  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from('user_tokens')
      .select('youtube_channel_name, access_token')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.youtube_channel_name && data.access_token) setYtChannel(data.youtube_channel_name);
      });
  }, [user?.id]);

  const connectYouTube = () => {
    if (!user?.id) return;
    // Trimmed: the stored value carries a trailing newline (see lib/supabase.ts).
    const clientId = import.meta.env.VITE_YOUTUBE_CLIENT_ID?.trim();
    const redirectUri = `${FUNCTIONS_URL}/youtube-oauth-callback`;
    const scope = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&state=${user.id}`;
  };

  // build-brain saves the channel scan before the model starts writing, so
  // polling the scan shows their Shorts within a few seconds of starting.
  const loadThumbs = async () => {
    if (!user?.id) return;
    const { data } = await supabase.from('user_tokens').select('channel_scan').eq('user_id', user.id).maybeSingle();
    const ids = ((data?.channel_scan as { videos?: { id?: string }[] } | null)?.videos ?? [])
      .map(v => v.id).filter((id): id is string => !!id).slice(0, 9);
    setThumbs(prev => {
      const next = [...prev];
      for (const id of ids) {
        const url = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        if (!next.includes(url)) next.push(url);
      }
      return next;
    });
  };

  const addLink = () => {
    const v = link.trim();
    if (!v || draft.links.includes(v) || draft.links.length >= MAX_INSPIRATIONS) return;
    set({ links: [...draft.links, v] });
    setLink('');
  };

  const canStart = !!ytChannel || !!draft.tiktok.trim() || !!draft.instagram.trim() || !!draft.about.trim();

  const start = async () => {
    if (started.current || !user?.id || !canStart) return;
    setError('');
    const pendingLink = link.trim();
    const links = pendingLink && !draft.links.includes(pendingLink) ? [...draft.links, pendingLink].slice(0, MAX_INSPIRATIONS) : draft.links;
    const { error: err } = await supabase.from('user_tokens')
      .update({ channel_description: draft.about.trim() || null, channel_goal: draft.goal || null }).eq('user_id', user.id);
    if (err) { setError(`Could not save that (${err.message}). Try again.`); return; }

    started.current = true;
    setStep('reading');
    const poll = setInterval(loadThumbs, 1500);

    // Each one can fail on its own (a typo, a private account). None of them
    // should stand between someone and their first ideas.
    const token = await getSessionToken();
    const call = async (name: string, fn: string, body: object) => {
      try {
        const res = token ? await callFunction(fn, token, body) : null;
        if (!res?.ok) setFailed(f => [...f, name]);
      } catch { setFailed(f => [...f, name]); }
    };
    const { tiktok, instagram } = draft;
    await Promise.all([
      tiktok.trim() && call(tiktok.trim(), 'sync-social', { action: 'add', platform: 'tiktok', input: tiktok.trim() }),
      instagram.trim() && call(instagram.trim(), 'sync-social', { action: 'add', platform: 'instagram', input: instagram.trim() }),
      ...links.map(l => call(l, 'add-competitor-channel', { channelUrl: l })),
    ]);

    const result = await requestBrain(true).catch(() => null);
    clearInterval(poll);
    await loadThumbs();
    // Long enough to see their Shorts land when the build was quick.
    await new Promise(r => setTimeout(r, 1200));
    setSummary(result?.brain?.summary ?? null);
    setStep('ready');
  };

  const finish = async () => {
    if (!user?.id) return;
    setSaving(true);
    setError('');
    // A stale session makes every write fail with an opaque error; refresh
    // first so a long-idle tab can still finish onboarding.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) await supabase.auth.refreshSession();
    const { data: existing, error: selErr } = await supabase
      .from('user_tokens').select('user_id').eq('user_id', user.id).maybeSingle();
    const { error: err } = selErr
      ? { error: selErr }
      : existing
      ? await supabase.from('user_tokens').update({ onboarding_completed: true }).eq('user_id', user.id)
      : await supabase.from('user_tokens').insert({ user_id: user.id, access_token: '', refresh_token: '', onboarding_completed: true });
    setSaving(false);
    if (err) { setError(`Could not save (${err.message}). Try again, or sign out below and log back in.`); return; }
    localStorage.removeItem(STORAGE_KEY);
    onDone();
  };

  const field = 'w-full px-4 py-3 rounded-xl text-white text-sm focus:outline-none';
  const label = 'text-[13px] font-medium mb-2.5';
  const primary = 'w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-40';

  return (
    <div className="min-h-screen flex flex-col items-center sm:justify-center px-4 py-10" style={{ background: 'rgb(var(--surface-rgb))' }}>
      <div className="w-full max-w-md">

        {step === 'setup' && (
          <div className="space-y-7">
            <h1 className="text-2xl font-bold text-white text-balance">Set up your ideas</h1>

            <div>
              <p className={label} style={{ color: 'var(--text-muted)' }}>Your accounts</p>
              <div className="space-y-2">
                <button onClick={ytChannel ? undefined : connectYouTube} disabled={!!ytChannel}
                  className={`${field} flex items-center gap-2.5 text-left`} style={cardBase}>
                  <Youtube className="w-4 h-4 flex-shrink-0" />
                  <span className="flex-1 truncate">{ytChannel ?? 'YouTube'}</span>
                  <span style={{ color: ytChannel ? 'var(--text-faint)' : 'var(--text)' }}>{ytChannel ? 'Connected' : 'Connect'}</span>
                </button>
                <input value={draft.tiktok} onChange={e => set({ tiktok: e.target.value })} placeholder="TikTok @name"
                  autoCapitalize="none" autoCorrect="off" className={field} style={cardBase} />
                <input value={draft.instagram} onChange={e => set({ instagram: e.target.value })} placeholder="Instagram @name"
                  autoCapitalize="none" autoCorrect="off" className={field} style={cardBase} />
              </div>
            </div>

            <div>
              <p className={label} style={{ color: 'var(--text-muted)' }}>Who you look up to</p>
              {draft.links.length < MAX_INSPIRATIONS && (
                <div className="flex gap-2">
                  <input value={link} onChange={e => setLink(e.target.value)} placeholder="Link to a channel or profile"
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}
                    autoCapitalize="none" autoCorrect="off" className={`${field} flex-1 min-w-0`} style={cardBase} />
                  <button onClick={addLink} disabled={!link.trim()} className="px-4 rounded-xl text-sm font-medium text-white disabled:opacity-40" style={cardBase}>Add</button>
                </div>
              )}
              {draft.links.length > 0 && (
                <div className={`flex flex-wrap gap-2 ${draft.links.length < MAX_INSPIRATIONS ? 'mt-2' : ''}`}>
                  {draft.links.map(l => (
                    <button key={l} className="chip max-w-full truncate" data-on="true" aria-label={`Remove ${l}`}
                      onClick={() => set({ links: draft.links.filter(x => x !== l) })}>
                      {l.replace(/^https?:\/\/(www\.)?/, '')} ×
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className={label} style={{ color: 'var(--text-muted)' }}>What you want</p>
              <div className="flex flex-wrap gap-2">
                {CHANNEL_GOALS.map(g => (
                  <button key={g.value} className="chip" data-on={draft.goal === g.value} onClick={() => set({ goal: draft.goal === g.value ? '' : g.value })}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className={label} style={{ color: 'var(--text-muted)' }}>What your channel is about</p>
              <textarea value={draft.about} onChange={e => set({ about: e.target.value })}
                placeholder="What you make now, in your own words" rows={3}
                className={`${field} resize-none leading-relaxed`} style={cardBase} />
            </div>

            <button onClick={start} disabled={!canStart} className={primary} style={{ background: accent, color: onAccent }}>
              Continue
            </button>
          </div>
        )}

        {step === 'reading' && (
          <div>
            <h1 className="text-2xl font-bold text-white mb-2 text-balance">Reading your channel</h1>
            <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>
              {thumbs.length ? 'Working out what works for you…' : 'Looking at your Shorts…'}
            </p>
            <div className="grid grid-cols-3 gap-2 mt-7">
              {thumbs.map(src => (
                <div key={src} className="aspect-[9/16] rounded-xl overflow-hidden animate-fade-in" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <img src={src} alt="" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 'ready' && (
          <div>
            <h1 className="text-2xl font-bold text-white mb-5 text-balance">Got it</h1>
            {failed.length > 0 && (
              <p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                Could not add {failed.join(', ')}. You can try again in Settings.
              </p>
            )}
            {summary && (
              <>
                <div className="rounded-2xl px-5 py-4 text-sm leading-relaxed text-white" style={cardBase}>{summary}</div>
                <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                  Every idea and script is written against this. Change it any time in Settings.
                </p>
              </>
            )}
            <button onClick={finish} disabled={saving} className={`${primary} mt-8`} style={{ background: accent, color: onAccent }}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} See today&apos;s ideas
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 text-center">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => { localStorage.removeItem(STORAGE_KEY); signOut(); }}
              className="mt-2 text-xs text-gray-500 hover:text-gray-300 underline decoration-gray-700 underline-offset-2 transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
