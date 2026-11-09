import { useState, useEffect, useRef } from 'react';
import { FUNCTIONS_URL, getSessionToken, supabase } from '../lib/supabase';
import { callFunction } from '../lib/competitors';
import { useAuth } from '../contexts/AuthContext';
import { RefreshOutlineIcon as Loader2, AltArrowLeftOutlineIcon as Back, CloseCircleOutlineIcon as Remove } from '@solar-icons/react';
import { Youtube, TikTok, Instagram, Check } from './BrandIcons';
import { Button, Row } from './Page';
import { requestBrain, CHANNEL_GOALS } from '../lib/brain';

// The first minutes after signing up.
//
// 2026-10-30 this was cut to one question, YouTube, because uploads answer
// level, niche and voice better than anyone describes them. 2026-11-09 (Ivan):
// uploads cannot say where you are heading, who you look up to or what you want
// from it, and the ideas showed it: months of old uploads kept pulling them back
// to a topic he had left. So four short pages for the things only the creator
// knows, built like the rest of the app (the iOS onboarding's layout: title at
// the top, the one action at the bottom, plates and rows between), then their
// Shorts land while the brain is read, then ideas.

const STORAGE_KEY = 'chumoku_onboarding';
const MAX_INSPIRATIONS = 3; // the free plan's tracked-channel limit

type Step = 'accounts' | 'inspirations' | 'goal' | 'about' | 'reading' | 'ready';
const PAGES: Step[] = ['accounts', 'inspirations', 'goal', 'about'];
interface Draft { tiktok: string; instagram: string; links: string[]; goal: string; about: string }
const EMPTY: Draft = { tiktok: '', instagram: '', links: [], goal: '', about: '' };

// Survives the trip to Google's consent screen and back.
function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return d && typeof d === 'object' ? { ...EMPTY, ...d } : EMPTY;
  } catch { return EMPTY; }
}

