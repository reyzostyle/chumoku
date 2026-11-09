import { useState, useEffect } from 'react';
import { FUNCTIONS_URL, supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { RefreshOutlineIcon as Loader2, EyeOutlineIcon as Eye, EyeClosedOutlineIcon as EyeOff, RefreshOutlineIcon as RefreshCw, LinkOutlineIcon as Link, AltArrowDownOutlineIcon as ChevronDown, SquareArrowRightUpOutlineIcon as ExternalLink, ArrowRightUpOutlineIcon as ArrowUpRight, LockKeyholeMinimalisticOutlineIcon as Lock, ChatRoundOutlineIcon as MessageCircle, CheckCircleBoldIcon as CheckCircle } from '@solar-icons/react';
import { getSessionToken, fetchWithRetry } from '../lib/supabase';

import { requestBrain, CHANNEL_GOALS, type ChannelBrain, type BrainOverrides } from '../lib/brain';
import { syncOwnVideos } from '../lib/ownVideos';
import { displayNameOf } from '../lib/user';
import { Page, PageHead, Loading, Tile, Button, Collapse, Skeleton } from './Page';
import { formatViews } from '../lib/competitors';
import { useUsage } from '../lib/useUsage';
import { startTopup, CREDIT_PACK } from './CreditsPanel';
import { ChannelsSettings } from './ChannelsSettings';
import { SocialProfiles } from './SocialProfiles';
import { RetentionLessons } from './RetentionLessons';

function YouTubeLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}

const glassInput: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
};

// Label for a field inside a card. Sentence case like every other label in
// the product since the X Money pass; the uppercase tracked version was the
// last one left.
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block t-label mb-2" style={{ color: 'var(--text-muted)' }}>{children}</label>;
}

const CREATOR_LEVELS = [
  { value: 'beginner', label: 'Beginner', hint: 'New to Shorts, learning fundamentals' },
  { value: 'intermediate', label: 'Intermediate', hint: 'Know the basics, working on execution' },
  { value: 'advanced', label: 'Advanced', hint: 'Experienced creator, want nuance' },
];

// This field doubles as the future home for Discord voucher/perk codes.
// The one special case today is the hidden admin dashboard — gated on the
// account's own email, not on knowing this string (see admin-stats function).
const ADMIN_EMAIL = 'reyzostyle@gmail.com';
const ADMIN_CODE = 'ADMIN';
// The affiliate tab is now identical for every account, admin included, so the
// partner-management list needs its own door. Same mechanism as ADMIN: the code
// is a shortcut, not the security - the endpoint behind it checks the email.
const PARTNERS_CODE = 'PARTNERS';
const PLAN_CACHE_KEY = 'chumoku_last_plan';

