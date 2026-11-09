import { useState, useEffect, useRef } from 'react';

import {
  CloseCircleOutlineIcon as X,
  RefreshOutlineIcon as Loader2,
  AltArrowRightOutlineIcon as ChevronRight,
  AltArrowDownOutlineIcon as ChevronDown,
  ArrowUpOutlineIcon as ArrowUp,
  LetterOutlineIcon as Mail,
  HamburgerMenuOutlineIcon as Menu,
} from '@solar-icons/react';
import { Check } from './BrandIcons';
import { useAuth } from '../contexts/AuthContext';
import { HeroAnalysisGate } from './HeroAnalysisGate';
import { supabase } from '../lib/supabase';
import { SUPPORT_EMAIL } from '../lib/brand';
import { FAQS } from '../lib/faq';
import { readLastEmail, forgetLastEmail } from '../lib/user';
import { arrivedWith, peek, PENDING_ANALYZE_KEY, PENDING_STEAL_KEY } from '../lib/intents';
import { CompetitorVideoCard } from './CompetitorVideoCard';
import { BillingSeg } from './BillingSeg';
import { Collapse } from './Page';
import type { FeedItem } from '../lib/competitors';
import { Head } from './LandingMotion';
import { LandingStory } from './LandingStory';
import { Claude } from './BrandIcons';

// ─── Surface ─────────────────────────────────────────────────────────────────
// This page used to run on three bespoke `glass` objects: stacked white
// gradients, inset highlights, a 34px drop shadow, and a blue-tinted variant
// for the hero field. None of them exist in the product. A visitor signing up
// went from a page made of frosted panels to an app made of flat plates with a
// hairline, which is why the landing read as a different piece of software than
// the thing it was selling.
//
// There is one plate now, and it is the app's: --bg-raised, one --line
// hairline, one radius token. Same object as Panel in Page.tsx.
const plate: React.CSSProperties = {
  background: 'var(--bg-raised)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
};

// The app's composer shell (AnalysisChat.tsx) — larger radius, same plate.
const composer: React.CSSProperties = {
  background: 'var(--bg-raised)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-lg)',
};

const inputReset: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--text)',
};

// ONE column, ONE gutter, on every section — the same pair Page.tsx sets for
// every tab in the app, so the left edge of this page and the left edge of the
// product land on the same place. Sections used to run at max-w-4xl with px-6
// while the app ran max-w-5xl with px-5/px-8.
const SECTION = 'w-full max-w-5xl mx-auto px-5 sm:px-8';

function GoogleMark() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

// ─── Scroll reveal ────────────────────────────────────────────────────────────

function useReveal(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold, rootMargin: '0px 0px -40px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, visible };
}

// Was 28px of travel over 600ms, which is a slide, and a slide on every block
// is the tell that a page is animated rather than designed. 10px over 500ms:
// the section settles, it does not arrive.
function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const { ref, visible } = useReveal();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        transition: `opacity 0.5s ease ${delay}ms, transform 0.5s ease ${delay}ms`,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(10px)',
      }}
    >
      {children}
    </div>
  );
}

// ─── Auth modal ───────────────────────────────────────────────────────────────