const rowInput = 'flex-1 min-w-0 bg-transparent text-[16px] focus:outline-none placeholder:text-[var(--text-faint)]';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { user, signOut } = useAuth();
  const [step, setStep] = useState<Step>('accounts');
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

  const page = PAGES.indexOf(step);
  const go = (to: Step) => { setError(''); setStep(to); };
  const hasAccount = !!ytChannel || !!draft.tiktok.trim() || !!draft.instagram.trim();

  return (
    <div className="min-h-[100dvh] flex justify-center px-6" style={{ background: 'var(--bg-app)' }}>
      <div key={step} className="animate-tab-in w-full max-w-md min-h-[100dvh] flex flex-col pb-6 sm:pb-12">

        <div className="h-11 mt-4 sm:mt-12 flex items-center justify-between flex-shrink-0">
          {page > 0 ? (
            <button onClick={() => go(PAGES[page - 1])} aria-label="Back" className="h-11 w-11 -ml-2 flex items-center" style={{ color: 'var(--text)' }}>
              <Back className="w-5 h-5" />
            </button>
          ) : <img src="/chumoku-mark.png" alt="" className="h-6 w-auto" />}
          {page >= 0 && <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>{page + 1} of {PAGES.length}</span>}
        </div>

        {step === 'accounts' && (
          <>
            <h1 className="t-title text-balance mt-7 mb-7" style={{ color: 'var(--text)' }}>Your accounts</h1>
            <div className="space-y-2">
              <Row
                icon={<Youtube className="w-[18px] h-[18px]" />}
                title={ytChannel ?? 'YouTube'}
                meta={ytChannel ? <Check className="w-4 h-4" /> : undefined}
                arrow={ytChannel ? undefined : <span className="text-[13px] font-medium" style={{ color: 'var(--text)' }}>Connect</span>}
                onClick={ytChannel ? undefined : connectYouTube}
              />
              <label className="row cursor-text">
                <span className="row-icon"><TikTok className="w-[17px] h-[17px]" /></span>
                <input value={draft.tiktok} onChange={e => set({ tiktok: e.target.value })} placeholder="TikTok username" aria-label="TikTok username"
                  autoCapitalize="none" autoCorrect="off" className={rowInput} style={{ color: 'var(--text)' }} />
              </label>
              <label className="row cursor-text">
                <span className="row-icon"><Instagram className="w-[18px] h-[18px]" /></span>
                <input value={draft.instagram} onChange={e => set({ instagram: e.target.value })} placeholder="Instagram username" aria-label="Instagram username"
                  autoCapitalize="none" autoCorrect="off" className={rowInput} style={{ color: 'var(--text)' }} />
              </label>
            </div>
            {error && <p className="mt-3 t-small" style={{ color: 'var(--danger)' }}>{error}</p>}
            <div className="mt-auto pt-8">
              <Button variant="primary" className="w-full" disabled={!hasAccount} onClick={() => go('inspirations')}>Continue</Button>
              <Button variant="text" className="w-full mt-2" onClick={() => go('inspirations')}>I don&apos;t have a channel yet</Button>
            </div>
          </>
        )}

        {step === 'inspirations' && (
          <>
            <h1 className="t-title text-balance mt-7 mb-7" style={{ color: 'var(--text)' }}>Who do you look up to?</h1>
            <div className="space-y-2">
              {draft.links.map(l => (
                <div key={l} className="row">
                  <span className="flex-1 min-w-0 truncate text-[15px] font-medium" style={{ color: 'var(--text)' }}>{l.replace(/^https?:\/\/(www\.)?/, '')}</span>
                  <button aria-label={`Remove ${l}`} onClick={() => set({ links: draft.links.filter(x => x !== l) })} style={{ color: 'var(--text-faint)' }}>
                    <Remove className="w-5 h-5" />
                  </button>
                </div>
              ))}
              {draft.links.length < MAX_INSPIRATIONS && (
                <form className="row" onSubmit={e => { e.preventDefault(); addLink(); }}>
                  <input value={link} onChange={e => setLink(e.target.value)} placeholder="Link to their channel" aria-label="Link to their channel"
                    autoCapitalize="none" autoCorrect="off" className={rowInput} style={{ color: 'var(--text)' }} />
                  {link.trim() && <button type="submit" className="text-[13px] font-medium" style={{ color: 'var(--text)' }}>Add</button>}
                </form>
              )}
            </div>
            <div className="mt-auto pt-8">
              <Button variant="primary" className="w-full" disabled={!draft.links.length && !link.trim()} onClick={() => { addLink(); go('goal'); }}>Continue</Button>
              <Button variant="text" className="w-full mt-2" onClick={() => go('goal')}>Skip</Button>
            </div>
          </>
        )}

        {step === 'goal' && (
          <>
            <h1 className="t-title text-balance mt-7 mb-7" style={{ color: 'var(--text)' }}>What do you want?</h1>
            <div className="space-y-2">
              {CHANNEL_GOALS.map(g => (
                <Row key={g.value} title={g.label}
                  meta={draft.goal === g.value ? <Check className="w-4 h-4" /> : undefined}
                  onClick={() => { set({ goal: g.value }); go('about'); }} />
              ))}
            </div>
          </>
        )}

        {step === 'about' && (
          <>
            <h1 className="t-title text-balance mt-7 mb-7" style={{ color: 'var(--text)' }}>What is your channel about?</h1>
            <textarea value={draft.about} onChange={e => set({ about: e.target.value })} rows={5} autoFocus
              placeholder="In your own words" aria-label="What your channel is about"
              className="w-full p-4 text-[16px] leading-relaxed resize-none focus:outline-none focus:border-[var(--line-strong)] placeholder:text-[var(--text-faint)]"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', color: 'var(--text)' }} />
            {error && <p className="mt-3 t-small" style={{ color: 'var(--danger)' }}>{error}</p>}
            <div className="mt-auto pt-8">
              <Button variant="primary" className="w-full" disabled={!canStart} onClick={start}>Continue</Button>
            </div>
          </>
        )}

        {step === 'reading' && (
          <>
            <h1 className="t-title mt-7" style={{ color: 'var(--text)' }}>Reading your channel</h1>
            <p className="mt-2 text-[15px] animate-pulse" style={{ color: 'var(--text-muted)' }}>
              {thumbs.length ? 'Working out what works for you' : 'Looking at your Shorts'}
            </p>
            <div className="grid grid-cols-3 gap-2 mt-7">
              {thumbs.map(src => (
                <div key={src} className="aspect-[9/16] rounded-xl overflow-hidden animate-fade-in" style={{ background: 'var(--bg-raised)' }}>
                  <img src={src} alt="" className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          </>
        )}

        {step === 'ready' && (
          <>
            <h1 className="t-title text-balance mt-7 mb-7" style={{ color: 'var(--text)' }}>Got it</h1>
            {summary && (
              <div className="p-4 text-[15px] leading-relaxed" style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', color: 'var(--text)' }}>
                {summary}
              </div>
            )}
            {failed.length > 0 && (
              <p className="mt-3 t-small" style={{ color: 'var(--text-muted)' }}>Could not add {failed.join(', ')}</p>
            )}
            {error && (
              <div className="mt-3">
                <p className="t-small" style={{ color: 'var(--danger)' }}>{error}</p>
                <Button variant="text" className="mt-1" onClick={() => { localStorage.removeItem(STORAGE_KEY); signOut(); }}>Sign out</Button>
              </div>
            )}
            <div className="mt-auto pt-8">
              <Button variant="primary" className="w-full" disabled={saving} onClick={finish}>
                {saving && <Loader2 className="w-4 h-4 animate-spin" />} See today&apos;s ideas
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