export function SettingsPage() {
  const { user, signOut } = useAuth();

  // Accordion: name of the single expanded card, or null when all collapsed.
  // Opens on Credits when something sent the user here for their balance
  // (the old Usage tab, the chat's "Get more"), and on YouTube or the brain
  // from the hub.
  const [openCard, setOpenCard] = useState<string | null>(() => {
    // The hub's setup row asks for YouTube or the brain the same way.
    try {
      const asked = localStorage.getItem('chumoku_open_settings');
      if (asked && ['credits', 'youtube', 'brain'].includes(asked)) return asked;
    } catch { /* storage blocked: open nothing */ }
    return null;
  });
  // Consumed after mount, not inside the initializer: an initializer must be
  // pure (StrictMode runs it twice, and the second run found the key gone).
  useEffect(() => {
    try { localStorage.removeItem('chumoku_open_settings'); } catch { /* ignore */ }
  }, []);
  const { usage, loading: usageLoading } = useUsage();
  const cardProps = (name: string) => ({
    open: openCard === name,
    onToggle: () => setOpenCard(c => (c === name ? null : name)),
  });

  // YouTube + plan state
  const [youtubeStatus, setYoutubeStatus] = useState<{
    connected: boolean;
    updatedAt?: string;
    channelName?: string;
    channelThumbnail?: string;
  } | null>(null);
  // Seeded from the last known plan so the Subscription card is on screen from
  // the first paint rather than dropping in once the request lands and pushing
  // the page around. The fetch below corrects it either way.
  const [plan, setPlan] = useState<string | null>(() => {
    try { return localStorage.getItem(PLAN_CACHE_KEY); } catch { return null; }
  });
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Channel context state. Niche and audience are no longer typed by anyone -
  // the brain derives them and writes them back to the same columns, which is
  // what keeps competitor search working for accounts that never filled them
  // in. See supabase/functions/_shared/brain.ts.
  const [channelDescription, setChannelDescription] = useState('');
  const [creatorLevel, setCreatorLevel] = useState('intermediate');

  // The brain
  const [brain, setBrain] = useState<ChannelBrain | null>(null);
  const [brainAt, setBrainAt] = useState<string | null>(null);
  const [brainBuilding, setBrainBuilding] = useState(false);
  const [brainError, setBrainError] = useState('');
  // The creator's own edits, kept apart from the read so the weekly rebuild
  // never overwrites them; and the voice heard in their Shorts, which is what
  // the Voice line shows when there is one.
  const [brainOverrides, setBrainOverrides] = useState<BrainOverrides>({});
  const [channelGoal, setChannelGoal] = useState('');
  const [heardVoice, setHeardVoice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [contextSaving, setContextSaving] = useState(false);
  const [contextError, setContextError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);

  // Display name. Lives on the auth user rather than in a column of our own:
  // Google already puts a real name there at sign-in, so most accounts have one
  // without ever opening this field, and no migration was needed to read it.
  const [displayName, setDisplayName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupError, setTopupError] = useState('');
  // The language ideas and scripts come back in (user_tokens.language).
  const [language, setLanguage] = useState('en');
  // Where the plan is billed and when the month's credits come back.
  const [billing, setBilling] = useState<{ resetAt: string | null; store: 'stripe' | 'apple' | null; yearly: boolean }>({ resetAt: null, store: null, yearly: false });
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState('');

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState('');

  // Subscription state
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelDone, setCancelDone] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Redeem code state
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  const redeem = async () => {
    const code = redeemCode.trim();
    if (!code) return;
    if (user?.email === ADMIN_EMAIL && code.toUpperCase() === ADMIN_CODE) {
      setRedeemMsg(null);
      setRedeemCode('');
      window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: 'admin' }));
      return;
    }
    if (user?.email === ADMIN_EMAIL && code.toUpperCase() === PARTNERS_CODE) {
      setRedeemMsg(null);
      setRedeemCode('');
      window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: 'affiliate-admin' }));
      return;
    }
    setRedeeming(true);
    setRedeemMsg(null);
    try {
      const token = await getSessionToken();
      const res = await fetchWithRetry(`${FUNCTIONS_URL}/redeem-code`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid or expired code.');
      setRedeemMsg({ type: 'success', text: data.message || 'Code redeemed!' });
      setRedeemCode('');
    } catch (e) {
      setRedeemMsg({ type: 'error', text: e instanceof Error ? e.message : 'Invalid or expired code.' });
    } finally {
      setRedeeming(false);
    }
  };

  // One row, one request. This used to be two queries against the same row,
  // which meant the cards filled in at two different moments and the
  // Subscription card (gated on `plan`) could land noticeably after the rest.
  // The context columns were split off as a guard against their not existing;
  // they have been guaranteed by migrations for a while now.
  useEffect(() => {
    setDisplayName(displayNameOf(user));
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    // The channel's numbers are asked for in the same breath as the row
    // rather than when the YouTube card is opened. They used to start loading
    // only once the card was open, so the tiles dropped in a second after
    // everything else and pushed the card's own buttons down.
    const stats = loadChannelStats(user.id);

    (async () => {
      try {
        const [{ data, error }] = await Promise.all([
          supabase
            .from('user_tokens')
            .select('updated_at, channel_goal, access_token, plan, youtube_channel_name, youtube_channel_thumbnail, channel_description, creator_level, brain, brain_at, brain_overrides, voice, language, credits_reset_at, stripe_subscription_id, apple_product_id, apple_expires_at')
            .eq('user_id', user.id)
            .maybeSingle(),
          // Waited on, but not forever: it goes out to YouTube, and a slow
          // YouTube should not hold the whole page behind a skeleton. Past the
          // cap the tiles fill in on their own.
          Promise.race([stats, new Promise(r => setTimeout(r, STATS_WAIT_MS))]),
        ]);
        if (cancelled) return;
        // A failed read leaves every field at its empty default, and Save
        // would then write those empties over a profile that is perfectly
        // fine. Say so and refuse to save instead.
        if (error) setLoadFailed(true);

        setYoutubeStatus(data?.access_token
          ? {
              connected: true,
              updatedAt: data.updated_at,
              channelName: data.youtube_channel_name,
              channelThumbnail: data.youtube_channel_thumbnail,
            }
          : { connected: false });
        const nextPlan = data?.plan || 'free';
        setPlan(nextPlan);
        try { localStorage.setItem(PLAN_CACHE_KEY, nextPlan); } catch { /* private mode */ }
        setChannelDescription(data?.channel_description || '');
        setCreatorLevel(data?.creator_level || 'intermediate');
        setLanguage(data?.language || 'en');
        setBilling({
          resetAt: data?.credits_reset_at ?? null,
          store: data?.apple_product_id && data?.apple_expires_at && new Date(data.apple_expires_at) > new Date() ? 'apple' : data?.stripe_subscription_id ? 'stripe' : null,
          yearly: !!data?.apple_product_id?.endsWith('yearly'),
        });
        setBrain((data?.brain as ChannelBrain) ?? null);
        setBrainAt(data?.brain_at ?? null);
        setBrainOverrides((data?.brain_overrides as BrainOverrides) ?? {});
        setChannelGoal((data as { channel_goal?: string | null } | null)?.channel_goal ?? '');
        setHeardVoice((data?.voice as { how_they_talk?: string } | null)?.how_they_talk ?? null);
      } catch {
        if (!cancelled) {
          setYoutubeStatus({ connected: false });
          setPlan('free');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user?.id]);

  const connectYouTube = () => {
    if (!user?.id) return;
    // Trimmed: the stored value carries a trailing newline (see lib/supabase.ts).
    const clientId = import.meta.env.VITE_YOUTUBE_CLIENT_ID?.trim();
    const redirectUri = `${FUNCTIONS_URL}/youtube-oauth-callback`;
    const scope = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&state=${user.id}`;
  };

  // Fully disconnect: clear the stored tokens + channel so the app forgets the
  // connection. (Users can also revoke at myaccount.google.com/permissions.)
  const disconnectYouTube = async () => {
    if (!user?.id) return;
    setDisconnecting(true);
    const { error } = await supabase
      .from('user_tokens')
      .update({
        access_token: '',
        refresh_token: '',
        youtube_channel_name: null,
        youtube_channel_thumbnail: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id);
    setDisconnecting(false);
    if (!error) {
      setYoutubeStatus({ connected: false });
      setConfirmDisconnect(false);
    }
  };

  // One button, two things: the two fields go to the row, and the brain is
  // rebuilt off them. Saving a profile and then having to notice a second
  // control that makes the profile count would be a trap - the whole point of
  // cutting this screen down to two fields is that there is nothing left to
  // get wrong.
  const saveContext = async () => {
    setContextSaving(true);
    setContextError('');
    const { data: existing } = await supabase
      .from('user_tokens')
      .select('user_id')
      .eq('user_id', user?.id)
      .maybeSingle();
    const patch = { channel_description: channelDescription, creator_level: creatorLevel, channel_goal: channelGoal || null };
    let err;
    if (existing) {
      ({ error: err } = await supabase
        .from('user_tokens')
        .update(patch)
        .eq('user_id', user?.id));
    } else {
      ({ error: err } = await supabase
        .from('user_tokens')
        .insert({ user_id: user?.id, ...patch, access_token: '', refresh_token: '' }));
    }
    setContextSaving(false);
    if (err) {
      setContextError('Failed to save: ' + err.message);
      return;
    }
    buildBrain(true);
  };

  // `force` skips build-brain's one-minute cooldown. It exists for the moments
  // where the input genuinely just changed - finishing onboarding, saving the
  // sentence about yourself - and every caller was passing it, including the
  // Rebuild button. That made the cooldown unreachable code and the button an
  // unlimited way to spend a model call per press, for free. The button asks
  // without it now, so pressing it twice reads the channel once.
  // The other moment worth syncing: this is where a channel gets connected, so
  // a just-connected account has an empty `videos` table until something asks.
  // syncOwnVideos throttles itself and no-ops when nothing is connected.
  useEffect(() => { syncOwnVideos(); }, []);

  const buildBrain = async (force: boolean) => {
    setBrainBuilding(true);
    setBrainError('');
    const result = await requestBrain(force);
    setBrainBuilding(false);
    if (result.error) { setBrainError(result.error); return; }
    if (result.cached) {
      setBrainError('Rebuilt less than a minute ago. Give it a moment.');
      return;
    }
    if (result.brain) {
      setBrain(result.brain);
      setBrainAt(new Date().toISOString());
    } else if (result.reason === 'nothing_to_read') {
      setBrainError('Nothing to read yet. Say a line about yourself above, or connect your channel.');
    }
  };

  const saveDisplayName = async () => {
    setNameSaving(true);
    setNameError('');
    const { error: err } = await supabase.auth.updateUser({ data: { display_name: displayName.trim() } });
    setNameSaving(false);
    if (err) { setNameError(err.message); return; }
    setEditingName(false);
  };

  const changePassword = async () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword.length < 6) { setPwError('New password must be at least 6 characters'); return; }
    setPwSaving(true);
    setPwError('');
    // Re-authenticating needs an address to re-authenticate. There is always
    // one on a signed-in account, but the session type does not promise it,
    // and a password change is the wrong place to send `undefined` and find
    // out what the API makes of it.
    if (!user?.email) { setPwSaving(false); setPwError('Could not confirm your account'); return; }
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
    if (signInErr) { setPwSaving(false); setPwError('Current password is incorrect'); return; }
    const { error: err } = await supabase.auth.updateUser({ password: newPassword });
    setPwSaving(false);
    if (err) {
      setPwError(err.message);
    } else {
      setPwSaved(true);
      setCurrentPassword('');
      setNewPassword('');
      setTimeout(() => setPwSaved(false), 2500);
    }
  };

  const cancelSubscription = async () => {
    setCancelLoading(true);
    setCancelError('');
    try {
      const token = await getSessionToken();
      const res = await fetchWithRetry(`${FUNCTIONS_URL}/cancel-subscription`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel');
      setCancelDone(true);
      setConfirmCancel(false);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : 'Failed to cancel');
    } finally {
      setCancelLoading(false);
    }
  };

  // Laid out like the iOS app's Settings (2026-10-30, Ivan liked it there):
  // the plan and the balance always on top, then sections that say in their
  // header what is inside, one open at a time. The whole list waits for the
  // one query behind it and arrives at once.
  const isFree = (plan ?? 'free') === 'free';
  const left = usage ? Math.max(0, usage.creditsLimit - usage.creditsUsed) : 0;
  const planName = plan === 'agency' ? 'Pro' : plan === 'pro' ? 'Plus' : 'Trial';
  const go = (tab: string) => window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: tab }));

  return (
    <Page className="animate-tab-in">
      <PageHead title="Settings" />

      {loading || usageLoading ? <Loading rows={8} /> : (
      <div className="space-y-2.5 animate-fade-in">

      {/* ── Plan and balance ── */}
      <div className="row-group" style={{ padding: 20 }}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--text)' }}>{planName}</p>
          <p className="text-[13px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {usage && usage.creditsLimit > 0 ? `${left} of ${usage.creditsLimit} credits left` : 'Daily ideas only'}
          </p>
        </div>
        {usage && usage.creditsLimit > 0 && (
          <div className="mt-3 w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
            <div className="h-full rounded-full transition-all duration-500"
                 style={{ width: `${(left / Math.max(1, usage.creditsLimit)) * 100}%`, background: 'var(--text)' }} />
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {isFree ? (
            <Button variant="primary" onClick={() => go('upgrade')} className="w-full sm:w-auto">Upgrade</Button>
          ) : (
            <>
              <Button variant="secondary" disabled={topupBusy} onClick={async () => {
                setTopupBusy(true); setTopupError('');
                try { await startTopup(); } catch (e) { setTopupError(e instanceof Error ? e.message : 'Failed to start checkout'); setTopupBusy(false); }
              }}>
                {topupBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {CREDIT_PACK.credits} more credits · {CREDIT_PACK.price}
              </Button>
              <Button variant="ghost" onClick={() => go('upgrade')}>Change plan</Button>
            </>
          )}
        </div>
        {topupError && <p className="mt-2 text-red-400 text-sm">{topupError}</p>}
      </div>

      {/* ── Account ── */}
      <Fold {...cardProps('account')} title="Account" value={user?.email}>
        <div className="space-y-5">
          {/* Editable things say Edit; the email, which cannot change here,
              says so with a lock instead of looking like a field. */}
          {editingName ? (
            <div>
              <FieldLabel>Name</FieldLabel>
              <input
                type="text"
                value={displayName}
                autoFocus
                onChange={e => setDisplayName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveDisplayName(); if (e.key === 'Escape') { setDisplayName(displayNameOf(user)); setEditingName(false); } }}
                placeholder="What we should call you"
                maxLength={40}
                className="glass-field w-full px-4 py-2.5 rounded-lg text-white placeholder-gray-600 text-sm focus:outline-none transition-colors"
                style={glassInput}
              />
              {nameError && <p className="text-red-400 text-sm mt-2">{nameError}</p>}
              <div className="flex gap-2 mt-3">
                <Button variant="secondary" onClick={() => { setDisplayName(displayNameOf(user)); setNameError(''); setEditingName(false); }}>Cancel</Button>
                <Button variant="primary" onClick={saveDisplayName} disabled={nameSaving || !displayName.trim()}>
                  {nameSaving ? 'Saving' : 'Save'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm" style={{ color: 'var(--text)' }}>Name</span>
              <span className="flex items-center gap-3 min-w-0">
                <span className="text-sm truncate" style={{ color: 'var(--text-muted)' }}>{displayNameOf(user)}</span>
                <Button variant="text" onClick={() => setEditingName(true)} className="t-small">Edit</Button>
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm" style={{ color: 'var(--text)' }}>Email</span>
            <span className="flex items-center gap-2 min-w-0 text-sm" style={{ color: 'var(--text-faint)' }} title="Can't be changed">
              <span className="truncate">{user?.email}</span>
              <Lock className="w-3.5 h-3.5 flex-shrink-0" />
            </span>
          </div>

          {changingPassword ? (
            <div className="space-y-3">
              <FieldLabel>Change password</FieldLabel>
              <div className="relative">
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  placeholder="Current password"
                  className="glass-field w-full px-4 py-2.5 pr-10 rounded-lg text-white placeholder-gray-600 text-sm focus:outline-none transition-colors"
                  style={glassInput}
                />
                <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="New password"
                  className="glass-field w-full px-4 py-2.5 pr-10 rounded-lg text-white placeholder-gray-600 text-sm focus:outline-none transition-colors"
                  style={glassInput}
                />
                <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {pwError && <p className="text-red-400 text-sm">{pwError}</p>}
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => { setChangingPassword(false); setCurrentPassword(''); setNewPassword(''); setPwError(''); }}>Cancel</Button>
                <Button variant="primary" onClick={changePassword} disabled={pwSaving || !currentPassword || !newPassword}>
                  {pwSaving ? 'Updating' : pwSaved ? 'Updated' : 'Update password'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm" style={{ color: 'var(--text)' }}>Password</span>
              <Button variant="text" onClick={() => setChangingPassword(true)} className="t-small">Change</Button>
            </div>
          )}
        </div>
      </Fold>

      {/* ── The brain, with what they told us inside it ── */}
      <Fold {...cardProps('brain')} title="Chumoku brain" ok={!!brain} value={brain ? 'Built' : 'Not built yet'}>
        {(!brain || editingProfile) && (
          <div className="space-y-4 mb-5">
            <div>
              <FieldLabel>Where you are</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {CREATOR_LEVELS.map(l => (
                  <button key={l.value} type="button" className="chip" data-on={creatorLevel === l.value} onClick={() => setCreatorLevel(l.value)}>
                    {l.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                {CREATOR_LEVELS.find(l => l.value === creatorLevel)?.hint}
              </p>
            </div>
            <div>
              <FieldLabel>About you</FieldLabel>
              <textarea
                value={channelDescription}
                onChange={e => setChannelDescription(e.target.value)}
                placeholder="What you make, who it is for, what you are trying to fix. A sentence is enough."
                rows={3}
                className="glass-field w-full px-4 py-3 rounded-lg text-white placeholder-gray-600 text-sm focus:outline-none resize-none leading-relaxed transition-colors"
                style={glassInput}
              />
            </div>
            <div>
              <FieldLabel>What you want</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {CHANNEL_GOALS.map(g => (
                  <button key={g.value} type="button" className="chip" data-on={channelGoal === g.value} onClick={() => setChannelGoal(g.value)}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            {(contextError || loadFailed) && (
              <p className="text-red-400 text-sm">
                {contextError || 'Could not read your profile just now, so saving is off to avoid writing over it. Reload the page.'}
              </p>
            )}
            <div className="flex gap-2">
              {brain && <Button variant="secondary" onClick={() => setEditingProfile(false)}>Cancel</Button>}
              <Button variant="primary" onClick={async () => { await saveContext(); setEditingProfile(false); }} disabled={contextSaving || loadFailed || brainBuilding}>
                {(contextSaving || brainBuilding) && <Loader2 className="w-4 h-4 animate-spin" />}
                {brain ? 'Save and rebuild' : 'Build it'}
              </Button>
            </div>
          </div>
        )}
        {brain && (
          <>
            <BrainCard
              brain={brain}
              overrides={brainOverrides}
              heardVoice={heardVoice}
              builtAt={brainAt}
              loading={brainBuilding}
              error={brainError}
              onBuild={() => buildBrain(false)}
              onSaveEdits={async next => {
                const { error } = await supabase.from('user_tokens').update({ brain_overrides: next }).eq('user_id', user?.id);
                if (error) throw error;
                setBrainOverrides(next);
              }}
            />
            {!editingProfile && (
              <Button variant="text" onClick={() => setEditingProfile(true)} className="t-small mt-3">Edit what you told us</Button>
            )}
          </>
        )}
        {!brain && brainError && <p className="text-red-400 text-sm">{brainError}</p>}
        {openCard === 'brain' && youtubeStatus?.connected && user?.id && (
          <RetentionLessons userId={user.id} onReconnect={connectYouTube} />
        )}
      </Fold>

      {/* ── YouTube account ── */}
      <Fold {...cardProps('youtube')} title="YouTube account" ok={!!youtubeStatus?.connected}
        value={youtubeStatus?.connected ? (youtubeStatus.channelName || 'Connected') : 'Not connected'}>
        {youtubeStatus?.connected ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {youtubeStatus.channelThumbnail ? (
                <img src={youtubeStatus.channelThumbnail} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,0,0,0.1)' }}>
                  <YouTubeLogo className="w-4 h-4 text-red-500" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm text-white font-medium truncate">{youtubeStatus.channelName || 'Connected'}</p>
                {youtubeStatus.updatedAt && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    Last synced {new Date(youtubeStatus.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={connectYouTube} className="flex-shrink-0">
              <RefreshCw className="w-3.5 h-3.5" />
              Reconnect
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-500">No account connected</p>
            <Button variant="primary" size="sm" onClick={connectYouTube} className="flex-shrink-0">
              <Link className="w-3.5 h-3.5" />
              Connect
            </Button>
          </div>
        )}

        {youtubeStatus?.connected && <ChannelNumbers />}

        {youtubeStatus?.connected && (
          <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            {confirmDisconnect ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="t-small w-full sm:w-auto" style={{ color: 'var(--text-muted)' }}>Disconnect this YouTube account?</span>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDisconnect(false)}>Keep</Button>
                <Button variant="text" onClick={disconnectYouTube} disabled={disconnecting} className="t-small hover:!text-red-400">
                  {disconnecting ? 'Disconnecting' : 'Yes, disconnect'}
                </Button>
              </div>
            ) : (
              <Button variant="text" onClick={() => setConfirmDisconnect(true)} className="t-small">Disconnect account</Button>
            )}
          </div>
        )}
      </Fold>

      {/* ── TikTok and Instagram ── */}
      <Fold {...cardProps('social')} title="TikTok and Instagram">
        {openCard === 'social' && <SocialProfiles />}
      </Fold>

      {/* ── Competitor channels ── */}
      <Fold {...cardProps('channels')} title="Competitor channels">
        {openCard === 'channels' && <ChannelsSettings />}
      </Fold>

      {/* ── Language ── */}
      <Fold {...cardProps('language')} title="Language" value={LANGUAGE_NAMES[language] ?? 'English'}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm" style={{ color: 'var(--text)' }}>Ideas and scripts</span>
          <select
            value={language}
            onChange={async e => {
              const next = e.target.value;
              setLanguage(next);
              await supabase.from('user_tokens').update({ language: next }).eq('user_id', user?.id);
            }}
            className="glass-field px-3 py-2 rounded-lg text-sm text-white focus:outline-none"
            style={glassInput}
          >
            {Object.entries(LANGUAGE_NAMES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </div>
      </Fold>

      {/* ── Subscription ── (paid only) */}
      {!isFree && (
        <Fold {...cardProps('subscription')} title="Subscription" value={cancelDone ? 'Cancelled' : planName}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <Tile label="Plan" value={planName} sub={planName === 'Pro' ? '300 credits a month' : '100 credits a month'} />
              <Tile label="Credits left" value={String(left)} sub={usage ? `of ${usage.creditsLimit}` : undefined} />
              <Tile label="Credits refill" value={billing.resetAt ? new Date(billing.resetAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                    sub={billing.store === 'apple' ? 'Billed by the App Store' : 'Billed by Stripe'} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => go('upgrade')}>Change plan</Button>
              <Button variant="secondary" disabled={topupBusy} onClick={async () => {
                setTopupBusy(true); setTopupError('');
                try { await startTopup(); } catch (e) { setTopupError(e instanceof Error ? e.message : 'Failed to start checkout'); setTopupBusy(false); }
              }}>
                {topupBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                {CREDIT_PACK.credits} extra credits · {CREDIT_PACK.price}
              </Button>
            </div>
            <div className="pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              {billing.store === 'apple' ? (
                <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  Bought on iPhone, so it is managed there: Settings → your name → Subscriptions.
                </p>
              ) : cancelDone ? (
                <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Cancelled. You keep everything until the end of the billing period.</p>
              ) : confirmCancel ? (
                <div>
                  <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                    Cancel your subscription? You keep everything until the end of the current billing period.
                  </p>
                  <div className="flex items-center gap-4 mt-3">
                    <Button variant="secondary" size="sm" onClick={() => setConfirmCancel(false)}>Keep plan</Button>
                    <Button variant="text" onClick={cancelSubscription} disabled={cancelLoading} className="t-small hover:!text-red-400">
                      {cancelLoading ? 'Cancelling' : 'Yes, cancel'}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="text" onClick={() => setConfirmCancel(true)} className="t-small">Cancel subscription</Button>
              )}
              {cancelError && <p className="mt-2 text-red-400 text-xs">{cancelError}</p>}
            </div>
          </div>
        </Fold>
      )}

      {/* ── Owner only: the codes field (ADMIN, PARTNERS, perks) and a door
          to the admin overview. Codes are hidden from everyone else for now
          (Ivan, 2026-10-30). ── */}
      {user?.email === ADMIN_EMAIL && (
        <>
          <Fold {...cardProps('redeem')} title="Redeem code">
            <div className="flex items-center gap-2">
              <input
                value={redeemCode}
                onChange={e => { setRedeemCode(e.target.value); setRedeemMsg(null); }}
                onKeyDown={e => { if (e.key === 'Enter') redeem(); }}
                placeholder="Enter a code"
                className="glass-field flex-1 min-w-0 px-4 py-2.5 rounded-lg text-white placeholder-gray-600 text-sm focus:outline-none transition-colors"
                style={glassInput}
              />
              <Button variant="secondary" onClick={redeem} disabled={!redeemCode.trim() || redeeming} className="flex-shrink-0">
                {redeeming ? 'Redeeming' : 'Redeem'}
              </Button>
            </div>
            {redeemMsg && (
              <p className={`mt-2 text-xs ${redeemMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{redeemMsg.text}</p>
            )}
          </Fold>
          <div className="row-group">
            <button className="row" onClick={() => go('admin')}>
              <span className="flex-1 text-left text-[15px] font-medium" style={{ color: 'var(--text)' }}>Admin</span>
              <ArrowUpRight className="w-4 h-4 row-arrow" />
            </button>
          </div>
        </>
      )}

      {/* ── Discord: where people talk to us. Not folded away in a Help
          section, not the big banner it once was either. ── */}
      <a href="https://discord.gg/N8S6C95Ry2" target="_blank" rel="noopener noreferrer" className="row-group block"
         style={{ background: 'rgba(88,101,242,0.08)', borderColor: 'rgba(88,101,242,0.28)' }}>
        <span className="row">
          <span className="row-icon" style={{ background: '#5865F2' }}><MessageCircle className="w-[18px] h-[18px] text-white" /></span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-medium" style={{ color: 'var(--text)' }}>Join the Discord</span>
            <span className="block text-[13px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Creators, feedback, early features</span>
          </span>
          <ExternalLink className="w-4 h-4 row-arrow" />
        </span>
      </a>

      {/* The sidebar's Sign out is not there on a phone any more. */}
      <Button variant="ghost" onClick={() => signOut()} className="w-full mt-4">Sign out</Button>

      <p className="pt-4 text-center text-[12px]" style={{ color: 'var(--text-faint)' }}>
        <a href="/privacy" className="hover:underline">Privacy</a>
        <span className="mx-2">·</span>
        <a href="/terms" className="hover:underline">Terms</a>
      </p>
      </div>
      )}
    </Page>
  );
}