function AuthModal({ initialMode, onClose, context }: {
  initialMode: 'login' | 'signup';
  onClose: () => void;
  // Set when the form is raised at the end of the hero analysis, so the
  // headline answers "why am I being asked this" instead of introducing the
  // product to someone who is already five steps in.
  context?: { title: string; sub: string };
}) {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>(initialMode);
  // Signing back in as yourself is the common case, so the form starts knowing
  // who you were. Signing up is not: a second account on the same browser
  // begins empty, or the field would be arguing with the person filling it in.
  const [remembered, setRemembered] = useState(() => readLastEmail());
  const [email, setEmail] = useState(() => (initialMode === 'login' ? readLastEmail() : ''));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const { signInWithEmail, signUpWithEmail, signInWithGoogle } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password);
        setEmailSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
    });
    setLoading(false);
    if (err) setError(err.message);
    else setResetSent(true);
  };

  const handleGoogle = async () => {
    setError('');
    setGoogleLoading(true);
    try { await signInWithGoogle(); }
    catch (err) { setError(err instanceof Error ? err.message : 'An error occurred'); setGoogleLoading(false); }
  };

  // One field style for every input in the modal, on the same plate the rest of
  // the page uses. Focus moves the hairline to --line-strong rather than
  // painting a white border, which at this accent would be a glowing box.
  const fieldProps = {
    className: 'w-full px-4 py-2.5 rounded-[var(--r-sm)] text-sm',
    style: { background: 'var(--bg-app)', border: '1px solid var(--line)', outline: 'none', color: 'var(--text)' },
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = 'var(--line-strong)'; },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = 'var(--line)'; },
  };

  const primaryBtn = 'w-full py-2.5 rounded-[var(--r-sm)] font-semibold text-sm disabled:opacity-50';
  const primaryStyle = { background: 'var(--accent)', color: 'var(--on-accent)' };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 animate-fade-in"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md p-8 animate-scale-in"
        style={{ background: 'var(--bg-raised)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-lg)' }}
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 p-1.5 rounded-[var(--r-sm)] transition-colors hover:text-[var(--text)]" style={{ color: 'var(--text-faint)' }}>
          <X className="w-4 h-4" />
        </button>

        <div className="mb-6">
          <p className="text-[19px] font-semibold tracking-tight mb-1" style={{ color: 'var(--text)' }}>
            {emailSent ? 'Almost there' : mode === 'forgot' ? 'Reset password' : mode === 'login' ? 'Welcome back' : (context?.title ?? 'Start for free')}
          </p>
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {emailSent ? 'Confirm your email to activate your account.' : mode === 'forgot' ? "We'll send you a reset link." : mode === 'login' ? 'Sign in to your Chumoku account.' : (context?.sub ?? 'Ten new ideas every morning.')}
          </p>
        </div>

        {emailSent ? (
          <div className="text-center py-2 animate-fade-in">
            <p className="text-[15px] font-medium mb-2" style={{ color: 'var(--text)' }}>Check your email</p>
            <p className="text-[13px] mb-1" style={{ color: 'var(--text-muted)' }}>We sent a confirmation link to</p>
            <p className="text-[13px] font-medium mb-5" style={{ color: 'var(--text)' }}>{email}</p>
            <div className="p-3 mb-5 text-left" style={plate}>
              <p className="label-mono mb-1.5">One thing</p>
              <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Open the link on <strong style={{ color: 'var(--text)' }}>this device</strong>. Clicking it on your phone while Chumoku is open on a PC will not sign you in here.
              </p>
            </div>
            <button
              onClick={() => { setEmailSent(false); setMode('login'); setPassword(''); }}
              className={`${primaryBtn} mb-3`}
              style={primaryStyle}
            >
              I confirmed my email, sign in
            </button>
            <button onClick={handleGoogle} disabled={googleLoading}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-[var(--r-sm)] font-medium text-sm transition-colors disabled:opacity-50"
              style={{ background: 'var(--bg-app)', border: '1px solid var(--line)', color: 'var(--text)' }}
            >
              {googleLoading ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-faint)' }} /> : <GoogleMark />}
              Or continue with Google
            </button>
            <p className="text-[12px] mt-3" style={{ color: 'var(--text-faint)' }}>
              No email? Check spam or{' '}
              <button onClick={() => { setEmailSent(false); setMode('signup'); }} className="underline" style={{ color: 'var(--text-muted)' }}>try again</button>.
            </p>
          </div>
        ) : mode === 'forgot' ? (
          resetSent ? (
            <div className="text-center py-4 animate-fade-in">
              <p className="text-[15px] font-medium mb-1" style={{ color: 'var(--text)' }}>Check your email</p>
              <p className="text-[13px] mb-5" style={{ color: 'var(--text-muted)' }}>Reset link sent to {email}</p>
              <button onClick={() => { setMode('login'); setResetSent(false); }} className="text-[13px]" style={{ color: 'var(--text)' }}>Back to sign in</button>
            </div>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required {...fieldProps} />
              {error && <p className="text-[13px] rounded-[var(--r-sm)] p-3" style={{ color: 'rgb(var(--danger-rgb))', background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.2)' }}>{error}</p>}
              <button type="submit" disabled={loading} className={primaryBtn} style={primaryStyle}>
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
              <div className="text-center">
                <button type="button" onClick={() => setMode('login')} className="text-[13px] transition-colors hover:text-[var(--text)]" style={{ color: 'var(--text-muted)' }}>Back to sign in</button>
              </div>
            </form>
          )
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-3 mb-4">
              {/* Recognised, not assumed. Nothing is signed in until a password
                  or Google says so; this only saves typing an address you have
                  typed before, and the way out sits next to it rather than
                  three screens away. */}
              {mode === 'login' && remembered && email === remembered && (
                <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  <span className="truncate">Last signed in as {remembered}</span>
                  <button
                    type="button"
                    onClick={() => { forgetLastEmail(); setRemembered(''); setEmail(''); setPassword(''); }}
                    className="flex-shrink-0 underline transition-colors hover:text-[var(--text)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Use another account
                  </button>
                </div>
              )}
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required {...fieldProps} />
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required {...fieldProps} />
              {mode === 'login' && (
                <div className="text-right">
                  <button type="button" onClick={() => { setMode('forgot'); setError(''); }} className="text-[12px] transition-colors hover:text-[var(--text-muted)]" style={{ color: 'var(--text-faint)' }}>
                    Forgot password?
                  </button>
                </div>
              )}
              {error && <p className="text-[13px] rounded-[var(--r-sm)] p-3" style={{ color: 'rgb(var(--danger-rgb))', background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.2)' }}>{error}</p>}
              <button type="submit" disabled={loading || googleLoading} className={primaryBtn} style={primaryStyle}>
                {loading ? 'Loading...' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px" style={{ background: 'var(--line)' }} />
              <span className="label-mono">or</span>
              <div className="flex-1 h-px" style={{ background: 'var(--line)' }} />
            </div>

            <button onClick={handleGoogle} disabled={googleLoading || loading}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 rounded-[var(--r-sm)] font-medium text-sm disabled:opacity-50"
              style={{ background: 'var(--bg-app)', border: '1px solid var(--line)', color: 'var(--text)' }}
            >
              {googleLoading ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-faint)' }} /> : <GoogleMark />}
              {googleLoading ? 'Redirecting...' : 'Continue with Google'}
            </button>

            <div className="mt-5 text-center">
              <button onClick={() => {
                const next = mode === 'login' ? 'signup' : 'login';
                setMode(next);
                setError('');
                // A remembered address belongs on the sign-in form, not on the
                // one making a new account.
                setEmail(next === 'login' ? remembered : '');
              }}
                className="text-[13px] transition-colors hover:text-[var(--text)]" style={{ color: 'var(--text-muted)' }}>
                {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Product frames ───────────────────────────────────────────────────────────
// Not mockups of a product, and not the four invented mini-widgets that used to
// scroll past on a marquee here. These are the real components rebuilt at a
// smaller type scale: same plate, same hairline, same label-mono, same score
// layout as AnalysisChat's AnalysisCard and Competitors' feed. If the app
// changes shape, these are wrong, and that is the correct amount of coupling
// for a page whose whole job is to show the app.

// Real Shorts from creators on camera, who are who this is for (2026-11-09,
// was Roblox, GTA and Minecraft), with real numbers: each multiple is the
// video's views over its own channel's median Short, from the Ideas pool. The pitches are
// what a creator in the same niche would make of it. Nothing here is a mock
// of a number.
const DEMO: FeedItem[] = [
  {
    video_id: 'nYpN1D06LrM', channel_id: 'demo-0', channel_name: 'Coding with Lewis',
    video_title: "There's a Name for People Who Paste AI Responses at You", video_views: 1_714_681, video_published_at: null,
    outlier_score: 38, idea: { pitch: 'There\'s a name for coaches who post AI advice', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: 'qvFEJ5ksTZc', channel_id: 'demo-1', channel_name: 'vidIQ',
    video_title: 'YouTube Is Adding GIFs To Comments!', video_views: 816_415, video_published_at: null,
    outlier_score: 108, idea: { pitch: 'TikTok just changed comments and nobody noticed', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: 'dn627jC3Kf0', channel_id: 'demo-2', channel_name: 'Cluely',
    video_title: 'Ep 26: Cluely gets HR', video_views: 1_207_565, video_published_at: null,
    outlier_score: 24.5, idea: { pitch: 'Ep 1: our two-person startup hires HR', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: 'pz3UTWk4R-o', channel_id: 'demo-3', channel_name: 'Smart Nonsense',
    video_title: "How the NFL's magic yellow line works..", video_views: 2_494_707, video_published_at: null,
    outlier_score: 12, idea: { pitch: 'How Formula 1 shows speed on your TV', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: 'woGWeN2vsuY', channel_id: 'demo-4', channel_name: 'Caylus',
    video_title: 'I Snuck Into MrBeasts PARTY..', video_views: 23_159_389, video_published_at: null,
    outlier_score: 24, idea: { pitch: 'I snuck into the biggest creator party in my city', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: 'nGPFYc6eTKw', channel_id: 'demo-5', channel_name: 'Erik Cupsa',
    video_title: 'Learn How To Code In 90 Days', video_views: 208_327, video_published_at: null,
    outlier_score: 11, idea: { pitch: 'What 90 days at a startup actually taught me', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: '1d4WkrDhKfg', channel_id: 'demo-6', channel_name: 'Dan Thy FYP',
    video_title: 'What now seriously?', video_views: 8_221_853, video_published_at: null,
    outlier_score: 107, idea: { pitch: 'Every makeup brand after you buy from them once', fit: 'yes' } as FeedItem['idea'],
  },
  {
    video_id: 'PTd98UnJnnU', channel_id: 'demo-7', channel_name: 'Marques Brownlee',
    video_title: 'This TECH Knife is Insane!', video_views: 41_870_837, video_published_at: null,
    outlier_score: 6.1, idea: { pitch: 'The $20 gadget that replaced half my desk', fit: 'yes' } as FeedItem['idea'],
  },
];

// Pre-cropped covers served from this site (scripts/landing-thumbs.py): twice
// the resolution of YouTube's hqdefault after cropping, with the text on them.
const demoThumb = (id: string) => `/landing/${id}.webp`;

const STORY = DEMO.map(d => ({ id: d.video_id, source: d.video_title ?? '', pitch: (d.idea as { pitch: string }).pitch, multiple: d.outlier_score ?? 0, channel: d.channel_name ?? '' }));

const noop = () => {};

// Under the field: real ideas drifting past, the way the Ideas tab fills up.
// The track holds the list twice and slides by exactly half its width, so the
// loop has no seam; hovering stops it so a card can be read. Every other card
// sits a little lower so the row reads as laid out by hand, and the edges fade.
function HeroShelf() {
  const loop = [...DEMO, ...DEMO];
  return (
    <div className="shelf">
      <div className="shelf__track">
        {loop.map((item, i) => (
          <div key={`${item.video_id}-${i}`} className="shelf__item" data-low={(i % DEMO.length) % 2 ? 'true' : undefined}
               aria-hidden={i >= DEMO.length ? 'true' : undefined}>
            <CompetitorVideoCard item={item} thumb={demoThumb(item.video_id)} readOnly onOpen={noop} onSave={noop} onDismiss={noop} />
          </div>
        ))}
      </div>
    </div>
  );
}

// A sample conversation: what a connected Claude would do with one question.
function ClaudePanel() {
  return (
    <div className="claude-panel px-5 py-10 sm:px-12 sm:py-14">
      <div className="flex items-center justify-center gap-3.5 mb-7">
        <img src="/chumoku-mark.png" alt="Chumoku" className="h-9 w-auto" />
        <span className="text-[20px]" style={{ color: 'var(--text-faint)' }}>+</span>
        <Claude className="w-10 h-10" style={{ color: '#D97757' }} />
      </div>
      <div className="text-center">
        <span className="inline-block px-3 py-1 rounded-full text-[12px] font-medium" style={{ background: 'rgba(217,119,87,0.16)', color: '#E8A48C' }}>MCP coming soon</span>
        <h2 className="story-title mt-4 text-balance">Chumoku in Claude.</h2>
      </div>
      <div className="max-w-lg mx-auto mt-9 space-y-3.5">
        <p className="ml-auto w-fit px-4 py-2 rounded-[var(--r-sm)] text-[14px]" style={{ background: 'rgba(255,255,255,0.09)', color: 'var(--text)' }}>
          What should I film tomorrow?
        </p>
        <div className="space-y-1">
          {['read your last 30 videos', 'checked your competitors', "found today's ideas"].map(t => (
            <p key={t} className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              <span className="w-1 h-1 rounded-full" style={{ background: '#D97757' }} />{t}
            </p>
          ))}
        </div>
        <p className="text-[15px] leading-relaxed" style={{ color: 'var(--text)' }}>Your how-tos beat your usual by 4x. Film this one:</p>
        <p className="px-4 py-3 text-[15.5px] font-medium rounded-[var(--r-sm)]" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          How to copy any viral video with AI
        </p>
      </div>
    </div>
  );
}

function FAQSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div style={{ borderTop: '1px solid var(--line)' }}>
      {FAQS.map((f, i) => (
        <div key={f.q} style={{ borderBottom: '1px solid var(--line)' }}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full flex items-start gap-4 py-4 text-left"
            aria-expanded={open === i}
          >
            <span className="flex-1 text-[15px] font-medium" style={{ color: 'var(--text)' }}>{f.q}</span>
            <ChevronDown
              className="w-4 h-4 flex-shrink-0 mt-0.5 transition-transform duration-200"
              style={{ color: 'var(--text-faint)', transform: open === i ? 'rotate(180deg)' : 'none' }}
            />
          </button>
          {/* Grid-rows trick rather than max-height: the answer opens to its
              real height, so a long one is not clipped and a short one leaves
              no dead space under it. */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-out"
            style={{ gridTemplateRows: open === i ? '1fr' : '0fr' }}
          >
            <div className="overflow-hidden">
              {/* textWrap pretty, so the last line of an answer never comes
                  out as one orphan word under a full-width paragraph. The
                  first answer used to end on "only." alone on its own row. */}
              <p className="text-[14px] leading-relaxed pb-4 pr-8 max-w-2xl" style={{ color: 'var(--text-muted)', textWrap: 'pretty' }}>{f.a}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

type Interval = 'month' | 'year';

interface Plan {
  name: string;
  monthlyPrice: number;
  yearlyMonthlyPrice: number;
  yearlyTotal: number;
  quotas: string[];
  features: string[];
  cta: string;
  highlight: boolean;
}

// Mirrors UpgradePage.tsx's live Stripe prices. yearlyTotal is 12x the
// monthly rate rounded up 11c to end in .99 (Plus has no further discount
// on top of that; Pro's yearlyMonthlyPrice is the real ~35% cut).
const pricingPlans: Plan[] = [
  {
    name: 'Plus', monthlyPrice: 9.99, yearlyMonthlyPrice: 9.99, yearlyTotal: 119.99,
    // Competitors sits in `quotas` rather than `features` on purpose: quotas
    // render as the bold rows and features as the ticked ones, and this is the
    // one line that separates paid from the free trial (enforced server-side
    // in fetch-competitor-ideas / generate-outline, not just hidden in the UI).
    quotas: ['About 30 scripts a month', '5 tracked channels', '100 credits'],
    features: ['Your version of every idea, free', 'Scripts written for your channel', 'Steal and Ask on every Short'],
    cta: 'Get Plus', highlight: false,
  },
  {
    name: 'Pro', monthlyPrice: 19.99, yearlyMonthlyPrice: 12.99, yearlyTotal: 155.99,
    quotas: ['About 100 scripts a month', '10 tracked channels', '300 credits'],
    features: ['Everything in Plus', 'For posting every day'],
    cta: 'Get Pro', highlight: true,
  },
];

const proPlan = pricingPlans.find(p => p.name === 'Pro')!;
// Computed from the same numbers the card displays, so it can never drift out
// of sync the way a hardcoded "50% off" string did once already in this app.
const proPercentOff = Math.round(((proPlan.monthlyPrice * 12 - proPlan.yearlyTotal) / (proPlan.monthlyPrice * 12)) * 100);

function BillingToggle({ interval, onChange }: { interval: Interval; onChange: (v: Interval) => void }) {
  return (
    <BillingSeg interval={interval} onChange={onChange} percentOff={proPercentOff} />
  );
}

function PricingCard({ plan, interval, onSelect }: { plan: Plan; interval: Interval; onSelect: () => void }) {
  const [open, setOpen] = useState(false);
  const price = interval === 'year' ? plan.yearlyMonthlyPrice : plan.monthlyPrice;
  return (
    <div
      className="relative flex flex-col p-5 sm:p-6 h-full"
      style={{
        background: 'var(--bg-raised)',
        // The highlight is one hairline going from --line to --line-strong.
        // It used to be a tinted gradient wash plus a 40%-opacity accent
        // border, which at a white accent is a glowing rectangle.
        border: `1px solid ${plan.highlight ? 'var(--line-strong)' : 'var(--line)'}`,
        borderRadius: 'var(--r-md)',
      }}
    >
      <div className="flex items-center gap-2.5 mb-4">
        <span className="text-[15px] font-medium" style={{ color: 'var(--text)' }}>{plan.name}</span>
        {plan.highlight && <span className="label-mono">Most picked</span>}
      </div>

      <div className="flex items-baseline gap-1.5 mb-1">
        <span key={`${plan.name}-${interval}`} className="text-[34px] leading-none font-semibold tracking-tight tabular-nums animate-fade-in" style={{ color: 'var(--text)' }}>
          ${price.toFixed(2)}
        </span>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>/ mo</span>
      </div>
      <p className="font-mono text-[11px] mb-5" style={{ color: 'var(--text-faint)' }}>
        {interval === 'year' ? `$${plan.yearlyTotal.toFixed(2)} billed yearly` : 'billed monthly'}
      </p>

      <div className="space-y-2 mb-5">
        {plan.quotas.map(q => (
          <p key={q} className="text-[14px] font-medium" style={{ color: 'var(--text)' }}>{q}</p>
        ))}
      </div>

      {plan.features.length > 2 && (
        <button
          onClick={() => setOpen(o => !o)}
          className="self-start inline-flex items-center gap-1.5 text-[12px] mb-4 transition-colors hover:text-[var(--text)]"
          style={{ color: 'var(--text-muted)' }}
        >
          What is included
          <ChevronDown className="w-3.5 h-3.5 transition-transform duration-200" style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
      )}
      <Collapse open={plan.features.length <= 2 || open}>
        <ul className="space-y-2 pb-5">
          {plan.features.map(f => (
            <li key={f} className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              <Check className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--text-faint)' }} />
              {f}
            </li>
          ))}
        </ul>
      </Collapse>

      {/* The highlighted plan's button used to be `background: var(--accent)`
          with `color: white` — which was white on white from the moment the
          accent became white, i.e. an invisible label on the primary CTA. */}
      <button
        onClick={onSelect}
        className="mt-auto w-full py-2.5 rounded-full text-sm font-semibold transition-opacity hover:opacity-90"
        style={plan.highlight
          ? { background: 'var(--accent)', color: 'var(--on-accent)' }
          : { background: 'transparent', color: 'var(--text)', border: '1px solid var(--line-strong)' }}
      >
        {plan.cta}
      </button>
    </div>
  );
}

const navLinks: { label: string; id: string }[] = [
  { label: 'Product', id: 'product' },
  { label: 'Pricing', id: 'pricing' },
  { label: 'FAQ', id: 'faq' },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

// Kept in step with the sameAs array in index.html - the two are one claim
// made from two ends, and a profile in only one of them is half a signal.
const SOCIALS = [
  { label: 'YouTube', href: 'https://www.youtube.com/@chumokuhq' },
  { label: 'Instagram', href: 'https://www.instagram.com/chumokuhq/' },
  { label: 'TikTok', href: 'https://www.tiktok.com/@chumokuhq' },
];

export function LandingPage() {
  const [authModal, setAuthModal] = useState<null | 'login' | 'signup'>(null);
  const [heroGate, setHeroGate] = useState<string | null>(null);

  // A guest who pressed Analyze or Steal in the Chrome extension, or shared a
  // Short from their phone. They came to do one thing: an analysis starts the
  // same gate the hero does, anything else goes straight to signup, and the
  // pending link carries across either way.
  useEffect(() => {
    if (arrivedWith === 'analyze') {
      const url = peek(PENDING_ANALYZE_KEY);
      if (url) setHeroGate(url);
    } else if (arrivedWith) {
      setAuthModal('signup');
    }
  }, []);
  const [billingInterval, setBillingInterval] = useState<Interval>('year');
  const [heroUrl, setHeroUrl] = useState('');
  const [heroError, setHeroError] = useState('');
  const [mobileMenu, setMobileMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mirrors extractVideoId in AnalysisChat exactly, so nothing this accepts
  // gets rejected on the other side (and vice versa). Screening here means a
  // channel or playlist link is caught before the visitor is asked to sign up,
  // instead of failing after.
  const looksLikeVideoLink = (url: string) => {
    const t = url.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(t)) return true;
    return /[?&]v=([^&]+)/.test(t) || /shorts\/([^?&/\n]+)/.test(t) || /youtu\.be\/([^?&/\n]+)/.test(t) || /tiktok\.com\//i.test(t) || /instagram\.com\/(?:reels?|p)\//i.test(t);
  };

  // This page only ever renders for guests (App.tsx routes anyone with a
  // session straight to the Dashboard), so the link is stashed and signup
  // opens; once they are in, the Ideas tab picks the key up and runs the steal
  // without asking again (the same handoff the extension uses).
  const [heroSteal, setHeroSteal] = useState(false);
  const handleHeroSteal = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = heroUrl.trim();
    if (!trimmed) return;
    if (!looksLikeVideoLink(trimmed)) {
      setHeroError('That does not look like a Short. Paste a YouTube, TikTok or Instagram link.');
      return;
    }
    setHeroError('');
    try { localStorage.setItem(PENDING_STEAL_KEY, trimmed); } catch { /* private mode */ }
    setHeroSteal(true);
    setAuthModal('signup');
  };

  // The page scrolls in a div, not the window, so anchor hrefs would jump the
  // wrong box — scroll the section into view manually instead.
  const scrollTo = (id: string) => {
    setMobileMenu(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="relative" style={{ background: 'var(--bg-app)', color: 'var(--text)', height: '100dvh' }}>
      <div ref={scrollRef} className="relative h-full overflow-y-auto overflow-x-hidden">

        {/* ── Nav ─────────────────────────────────────────────────────────── */}
        <nav
          className="sticky top-0 z-40 w-full"
          style={{ background: 'rgba(10,10,11,0.78)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', borderBottom: '1px solid var(--line)' }}
        >
          <div className={`${SECTION} flex items-center gap-4 py-3.5`}>
            <button
              onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
              className="flex items-center gap-2 font-black uppercase tracking-[0.14em] text-[14px] whitespace-nowrap"
              style={{ color: 'var(--text)' }}
            >
              <img src="/chumoku-mark.png" alt="" className="h-[14px] w-auto flex-shrink-0" />
              Chumoku
            </button>

            <div className="hidden md:flex items-center gap-1 ml-6">
              {navLinks.map(link => (
                <button
                  key={link.label}
                  onClick={() => scrollTo(link.id)}
                  className="px-2.5 py-1.5 text-[13px] transition-colors hover:text-[var(--text)]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {link.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 ml-auto">
              <button
                onClick={() => setAuthModal('login')}
                className="hidden sm:inline-flex px-3 py-1.5 text-[13px] transition-colors hover:text-[var(--text)]"
                style={{ color: 'var(--text-muted)' }}
              >
                Sign in
              </button>
              <button
                onClick={() => setAuthModal('signup')}
                className="px-3.5 py-1.5 text-[13px] font-semibold rounded-full whitespace-nowrap transition-opacity hover:opacity-90"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                Get started
              </button>
              <button
                onClick={() => setMobileMenu(o => !o)}
                aria-label={mobileMenu ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileMenu}
                className="md:hidden p-1.5 ml-0.5"
                style={{ color: 'var(--text-muted)' }}
              >
                {mobileMenu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {mobileMenu && (
            <div className="md:hidden animate-fade-in" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg-app)' }}>
              <div className={`${SECTION} py-2`}>
                {navLinks.map(link => (
                  <button
                    key={link.label}
                    onClick={() => scrollTo(link.id)}
                    className="w-full text-left py-3 text-[14px]"
                    style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--line)' }}
                  >
                    {link.label}
                  </button>
                ))}
                <button onClick={() => { setMobileMenu(false); setAuthModal('login'); }} className="w-full text-left py-3 text-[14px]" style={{ color: 'var(--text-muted)' }}>
                  Sign in
                </button>
              </div>
            </div>
          )}
        </nav>

        {/* ── Hero ────────────────────────────────────────────────────────────
            Flat, like money.x.com: no ruled grid behind the headline. The grid
            that used to sit here was the last piece of decoration on the page.

            What used to be here before that: three drifting blurred blobs, a
            glow along the bottom edge, a rotating quote pill, a marquee of four
            invented widgets, and a haloed input. None of it existed in the
            product. */}
        <header className="relative overflow-hidden">
          {/* Centred now, after money.x.com: one headline, one line under it,
              one field, and the product underneath. The left-aligned version
              came from paper.design and read as a document; centred, the page
              opens on a single thing to do. */}
          <div className={`relative ${SECTION} pt-16 sm:pt-28 pb-10 sm:pb-14 flex flex-col items-center text-center`}>

            {/* Bright line, then the same sentence continuing in the muted
                weight. One headline doing the job the headline plus a
                subheading used to split between them. */}
            <h1
              className="animate-fade-in-up font-semibold max-w-4xl mx-auto"
              style={{ fontSize: 'clamp(2.1rem, 1.1rem + 3vw, 3.4rem)', letterSpacing: '-0.035em', lineHeight: 1.06 }}
            >
              {/* Each half on its own line, so neither breaks mid-phrase. The
                  benefit leads and the mechanism follows in the muted weight:
                  "AI content producer" named a category and left people asking
                  what it actually does; "script writer" was concrete and too
                  small. The workflow is the middle, and time is what it buys. */}
              <span className="block text-balance" style={{ color: 'var(--text)' }}>Steal what already works.</span>
            </h1>

            <div className="h-8 sm:h-10" />

            {/* The only CTA above the fold, and it is the app's composer, not a
                marketing input: same plate, same radius, same round send. */}
            <form onSubmit={handleHeroSteal} autoComplete="off" className="animate-fade-in-up delay-200 w-full max-w-xl mx-auto text-left">
              {/* Bigger than the app's composer and quietly lit - a stronger
                  hairline and a faint halo - because on this page it is the one
                  thing to do, and at the app's size it read as decoration. */}
              <div className="hero-field flex items-center gap-2 pl-5 pr-2.5 py-2.5"
                   style={{ ...composer, border: '1px solid var(--line-strong)' }}>
                <input
                  type="text"
                  value={heroUrl}
                  onChange={e => { setHeroUrl(e.target.value); if (heroError) setHeroError(''); }}
                  placeholder="Paste a Short to steal"
                  className="flex-1 min-w-0 py-2 text-[15px]"
                  style={inputReset}
                />
                <button
                  type="submit"
                  aria-label="Steal"
                  className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-opacity hover:opacity-90"
                  style={{ background: 'var(--accent)' }}
                >
                  <ArrowUp className="w-[18px] h-[18px]" style={{ color: 'var(--on-accent)' }} />
                </button>
              </div>
              <p className="label-mono mt-3 text-center" style={heroError ? { color: 'rgb(var(--danger-rgb))' } : undefined}>
                {heroError || 'Ten new ideas every morning'}
              </p>
            </form>
          </div>

          {/* The product, big, cropped by the fold. This is the whole first
              impression: not a claim about the app, the app. */}
          <div className={`relative ${SECTION} pb-16 sm:pb-24`}>
            <div className="animate-fade-in-up delay-300">
              <HeroShelf />
            </div>
          </div>
        </header>

        {/* ── The story ─────────────────────────────────────────────────────── */}
        <section className={SECTION}>
          <LandingStory ideas={STORY} />
        </section>

        {/* ── Claude ──────────────────────────────────────────────────────────
            Not built yet, so it says so. Ideas, scripts and channel data only:
            nothing about making video here (Everygen contract, clause 6). */}
        <section className={`${SECTION} pt-8 pb-16 sm:pb-24`}>
          <Reveal><ClaudePanel /></Reveal>
        </section>

        {/* ── Pricing ─────────────────────────────────────────────────────── */}
        <section id="pricing" className={`${SECTION} pb-16 sm:pb-24 scroll-mt-16`}>
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4 mb-10 sm:mb-14 pt-8 sm:pt-10" style={{ borderTop: '1px solid var(--line)' }}>
              <div>
                <h2 className="display" style={{ color: 'var(--text)' }}>
                  Pays for itself<br className="sm:hidden" /><span style={{ color: 'var(--text-muted)' }}> in time saved.</span>
                </h2>
              </div>
              <BillingToggle interval={billingInterval} onChange={setBillingInterval} />
            </div>
          </Reveal>

          <div className="grid sm:grid-cols-2 gap-3 sm:gap-4 mb-3 sm:mb-4">
            {pricingPlans.map((plan, i) => (
              <Reveal key={plan.name} delay={i * 70}>
                <PricingCard plan={plan} interval={billingInterval} onSelect={() => setAuthModal('signup')} />
              </Reveal>
            ))}
          </div>

        </section>

        {/* ── FAQ ─────────────────────────────────────────────────────────── */}
        <section id="faq" className={`${SECTION} pb-16 sm:pb-24 scroll-mt-16`}>
          <Head title="Everything people ask." />
          <Reveal delay={60}><FAQSection /></Reveal>
        </section>

        {/* ── Close ───────────────────────────────────────────────────────── */}
        <section className={`${SECTION} pb-16 sm:pb-24`}>
          <Reveal>
            <div className="px-5 py-4 sm:px-6 flex items-center justify-between gap-4" style={plate}>
              <h2 className="text-[17px] sm:text-[20px] font-medium tracking-tight text-balance" style={{ color: 'var(--text)' }}>Start with your next short.</h2>
              <button
                onClick={() => setAuthModal('signup')}
                className="inline-flex items-center gap-1.5 px-4 py-2 font-semibold rounded-full text-[14px] whitespace-nowrap flex-shrink-0 transition-opacity hover:opacity-90"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                Get started
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </Reveal>
        </section>

        {/* ── Footer ──────────────────────────────────────────────────────────
            Columns, then the name set huge and cut off by the bottom edge -
            the page ends on the brand instead of on a row of small links. The
            wordmark is type, not an image, so it costs nothing and never
            blurs. */}
        <footer className="relative overflow-hidden" style={{ borderTop: '1px solid var(--line)' }}>
          <div className={`${SECTION} pt-14 pb-10 grid grid-cols-3 gap-x-6 gap-y-10 sm:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]`}>
            <div className="col-span-3 sm:col-span-1">
              <div className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
                <img src="/chumoku-mark.png" alt="" className="h-[14px] w-auto" />
                Chumoku
              </div>
              <p className="text-[13px] leading-relaxed mt-3 max-w-[16rem] text-pretty" style={{ color: 'var(--text-muted)' }}>
                The Shorts workflow, automated. Less time on every Short.
              </p>
              {/* The other half of the sameAs in index.html: those profiles link
                  back here, and rel="me" is the markup for "this is also me". */}
              <div className="flex flex-wrap gap-x-4 gap-y-2 mt-5 text-[13px]">
                {SOCIALS.map(sn => (
                  <a key={sn.label} href={sn.href} rel="me noopener noreferrer" target="_blank"
                     className="transition-colors hover:text-[var(--text)]" style={{ color: 'var(--text-faint)' }}>
                    {sn.label}
                  </a>
                ))}
              </div>
            </div>

            {[
              { head: 'Product', links: [
                { label: 'How it works', onClick: () => scrollTo('product') },
                { label: 'Pricing', onClick: () => scrollTo('pricing') },
                { label: 'FAQ', onClick: () => scrollTo('faq') },
              ] },
              // Linked from the most-crawled page on purpose: a page nothing
              // links to is a page a crawler reaches late or never.
              { head: 'Resources', links: [
                { label: 'Blog', href: '/blog' },
                { label: 'Discord', href: 'https://discord.com/invite/N8S6C95Ry2', external: true },
              ] },
              { head: 'Company', links: [
                { label: 'Contact', href: `mailto:${SUPPORT_EMAIL}` },
                { label: 'Privacy', href: '/privacy' },
                { label: 'Terms', href: '/terms' },
              ] },
            ].map(col => (
              <div key={col.head}>
                <p className="label-mono mb-4">{col.head}</p>
                <ul className="space-y-2.5">
                  {col.links.map(l => (
                    <li key={l.label}>
                      {'href' in l && l.href ? (
                        <a href={l.href} {...('external' in l && l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                           className="text-[13.5px] transition-colors hover:text-[var(--text)]" style={{ color: 'var(--text-muted)' }}>
                          {l.label}
                        </a>
                      ) : (
                        <button onClick={'onClick' in l ? l.onClick : undefined}
                                className="text-[13.5px] transition-colors hover:text-[var(--text)]" style={{ color: 'var(--text-muted)' }}>
                          {l.label}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className={`${SECTION} pb-6 flex items-center justify-between gap-4`}>
            <p className="label-mono">© {new Date().getFullYear()} Chumoku</p>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="label-mono transition-colors hover:text-[var(--text)] flex items-center gap-1.5">
              <Mail className="w-3 h-3" />{SUPPORT_EMAIL}
            </a>
          </div>

          <p
            aria-hidden="true"
            className="select-none pointer-events-none text-center font-semibold leading-[0.78] -mb-[0.16em] whitespace-nowrap"
            style={{
              fontSize: 'clamp(4.5rem, 1rem + 17vw, 17rem)',
              letterSpacing: '-0.06em',
              color: 'transparent',
              backgroundImage: 'linear-gradient(to bottom, rgba(255,255,255,0.09), rgba(255,255,255,0.015))',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
            }}
          >
            chumoku
          </p>
        </footer>
      </div>

      {heroGate && (
        <HeroAnalysisGate
          url={heroGate}
          onNeedAccount={() => setAuthModal('signup')}
          onBack={() => {
            localStorage.removeItem('chumoku_pending_video_url');
            setHeroGate(null);
            setAuthModal(null);
          }}
        />
      )}

      {authModal && (
        <AuthModal
          initialMode={authModal}
          onClose={() => {
            setAuthModal(null);
            // Closing without signing up drops the steal they did not start.
            if (heroSteal) { try { localStorage.removeItem(PENDING_STEAL_KEY); } catch { /* ignore */ } setHeroSteal(false); }
          }}
          context={
            heroSteal && authModal === 'signup'
              ? { title: 'Create an account to steal it', sub: 'It runs the moment you are in.' }
              : heroGate && authModal === 'signup'
                ? { title: 'Your breakdown is ready', sub: 'Create an account to see it.' }
                : undefined
          }
        />
      )}
    </div>
  );
}