// A section: its name, what is in it, and a chevron. Same shape as the iOS
// app's fold; the old cards had an icon tile and a sentence under every title,
// which made the page six paragraphs long before anything was opened.
function Fold({ title, value, ok, open, onToggle, children }: {
  title: string; value?: string | null; open: boolean; onToggle: () => void; children: React.ReactNode;
  // A green check before the value: connected, built, done.
  ok?: boolean;
}) {
  return (
    <div className="row-group">
      <button onClick={onToggle} className="row" aria-expanded={open}>
        <span className="flex-1 min-w-0 text-[15px] font-medium text-left" style={{ color: 'var(--text)' }}>{title}</span>
        {value && !open && (
          <span className="text-[13px] truncate min-w-0 max-w-[55%]" style={{ color: 'var(--text-faint)' }}>{value}</span>
        )}
        {/* In a fixed slot by the chevron, so the checks line up. */}
        {ok && !open && <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'rgb(var(--ok-rgb))' }} />}
        <ChevronDown
          className="w-4 h-4 flex-shrink-0 row-chevron"
          style={{ color: 'var(--text-faint)', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>
      <Collapse open={open}><div className="row-group-body">{children}</div></Collapse>
    </div>
  );
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Español', pt: 'Português', fr: 'Français', de: 'Deutsch', ja: '日本語', ru: 'Русский',
};

// ─── The brain, on screen ────────────────────────────────────────────────────
// The profile the model wrote, shown to the person it is about.
//
// It could have stayed invisible - nothing in the product needs the creator to
// read it. But a profile that silently steers every adapted idea, that nobody
// can see and nobody can correct, is the same trap as the four boxes it
// replaced, only harder to argue with. Shown, it is checkable: if it has the
// channel wrong, the fix is a line in the box above and a rebuild.
const BRAIN_TEXT: { key: 'niche' | 'format' | 'audience' | 'voice'; label: string }[] = [
  { key: 'niche', label: 'Niche' },
  { key: 'format', label: 'Format' },
  { key: 'audience', label: 'Audience' },
  { key: 'voice', label: 'Voice' },
];
const BRAIN_LISTS: { key: 'strengths' | 'watch_outs' | 'adapt_rules'; label: string }[] = [
  { key: 'strengths', label: 'What already works' },
  { key: 'watch_outs', label: 'What we will not suggest' },
  { key: 'adapt_rules', label: 'How ideas get remade for you' },
];

// The summary up front, the rest one tap away, and every part editable.
//
// Shown in full it took most of a screen (Ivan, 2026-10-10). Edits are stored
// as overrides beside the read rather than written into it: the brain rebuilds
// itself weekly, and a rebuild that wiped what someone corrected by hand would
// teach them not to bother.
export function BrainCard({ brain, overrides, heardVoice, builtAt, loading, error, onBuild, onSaveEdits }: {
  brain: ChannelBrain | null;
  overrides: BrainOverrides;
  heardVoice: string | null;
  builtAt: string | null;
  loading: boolean;
  error: string;
  onBuild: () => void;
  onSaveEdits: (next: BrainOverrides) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // What the read says, before edits. The heard voice beats the brain's own
  // one-liner, which is written from titles.
  const base = (k: string): string | string[] => {
    if (!brain) return '';
    if (k === 'voice') return heardVoice || brain.voice;
    return (brain as unknown as Record<string, string | string[]>)[k] ?? '';
  };
  const shown = (k: string): string | string[] => {
    const o = (overrides as Record<string, string | string[] | undefined>)[k];
    return (Array.isArray(o) ? o.length : o?.trim()) ? o! : base(k);
  };
  const asText = (v: string | string[]) => Array.isArray(v) ? v.join('\n') : v;
  const edited = Object.keys(overrides).length > 0;

  const startEdit = () => {
    const d: Record<string, string> = { summary: asText(shown('summary')) };
    for (const f of [...BRAIN_TEXT, ...BRAIN_LISTS]) d[f.key] = asText(shown(f.key));
    setDraft(d);
    setSaveError('');
    setEditing(true);
    setOpen(true);
  };

  const save = async () => {
    const next: BrainOverrides = {};
    for (const key of ['summary', ...BRAIN_TEXT.map(f => f.key)] as const) {
      const v = (draft[key] ?? '').trim();
      if (v && v !== asText(base(key)).trim()) (next as Record<string, string>)[key] = v;
    }
    for (const { key } of BRAIN_LISTS) {
      const v = (draft[key] ?? '').split('\n').map(x => x.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      if (v.length && v.join('\n') !== asText(base(key))) (next as Record<string, string[]>)[key] = v;
    }
    setSaving(true);
    setSaveError('');
    try {
      await onSaveEdits(next);
      setEditing(false);
    } catch {
      setSaveError('Could not save that. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, value: string | string[]) =>
    (Array.isArray(value) ? value.length : value) ? (
      <div key={label}>
        <FieldLabel>{label}</FieldLabel>
        {Array.isArray(value) ? (
          <ul className="space-y-1.5">
            {value.map((x, i) => (
              <li key={i} className="text-sm leading-relaxed flex gap-2" style={{ color: 'var(--text-muted)' }}>
                <span style={{ color: 'var(--text-faint)' }}>-</span>
                <span>{x}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>{value}</p>
        )}
      </div>
    ) : null;

  const input = (key: string, label: string, rows: number, hint?: string) => (
    <div key={key}>
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={draft[key] ?? ''}
        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
        rows={rows}
        className="glass-field w-full px-4 py-3 rounded-lg text-white text-sm focus:outline-none resize-y leading-relaxed"
        style={glassInput}
      />
      {hint && <p className="mt-1.5 text-xs" style={{ color: 'var(--text-faint)' }}>{hint}</p>}
    </div>
  );

  if (!brain) {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Nothing here yet. Build it and every idea, outline and rewrite after that is
          written for your channel instead of for a generic one.
        </p>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <Button variant="primary" onClick={onBuild} disabled={loading}>
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? 'Reading your channel' : 'Build it'}
        </Button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="space-y-4">
        {input('summary', 'Summary', 4)}
        {BRAIN_TEXT.map(f => input(f.key, f.label, f.key === 'niche' ? 1 : 3))}
        {BRAIN_LISTS.map(f => input(f.key, f.label, 4, 'One per line.'))}
        {saveError && <p className="text-red-400 text-sm">{saveError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </Button>
          <Button variant="text" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{shown('summary') as string}</p>

      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:text-[var(--text)]"
        style={{ color: 'var(--text-muted)' }}
        aria-expanded={open}
      >
        {open ? 'Hide details' : 'Details'}
        <ChevronDown className="w-3.5 h-3.5 transition-transform" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      <Collapse open={open} className="!mt-0">
        <div className="space-y-4 pt-4">
          {BRAIN_TEXT.map(f => field(f.label, shown(f.key)))}
          {BRAIN_LISTS.map(f => field(f.label, shown(f.key)))}
        </div>
      </Collapse>

      <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
        {brain.source === 'uploads'
          ? 'Updates itself every week from your uploads.'
          : 'Written from what you wrote. Connect your channel and this gets read off your real uploads instead.'}
        {edited && ' Your edits stay.'}
        {builtAt && ` Last read ${new Date(builtAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`}
      </p>

      {(error || saveError) && <p className="text-red-400 text-sm">{error || saveError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={startEdit}>Edit</Button>
        <Button variant="secondary" onClick={onBuild} disabled={loading}>
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? 'Reading your channel' : 'Rebuild'}
        </Button>
        {edited && (
          <Button variant="text" onClick={() => onSaveEdits({}).catch(() => setSaveError('Could not reset.'))}>
            Undo my edits
          </Button>
        )}
      </div>
    </div>
  );
}

// The channel's own numbers. These were the top of the Analytics tab until it
// was removed on 2026-09-29; the radar under them went with the score it was
// built from, and four numbers do not need a tab of their own.
interface ChannelStats {
  connected: boolean;
  subscribers?: number;
  totalViews?: number;
  views28?: number;
  subsGained28?: number;
  watchMinutes28?: number;
}

// One request per visit to the app, shared by every mount of Settings: leaving
// and coming back shows the numbers straight away instead of fetching them
// again. A failed request is forgotten so the next visit can retry.
const STATS_WAIT_MS = 3500;
let statsRequest: Promise<ChannelStats | null> | null = null;
let statsValue: ChannelStats | null = null;
let statsUser: string | undefined;

// Keyed on the account so signing out and into another one never shows the
// first account's numbers.
function loadChannelStats(userId?: string): Promise<ChannelStats | null> {
  if (userId !== statsUser) { statsUser = userId; statsRequest = null; statsValue = null; }
  if (!statsRequest) {
    statsRequest = (async () => {
      const token = await getSessionToken();
      if (!token) return null;
      const res = await fetchWithRetry(`${FUNCTIONS_URL}/channel-stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('channel-stats failed');
      statsValue = await res.json();
      return statsValue;
    })().catch(() => { statsRequest = null; return null; });
  }
  return statsRequest;
}

function ChannelNumbers() {
  const { user } = useAuth();
  const [stats, setStats] = useState<ChannelStats | null>(statsUser === user?.id ? statsValue : null);
  useEffect(() => {
    let alive = true;
    loadChannelStats(user?.id).then(v => { if (alive && v) setStats(v); });
    return () => { alive = false; };
  }, [user?.id]);
  // Still on its way (only past the page's wait): hold the tiles' space so
  // they fill in rather than push the card open further.
  if (!stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4" aria-busy="true">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[98px]" style={{ borderRadius: 'var(--r-md)' }} />)}
      </div>
    );
  }
  if (!stats.connected) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">
      <Tile label="Subscribers" value={formatViews(stats.subscribers ?? 0)}
            sub={stats.subsGained28 ? `+${formatViews(stats.subsGained28)} in 28d` : undefined} />
      <Tile label="Views 28d" value={formatViews(stats.views28 ?? 0)} />
      <Tile label="Watch time 28d" value={`${formatViews(Math.round((stats.watchMinutes28 ?? 0) / 60))}h`} />
      <Tile label="Total views" value={formatViews(stats.totalViews ?? 0)} />
    </div>
  );
}
