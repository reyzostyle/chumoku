import { useState, useRef, useEffect, useMemo } from 'react';
import { isSocialId, socialIdFrom } from '../lib/videoLinks';
import {
  AddOutlineIcon as Plus, ArrowUpOutlineIcon as ArrowUp,
  CloseCircleOutlineIcon as X, ClapperboardOpenOutlineIcon as Film, GalleryOutlineIcon as ImageIcon,
  CopyOutlineIcon as Copy, HistoryOutlineIcon as History,
  StopOutlineIcon as Stop, RestartOutlineIcon as Restart, PenNewSquareOutlineIcon as NewChat,
} from '@solar-icons/react';
import { Check } from './BrandIcons';
import { FUNCTIONS_URL, supabase, getSessionToken, getUserId, fetchWithRetry, isAbort } from '../lib/supabase';
import { ErrorNotice } from './ErrorNotice';
import { Collapse } from './Page';
import { useUsage, CREDIT_COSTS } from '../lib/useUsage';
import {
  loadThreadMessages, takeRequestedThread, requestHistory, type ThreadAnalysis,
} from '../lib/projects';
import { uploadChatImages, signChatImages } from '../lib/chatImages';
import { take, PENDING_CHAT_KEY } from '../lib/intents';
import { openRetention } from '../lib/retention';


// Defined next to the table it is stored in - see lib/projects.ts. The chat
// used to declare its own copy, so a row read back out of the database was
// typed `any` and nothing checked that the two still agreed.
type Analysis = ThreadAnalysis;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  analysis?: Analysis | null;
  // Set on messages that arrived while watching, cleared on messages loaded
  // out of the database. Only the first kind animates in or reveals itself:
  // replaying twenty of them when a saved conversation opens is not a
  // conversation arriving, it is a page flickering.
  fresh?: boolean;
  // Screenshots sent with this message, ready to render: data URLs while the
  // message is live, signed storage URLs once it comes back out of the
  // database. The files themselves go to the chat-images bucket, so a reopened
  // conversation still has the evidence the answer was about.
  images?: string[];
}

const extractVideoId = (input: string): string | null => {
  const social = socialIdFrom(input);
  if (social) return social;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  return s.match(/(?:shorts\/|v=|youtu\.be\/|embed\/)([\w-]{11})/)?.[1] ?? null;
};

const uid = () => Math.random().toString(36).slice(2);

// An upload is watched by the same model as a link, so what it accepts is what
// Gemini accepts, and the ceiling is the one the edge proxy was built against.
// Checked on the way in rather than after the file has been sent: a 2GB pick
// that fails on arrival costs the wait twice.
const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'];
const MAX_SIZE_MB = 300;
const MAX_SHORT_SECONDS = 180;

// A local file's length from its metadata. null when the browser cannot read
// it, in which case the upload goes ahead rather than blocking a real Short.
const videoSeconds = (f: File): Promise<number | null> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const v = document.createElement('video');
    const done = (n: number | null) => { URL.revokeObjectURL(url); resolve(n); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });

// A screenshot is the other thing people arrive with. Someone asking why a
// video got 0 views has the answer on their Studio screen, not in a link, and
// no API hands that number over: YouTube shows the Shorts swipe-away rate in
// Studio and exposes nothing like it. So the picture IS the data.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_MB = 5;
// Matches the ceiling in _shared/images.ts. A question about a channel is
// rarely one screen - the retention curve and the traffic sources are two -
// but past a handful it stops being evidence and starts being a folder.
const MAX_IMAGES = 4;

const isImage = (f: File) => IMAGE_TYPES.includes(f.type);

// How tall the composer is allowed to grow before it scrolls instead.
const MAX_COMPOSER_PX = 200;

const validateFile = (f: File): string => {
  if (isImage(f)) {
    return f.size > MAX_IMAGE_MB * 1024 * 1024
      ? `Screenshot too large. Maximum size is ${MAX_IMAGE_MB}MB.`
      : '';
  }
  if (ACCEPTED_TYPES.includes(f.type) || f.name.match(/\.(mp4|mov|webm|avi)$/i)) {
    return f.size > MAX_SIZE_MB * 1024 * 1024
      ? `File too large. Maximum size is ${MAX_SIZE_MB}MB.`
      : '';
  }
  return 'Send a video (MP4, MOV, WebM, AVI) or a screenshot (PNG, JPG, WebP).';
};

// Read once, use twice: the base64 half goes to the model, the whole data URL
// is what the message bubble shows. An object URL would need revoking and
// would give the bubble nothing the data URL does not already have.
const readDataUrl = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Could not read that file'));
  r.readAsDataURL(f);
});

const toImageParts = async (shots: File[]) =>
  Promise.all(shots.map(async f => {
    const dataUrl = await readDataUrl(f);
    return { mimeType: f.type, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }));

const formatSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
};

// A message that carried screenshots was stored with a "[screenshot]" tag in
// front of it, because the pictures themselves were not kept and the thread
// needed some record that they had been sent. They are kept now, so the tag is
// the caption on a photograph that is right there.
const stripShotTag = (s: string) => s.replace(/^\[\d*\s*screenshots?\]\s*/i, '');

// ─── Failures ────────────────────────────────────────────────────────────────

// Three kinds, because three different things have gone wrong and only one of
// them is ours.
//
//   input   - they sent something this cannot take (a 400, a file too big).
//             Their move, said plainly, no apology and no Discord link.
//   credits - the balance ran out (a 403). Nothing is broken; there is a price
//             and a button.
//   server  - everything else. Ours to fix, and worth another try.
//
// Before this there was one `error` string and every one of them rendered as
// ErrorNotice: "Something went wrong on our end, send this to our Discord."
// Being told to file a bug report because a script was 200 characters too long
// is the product blaming itself for reading its own rules.
type FailKind = 'input' | 'credits' | 'server';

interface Failure {
  kind: FailKind;
  message: string;
  // Set on the failures worth another attempt. Re-runs the exact call that
  // failed without putting the message on screen a second time.
  retry?: () => void;
}

class RunError extends Error {
  kind: FailKind;
  constructor(kind: FailKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// 403 is the credit gate in every function here; 400 and 413 are the input
// checks. Anything else answered badly or did not answer.
const failOf = (status: number, message: string): RunError =>
  new RunError(status === 403 ? 'credits' : status === 400 || status === 413 ? 'input' : 'server', message);

const asFailure = (e: unknown, retry?: () => void): Failure => {
  const message = e instanceof Error ? e.message : 'Something went wrong';
  const kind = e instanceof RunError ? e.kind : 'server';
  // A retry is offered only where trying again could plausibly work. Sending
  // the same too-long script again is not a fix, and neither is spending
  // credits that are already gone.
  return { kind, message, retry: kind === 'server' ? retry : undefined };
};

// ─── Surviving a tab switch ──────────────────────────────────────────────────

// Module scope, deliberately: it outlives the component, which unmounts every
// time the sidebar moves to another tab, and it dies with the page, which is
// exactly the rule asked for. Step out to Ideas and back and the conversation
// is where it was; reload, or come back to the site tomorrow, and Analyze
// opens clean.
//
// localStorage would keep it too well - it would greet every visit with last
// week's half-finished thread - and sessionStorage survives a reload, which is
// the one thing this must not do.
interface SessionCache {
  messages: Message[];
  threadId: string | null;
}
let session: SessionCache | null = null;

// The side panel runs one conversation per Short: pressing Analyze on the next
// one should start clean, not append to whatever the cache is holding.
export function resetAnalysisSession() {
  session = null;
}

// Whether the embedding sync has already been kicked off this page load.
let syncedThisLoad = false;

// ─── Small parts ─────────────────────────────────────────────────────────────

// Copying is the whole point of half of what this screen produces. Three
// rewritten hooks that have to be retyped by hand off the screen are three
// suggestions; with this they are three hooks.
function CopyButton({ text, title = 'Copy', className = '' }: { text: string; title?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable - the text is still selectable */ }
  };

  return (
    <button
      onClick={copy}
      title={title}
      aria-label={title}
      className={`p-1.5 rounded-lg transition-colors hover:text-[var(--text)] ${className}`}
      style={{ color: copied ? 'var(--text)' : 'var(--text-faint)' }}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// The review as something that can live outside this page - in a doc, in a
// message to an editor. Same order it is read in on screen.
const analysisAsText = (a: Analysis) => [
  a.overall_score != null ? `${a.overall_score}/100` : '',
  a.overall_assessment ?? '',
  a.strong_spots?.length ? `Working\n${a.strong_spots.map(s => `- ${s}`).join('\n')}` : '',
  a.weak_spots?.length ? `Fix\n${a.weak_spots.map(s => `- ${s}`).join('\n')}` : '',
  a.rewrites?.length ? `Use instead\n${a.rewrites.map(r => `- ${r.hook}${r.why ? ` (${r.why})` : ''}`).join('\n')}` : '',
].filter(Boolean).join('\n\n');

// A review is a message now, not a scorecard. What the creator reads is the
// short reply the model wrote after watching; every fix it found is still
// there, one quiet press away, and in the context the follow-ups answer from.
// The out-of-100 score was dropped on 2026-09-29 - old threads that carry one
// simply do not show it.
function ReviewMessage({ a, fresh, onAdvance }: { a: Analysis; fresh?: boolean; onAdvance?: () => void }) {
  const [open, setOpen] = useState(false);
  const fixes = a.weak_spots ?? [];
  const keep = a.strong_spots ?? [];
  const lines = a.rewrites ?? [];
  const more = fixes.length + keep.length + lines.length;

  return (
    <div className="flex flex-col items-start gap-1">
      {a.overall_assessment && (
        <div
          className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-line break-words"
          style={{ background: 'var(--bg-raised)', color: 'var(--text)' }}
        >
          {fresh ? <RevealText text={a.overall_assessment} onAdvance={onAdvance ?? (() => {})} /> : a.overall_assessment}
        </div>
      )}
      <div className="flex items-center gap-3 -ml-1">
        {a.overall_assessment && <CopyButton text={analysisAsText(a)} title="Copy this review" />}
        {/* Their own Short has a measured curve: the second people left and
            what was said there, one press from the review that talks about it. */}
        {a.ownership === 'mine' && a.video_id && (
          <button
            onClick={() => openRetention(a.video_id)}
            className="t-small transition-colors hover:text-[var(--text)]"
            style={{ color: 'var(--text-faint)' }}
          >
            See where people left
          </button>
        )}
        {more > 0 && (
          <button
            onClick={() => setOpen(o => !o)}
            className="t-small transition-colors hover:text-[var(--text)]"
            style={{ color: 'var(--text-faint)' }}
            aria-expanded={open}
          >
            {open ? 'Hide' : `See all ${fixes.length || more} ${fixes.length === 1 ? 'fix' : 'fixes'}`}
          </button>
        )}
      </div>
      <Collapse open={open} className="max-w-[85%] w-full">
        <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--bg-raised)' }}>
          {fixes.length > 0 && (
            <ul className="space-y-2">
              {fixes.map((f, i) => <li key={i} className="t-small" style={{ color: 'var(--text)' }}>{f}</li>)}
            </ul>
          )}
          {keep.length > 0 && (
            <>
              <p className="t-label mt-4 mb-1.5" style={{ color: 'var(--text-muted)' }}>Keep</p>
              <ul className="space-y-2">
                {keep.map((f, i) => <li key={i} className="t-small" style={{ color: 'var(--text-muted)' }}>{f}</li>)}
              </ul>
            </>
          )}
          {lines.length > 0 && (
            <ul className="space-y-2 mt-4">
              {lines.map((r, i) => (
                <li key={i} className="flex items-start gap-2">
                  <p className="t-small flex-1" style={{ color: 'var(--text)' }}>{r.hook}</p>
                  <CopyButton text={r.hook} title="Copy this hook" className="flex-shrink-0 -mt-1" />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Collapse>
    </div>
  );
}

// What the run is actually doing, in the order it does it. analyze-with-gemini
// fetches the video, has the model watch it, then has it score what it saw; the
// text checks read, compare, then write. So the sequence is real - what is
// estimated is the timing, because a single opaque request cannot report its
// own progress. Stages therefore advance on elapsed time and the last one holds
// until the answer lands, rather than pretending to finish.
const STAGES: Record<string, string[]> = {
  video: ['Fetching the video', 'Watching it through', 'Marking the hook and the drop', 'Writing what to fix'],
  // An upload is the one run with a step that reports itself: the bytes are
  // either still going or they are not. So it does not guess at that half -
  // one line holds until the file is over - and only then falls back to the
  // timed stages, which are the link run's minus the fetch it does not do.
  uploading: ['Sending the file over'],
  screenshot: ['Reading the screenshot', 'Working out what happened'],
  upload: ['Waiting on the file to process', 'Watching it through', 'Marking the hook and the drop', 'Writing what to fix'],
  followup: ['Rereading the review', 'Answering'],
  // Shown while the message is still being worked out. It has to be honest
  // about not knowing yet: "Fetching the video" under a typed question was
  // the line telling everyone the product had misread them before the
  // scored-out-of-100 reply confirmed it. If this turns out to be a hook or
  // a script, the stage switches when the real run starts.
  question: ['Reading what you sent', 'Thinking'],
};

const STAGE_MS = 3800;

function Working({ kind, onStop }: { kind: keyof typeof STAGES; onStop: () => void }) {
  const stages = STAGES[kind] ?? STAGES.video;
  const [at, setAt] = useState(0);
  const [shown, setShown] = useState(true);

  // Fade the line out, swap the words while nothing is visible, fade back in.
  // Swapping the text in place made each stage change read as a glitch rather
  // than as progress, and the shimmer running over it did not soften that -
  // the words simply became different words between two frames.
  useEffect(() => {
    setAt(0);
    setShown(true);
    let swap: ReturnType<typeof setTimeout>;
    const t = setInterval(() => {
      setAt(i => {
        if (i >= stages.length - 1) return i;
        setShown(false);
        swap = setTimeout(() => setShown(true), 220);
        return i + 1;
      });
    }, STAGE_MS);
    return () => { clearInterval(t); clearTimeout(swap); };
  }, [kind]);

  // Seconds since the run started, so the minute a video takes reads as
  // progress rather than as a hang.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Esc stops the run, the way it does in a terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onStop(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStop]);

  // Stop is a line of small text under what is happening, not a button beside
  // it: a chip there competed with the one line worth reading while it runs.
  return (
    <div className="animate-msg-in">
      <p className="text-[14px] font-medium" aria-live="polite">
        <span
          className="text-working inline-block transition-opacity duration-200"
          style={{ opacity: shown ? 1 : 0 }}
        >
          {stages[at]}
        </span>
      </p>
      <p className="font-mono text-[11px] mt-1.5 tabular-nums" style={{ color: 'var(--text-faint)' }}>
        {elapsed}s ·{' '}
        <button onClick={onStop} title="Stop this run" className="transition-colors hover:text-[var(--text)] underline-offset-2 hover:underline">
          esc to stop
        </button>
      </p>
    </div>
  );
}

// How long the whole reveal takes, however long the answer is. A per-word rate
// reads fine on two sentences and becomes a wait on twenty.
const REVEAL_MS = 900;
// Scrolling on every frame of the reveal is what made the first version of this
// take twice its own duration, so the follow is throttled well below 60fps. The
// eye cannot tell; setInterval could.
const FOLLOW_MS = 120;

// Reveals an answer that has ALREADY fully arrived, a few words at a time.
//
// This is not streaming and does not pretend to be: the request is finished
// before the first word shows, so it saves nobody any waiting. What it fixes is
// that a finished block of text appearing between two frames is both a jolt and
// genuinely ambiguous - there is no moment in it that reads as "it stopped".
// The caret supplies that moment by going out.
//
// Real streaming would be the better answer and is a different job: callLLM is
// a single-shot helper over three providers, so it means an SSE path through
// each of them plus a reader on this end.
function RevealText({ text, onAdvance }: { text: string; onAdvance: () => void }) {
  // Split on whitespace but KEEP it, so the reveal never reflows the paragraph
  // - dropping the separators would re-wrap every line as words land.
  const parts = useMemo(() => text.split(/(\s+)/), [text]);
  const [shown, setShown] = useState(0);

  // Driven by elapsed time on rAF, not by a word count on a timer. A timer
  // assumes every tick costs nothing, and these ticks re-render the thread and
  // move the scroll, so the interval slipped to two or three times its nominal
  // rate and a 900ms reveal took a little over two seconds. Reading the clock
  // means the reveal lasts REVEAL_MS whatever the frames cost.
  useEffect(() => {
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setShown(parts.length); return; }

    setShown(0);
    let raf = 0;
    let lastFollow = 0;
    const started = performance.now();

    const frame = (now: number) => {
      const progress = Math.min(1, (now - started) / REVEAL_MS);
      setShown(Math.max(1, Math.ceil(progress * parts.length)));
      if (now - lastFollow > FOLLOW_MS) { lastFollow = now; onAdvance(); }
      if (progress < 1) raf = requestAnimationFrame(frame);
      else onAdvance();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [parts]);

  const done = shown >= parts.length;
  return (
    <>
      {parts.slice(0, shown).join('')}
      {!done && <span className="reveal-caret" aria-hidden="true" />}
    </>
  );
}

export function AnalysisChat() {
  // Lazily seeded from the session cache, not restored in an effect: an effect
  // would render the empty hero for one frame first, and coming back to a tab
  // should look like returning to it rather than like it reloading.
  const [messages, setMessages] = useState<Message[]>(
    () => session?.messages.map(m => ({ ...m, fresh: false })) ?? [],
  );
  const [threadId, setThreadId] = useState<string | null>(() => session?.threadId ?? null);
  const [composer, setComposer] = useState('');
  // The idea a conversation opened from a script is about (see the pending
  // chat handoff below); sent with each message so the chat has its script.
  const ideaRef = useRef<string | null>(null);
  // The same for one of their own Shorts, opened from the retention screen:
  // its measured curve goes with each message (chat-followup).
  const videoRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which pipeline is running, so the working line can name its actual stages.
  const [busyKind, setBusyKind] = useState<keyof typeof STAGES>('video');
  const [failure, setFailure] = useState<Failure | null>(null);
  // Set when a run was stopped by hand, cleared by the next send. Its own state
  // rather than a Failure: nothing went wrong.
  const [stopped, setStopped] = useState(false);
  // Opening a saved conversation is not a run, so it gets no stage line and no
  // stop button - but the screen still has to say it is doing something rather
  // than showing the empty hero for the length of two queries.
  const [opening, setOpening] = useState(false);
  // A list, not one. A video and the screenshot of its retention curve are one
  // message, and so are two screenshots of the same channel.
  const [files, setFiles] = useState<File[]>([]);
  // Reloaded after every send, so the count under the composer is the balance
  // as of the last thing that was actually charged.
  const { usage, reload: reloadUsage } = useUsage();

  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The conversation's own scroller. scrollIntoView used to do this, and it
  // scrolls EVERY ancestor that can scroll - including AppShell's <main> and
  // the side panel's frame - so each new message nudged the whole screen down
  // and clipped the History / New chips at the edges. Scrolling this one box moves nothing else.
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The run in flight, so Stop has something to pull on. One at a time by
  // construction: the composer is disabled while a run is going.
  const abortRef = useRef<AbortController | null>(null);

  // Instant, not smooth, when called from the reveal: a smooth scroll retriggered
  // every 28ms never settles, and the page ends up crawling behind the text.
  const scrollToEnd = (behavior: ScrollBehavior = 'auto') => {
    const box = scrollRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior });
  };

  useEffect(() => { scrollToEnd('smooth'); }, [messages, busy]);

  // Keeps the creator's own work searchable by meaning, once per page load.
  //
  // Fire and forget, and nothing waits on it: the chat's lookup tools fall back
  // to matching on words, so a slow or failed sync costs recall and never an
  // answer. Module-scope flag rather than an effect guard, because this
  // component remounts on every tab switch and once a visit is enough.
  useEffect(() => {
    if (syncedThisLoad) return;
    syncedThisLoad = true;
    (async () => {
      try {
        const token = await getSessionToken();
        if (!token) return;
        await fetch(`${FUNCTIONS_URL}/sync-embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
      } catch { /* housekeeping - the chat works without it */ }
    })();
  }, []);

  // Kept in module scope so a tab switch does not throw the conversation away.
  // An empty screen is remembered as nothing at all, which is what makes New
  // stay new: leaving a cleared state cached would restore it on the way back.
  useEffect(() => {
    session = messages.length || threadId ? { messages, threadId } : null;
  }, [messages, threadId]);

  // Everything a saved conversation needs to come back: the messages, the
  // project it is filed under, and signed URLs for the screenshots that went
  // into it. One signing call covers the whole thread rather than one per
  // message.
  const openThread = async (id: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpening(true);
    setBusy(false);
    setFailure(null);
    setStopped(false);
    try {
      const rows = await loadThreadMessages(id);
      const signed = await signChatImages(rows.flatMap(r => r.images ?? []));

      setThreadId(id);
      setMessages(rows.map(r => {
        const shots = (r.images ?? []).map(p => signed[p]).filter(Boolean);
        // Old scored hook and script results stored a label ("Read that as a
        // hook") as their content. The label is dropped; the review stays.
        const isLabel = !!r.analysis && /^Read that as a (hook|script)$/.test((r.content ?? '').trim());
        return {
          id: r.id,
          role: r.role,
          content: isLabel ? '' : (shots.length ? stripShotTag(r.content) : r.content),
          analysis: r.analysis ?? null,
          images: shots.length ? shots : undefined,
        };
      }));
    } finally {
      setOpening(false);
    }
  };

  // What this screen opens with, decided once on mount.
  //
  // Two things can be waiting, both one-shot handoffs cleared as they are read:
  // a conversation filed in a project that was just clicked, and a link pasted
  // on the landing page before signing up. An explicit click wins if somehow
  // both are set, and either beats whatever the session cache is holding -
  // asking for a specific thread is asking to leave the current one.
  //
  // The pending link was HookAnalysis's job, and when Analyze became a
  // conversation nothing took it over. So the one path the entire hero exists
  // to drive - paste a link, sign up, see the review - ended on an empty
  // composer with the link dropped on the floor. It survives onboarding too:
  // whether the profile questions are skipped or answered, this screen mounts
  // afterwards and the link is still there to be run.
  useEffect(() => {
    const requested = takeRequestedThread();
    const pending = localStorage.getItem('chumoku_pending_video_url');
    // Cleared before anything awaits, so a double mount cannot spend the
    // credits twice.
    if (pending) localStorage.removeItem('chumoku_pending_video_url');

    if (requested) { openThread(requested); return; }

    // "Write the script" from an idea. The sender cleared the session cache,
    // so this is a fresh conversation and the idea is found by the chat's own
    // lookup, the same as if they had typed it.
    const message = take(PENDING_CHAT_KEY);
    if (message) {
      try {
        const { text, ideaId, videoId, draft } = JSON.parse(message) as { text: string; ideaId?: string; videoId?: string; draft?: boolean };
        // "Continue in Chat" from a written script: the idea rides along with
        // every message of this conversation, and the opener waits in the
        // composer, so opening the chat never spends a credit on its own.
        if (draft) {
          ideaRef.current = ideaId ?? null;
          videoRef.current = videoId ?? null;
          setComposer(text);
          return;
        }
        routeMessage(text, { ideaId, videoId });
      } catch {
        routeMessage(message);
      }
      return;
    }

    if (!pending) return;
    const videoId = extractVideoId(pending);
    // A link that does not resolve goes into the composer rather than being
    // thrown away. They typed it; they should still see it.
    if (videoId) runAnalysis(videoId, [], '', pending);
    else setComposer(pending);
  }, []);

  const push = (m: Omit<Message, 'id'>) => setMessages(prev => [...prev, { ...m, id: uid(), fresh: true }]);

  const persist = async (
    tid: string, role: 'user' | 'assistant', content: string,
    analysis?: Analysis, imagePaths?: string[],
  ) => {
    const userId = await getUserId();
    if (!userId) return;
    // `images` is only sent when there are some. The column is added by a
    // migration applied by hand against this project, and an insert naming a
    // column that does not exist fails - so an ordinary message keeps working
    // on a database that has not had the migration yet, and screenshots start
    // being kept the moment it does.
    await supabase.from('chat_messages').insert({
      thread_id: tid, user_id: userId, role, content, analysis: analysis ?? null,
      ...(imagePaths?.length ? { images: imagePaths } : {}),
    });
  };

  const startThread = async (title: string) => {
    const userId = await getUserId();
    if (!userId) return null;
    const { data } = await supabase
      .from('chat_threads').insert({ user_id: userId, title }).select('id').single();
    return data?.id ?? null;
  };

  // Every run starts here: one controller, the previous failure cleared, and a
  // signal that Stop can pull.
  const beginRun = (kind: keyof typeof STAGES) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusyKind(kind);
    setBusy(true);
    setFailure(null);
    setStopped(false);
    return controller.signal;
  };

  const endRun = (controller?: AbortSignal) => {
    // Only the run that is still the current one clears the flag. A stop
    // followed immediately by a new send must not have the old run's finally
    // block turn the new one's spinner off.
    if (!controller || abortRef.current?.signal === controller) {
      abortRef.current = null;
      setBusy(false);
    }
  };

  // Aborting the request stops the answer arriving; it does not reach into the
  // edge function and stop it finishing. So this says what it can honestly say
  // and then reloads the balance, rather than promising a refund it does not
  // control.
  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStopped(true);
    reloadUsage();
  };

  // The thread is over, not deleted. It is already in the database and already
  // in the hub's history, so New is a clean screen rather than a loss.
  const newChat = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    session = null;
    setMessages([]);
    setThreadId(null);
    ideaRef.current = null;
    videoRef.current = null;
    setFiles([]);
    setComposer('');
    setFailure(null);
    setStopped(false);
    setBusy(false);
    setOpening(false);
  };

  const runAnalysis = async (
    videoId: string, shots: File[], context: string, shownText: string,
    { pushed = false, stored = false }: { pushed?: boolean; stored?: boolean } = {},
  ) => {
    const signal = beginRun('video');
    if (!pushed) push({ role: 'user', content: shownText });

    let title = '';
    try {
      if (!isSocialId(videoId)) {
        const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (r.ok) title = (await r.json()).title ?? '';
      }
    } catch { /* title is a nicety, not a requirement */ }

    // Stop pressed while the title was being fetched. Bail before a thread is
    // opened for it: an empty conversation in the history is a record of
    // something that never happened.
    if (signal.aborted) { endRun(signal); return; }

    // Reuse the thread if the conversation already started - a question can
    // come before the first link now, and starting a second thread here would
    // orphan everything said up to this point.
    const tid = threadId ?? await startThread(title || shownText.slice(0, 60));
    setThreadId(tid);
    if (tid && !stored) await persist(tid, 'user', shownText);

    try {
      const token = await getSessionToken();
      if (!token) throw new RunError('server', 'Not authenticated');
      const res = await fetchWithRetry(`${FUNCTIONS_URL}/analyze-with-gemini`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, videoContext: context, images: await toImageParts(shots) }),
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw failOf(res.status, data.error || 'Analysis failed');

      const a: Analysis = {
        overall_score: data.analysis?.hook_analysis?.overall_score,
        overall_assessment: data.analysis?.hook_analysis?.overall_assessment,
        strong_spots: data.analysis?.strong_spots ?? [],
        weak_spots: data.analysis?.weak_spots ?? [],
        // Whose video it is. Computed by the analyser since the ownership
        // check was built, returned in this very response, and dropped on the
        // floor by this client until now - which is why the chat could
        // congratulate someone on a competitor's score.
        ownership: data.analysis?.hook_analysis?.ownership ?? 'unknown',
        video_id: videoId,
      };
      push({ role: 'assistant', content: '', analysis: a });
      if (tid) {
        await persist(tid, 'assistant', '', a);
        await supabase.from('chat_threads').update({ analysis_id: data.analysis?.id }).eq('id', tid);
      }
      reloadUsage();
      // App defers onboarding for anyone who arrived by pasting a link on the
      // landing page, and puts the offer up when their first result lands. That
      // event was dispatched by HookAnalysis and by nothing since.
      window.dispatchEvent(new CustomEvent('chumoku:analysis-done'));

      // A link almost never arrives alone. "is this good to replicate for my
      // niche?" went in as videoContext, which is the field for facts ABOUT the
      // video, so the question was read as a description of it and answered
      // with a polish score for someone else's upload - a real answer to a
      // question nobody asked. The review still runs, because watching is the
      // expensive part and it is what makes the answer worth anything, and the
      // question is then answered against it.
      // Whatever came with the link goes to the model too, always. It decides
      // whether that was a question worth answering, an instruction already
      // carried out, or a hook to score - which is the same judgement it makes
      // on every other message, and a better one than a question mark.
      if (tid && context.trim()) await routeMessage(context.trim(), { silent: true, tid });

    } catch (e) {
      if (isAbort(e)) return;
      reloadUsage();
      setFailure(asFailure(e, () => runAnalysis(videoId, shots, context, shownText, { pushed: true, stored: true })));
    } finally {
      endRun(signal);
    }
  };

  // The creator's own footage, before it is anyone else's video. Same review as
  // a link and the same price; three requests instead of one, because the file
  // has to exist somewhere the model can watch it first: open a resumable
  // session, stream the bytes to it through the edge proxy, then analyze what
  // landed.
  //
  // All of that already worked - it is what the Analyze panel did before this
  // screen was a conversation, and nothing carried it over. The paperclip has
  // been attaching files to a submit() that only ever read the textarea, so the
  // plate showed the name, the send button stayed disabled, and the file went
  // nowhere. This is the wire that was missing, not new machinery.
  const runUpload = async (
    f: File, shots: File[], context: string, shownText: string,
    { pushed = false, stored = false }: { pushed?: boolean; stored?: boolean } = {},
  ) => {
    const signal = beginRun('uploading');
    if (!pushed) push({ role: 'user', content: shownText });

    const title = f.name.replace(/\.[^.]+$/, '');
    const tid = threadId ?? await startThread(title || f.name);
    setThreadId(tid);
    if (tid && !stored) await persist(tid, 'user', shownText);

    try {
      const token = await getSessionToken();
      if (!token) throw new RunError('server', 'Not authenticated');
      const mimeType = f.type || 'video/mp4';

      // Same Shorts-only rule the link path enforces on the server, checked
      // here before a single byte goes up.
      const seconds = await videoSeconds(f);
      if (seconds != null && seconds > MAX_SHORT_SECONDS) {
        throw new RunError('input', 'This works on Shorts only. That video is longer than 3 minutes.');
      }

      const sessionRes = await fetchWithRetry(`${FUNCTIONS_URL}/get-upload-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: f.name, fileSize: f.size, mimeType }),
        signal,
      });
      const uploadSession = await sessionRes.json();
      if (!sessionRes.ok || !uploadSession.uploadUrl) {
        throw failOf(sessionRes.status, uploadSession.error || 'Could not start the upload');
      }

      // Plain fetch, not fetchWithRetry: the body is the file. Retrying a
      // failed send means pushing every byte again, twice over a bad
      // connection, which is slower than telling them it did not go.
      const uploadRes = await fetch(`${FUNCTIONS_URL}/upload-video-chunk`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mimeType,
          'X-Upload-Url': uploadSession.uploadUrl,
          'X-Upload-Offset': '0',
          'X-Is-Last': 'true',
        },
        body: f,
        signal,
      });
      const uploaded = await uploadRes.json();
      if (!uploadRes.ok || !uploaded.geminiFileName) {
        throw failOf(uploadRes.status, uploaded.error || 'Upload failed');
      }

      // The bytes are over. What is left is the wait a link gets, so the stage
      // line switches to the stages that are now actually running.
      setBusyKind('upload');

      const res = await fetchWithRetry(`${FUNCTIONS_URL}/analyze-upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geminiFileName: uploaded.geminiFileName,
          videoContext: context,
          fileName: f.name,
          mimeType,
          images: await toImageParts(shots),
        }),
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw failOf(res.status, data.error || 'Analysis failed');

      const a: Analysis = {
        overall_score: data.analysis?.hook_analysis?.overall_score,
        overall_assessment: data.analysis?.hook_analysis?.overall_assessment,
        strong_spots: data.analysis?.strong_spots ?? [],
        weak_spots: data.analysis?.weak_spots ?? [],
        // Whose video it is. Computed by the analyser since the ownership
        // check was built, returned in this very response, and dropped on the
        // floor by this client until now - which is why the chat could
        // congratulate someone on a competitor's score.
        ownership: data.analysis?.hook_analysis?.ownership ?? 'unknown',
      };
      push({ role: 'assistant', content: '', analysis: a });
      if (tid) {
        await persist(tid, 'assistant', '', a);
        await supabase.from('chat_threads').update({ analysis_id: data.analysis?.id }).eq('id', tid);
      }
      reloadUsage();
      window.dispatchEvent(new CustomEvent('chumoku:analysis-done'));

      // Whatever was typed alongside the file goes to the model after the
      // review, exactly as it does alongside a link: videoContext is the field
      // for facts about the footage, and a question dropped in there comes back
      // answered as a description of it.
      if (tid && context.trim()) await routeMessage(context.trim(), { silent: true, tid });

    } catch (e) {
      if (isAbort(e)) return;
      reloadUsage();
      setFailure(asFailure(e, () => runUpload(f, shots, context, shownText, { pushed: true, stored: true })));
    } finally {
      endRun(signal);
    }
  };

  // Sends the message to the chat and renders whatever comes back.
  //
  // There is no classifier on the other end. One model answers, and it can
  // look things up in this creator's account while it does.
  //
  // There was no router before this: anything without a link went straight to
  // a hook or script check on the strength of "is it longer than 200
  // characters". Typing "why did my last short flop?" came back as a score out
  // of 100 against the question itself. The judgement now happens server-side,
  // in the same call that writes the answer, so a question costs one round
  // trip and a hook costs one cheap call before the real run.
  //
  // `silent` is for the text that came attached to a link: it is already on
  // screen inside the message that carried the link, and pushing it again would
  // show the creator saying it twice. `tid` is passed by that caller because
  // the thread was created moments earlier and setThreadId has not landed in
  // this closure yet.
  const routeMessage = async (
    text: string,
    { silent = false, tid, images, previews, shots, ideaId, videoId }: {
      silent?: boolean; tid?: string | null;
      images?: { mimeType: string; base64: string }[]; previews?: string[]; shots?: File[];
      // The saved idea this message is about, when it came from an idea's
      // "Write the script" step: the server reads the outline itself rather
      // than hoping a lookup by name finds the right one.
      ideaId?: string;
      // One of their own Shorts, from the retention screen.
      videoId?: string;
    } = {},
  ) => {
    const thread = tid ?? threadId;
    // Vague until the server says otherwise - see STAGES.question. With a
    // review already on screen the call still classifies, but it is reading
    // that review to do it, so the line can say so.
    const signal = beginRun(images?.length ? 'screenshot' : hasResult ? 'followup' : 'question');
    if (!silent) push({ role: 'user', content: text, images: previews });

    try {
      const token = await getSessionToken();
      if (!token) throw new RunError('server', 'Not authenticated');
      const res = await fetchWithRetry(`${FUNCTIONS_URL}/chat-followup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread, question: text, images, ideaId, videoId }),
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw failOf(res.status, data.error || 'Could not read that');

      push({ role: 'assistant', content: data.answer });

      // The server only persists into a thread that already exists, because
      // until now there was nothing worth keeping. A question can open a
      // conversation, so this is where that thread gets made.
      const opened = thread ?? await startThread(text.slice(0, 60) || 'Screenshot');
      if (!thread && opened) {
        setThreadId(opened);
        // Tagged the same way chat-followup tags it when it does the writing,
        // so both paths store the same shape. The tag is still worth writing
        // now that the pictures are kept: keeping them can fail (an older
        // database has no bucket), and the transcript should say a screenshot
        // was sent either way. stripShotTag takes it back off whenever the
        // images did survive.
        const tag = (images?.length ?? 0) > 1 ? `[${images!.length} screenshots]` : '[screenshot]';
        await persist(opened, 'user', images?.length ? `${tag} ${text}`.trim() : text);
        await persist(opened, 'assistant', data.answer);
      }

      // The screenshots are kept once the message they belong to exists. On a
      // thread the server wrote into, that row is the newest user message -
      // it was inserted moments ago by the call that just returned, and
      // nothing else writes into a thread while a run is in flight.
      if (opened && shots?.length) await keepShots(opened, shots);

      reloadUsage();
    } catch (e) {
      if (isAbort(e)) return;
      // No falling back to the old length heuristic. Guessing "hook" on a
      // failed route is the exact behaviour being fixed, and it would spend
      // their credits to do the wrong thing. fetchWithRetry has already
      // ridden out anything transient by the time this runs.
      reloadUsage();
      setFailure(asFailure(e, () => routeMessage(text, { silent: true, tid, images, previews, shots, ideaId, videoId })));
    } finally {
      endRun(signal);
    }
  };

  // Files the screenshots against the user message they were sent with. All of
  // it fails soft: the bucket and the column are added by a migration applied
  // by hand, and a conversation must not break on a database that has not had
  // it yet - it simply keeps behaving as it did, with the pictures living only
  // as long as the tab.
  const keepShots = async (tid: string, shots: File[]) => {
    try {
      const paths = await uploadChatImages(tid, shots);
      if (!paths.length) return;
      const { data } = await supabase
        .from('chat_messages').select('id')
        .eq('thread_id', tid).eq('role', 'user')
        .order('created_at', { ascending: false }).limit(1);
      if (data?.[0]) await supabase.from('chat_messages').update({ images: paths }).eq('id', data[0].id);
    } catch (e) {
      console.error('[chat] keeping screenshots', e);
    }
  };

  // A screenshot goes to the chat, not to the video pipeline. It is an ordinary
  // message with a picture attached, so it routes and is charged like one.
  const askWithImages = async (shots: File[], text: string) => {
    let previews: string[];
    try {
      previews = await Promise.all(shots.map(readDataUrl));
    } catch {
      setFailure({
        kind: 'input',
        message: shots.length > 1 ? 'Could not read those screenshots.' : 'Could not read that screenshot.',
      });
      return;
    }
    const images = shots.map((f, i) => ({
      mimeType: f.type,
      base64: previews[i].slice(previews[i].indexOf(',') + 1),
    }));
    await routeMessage(text, { images, previews, shots });
  };

  // Whether the thread already has something to ask about. It decides both
  // what a send does and what it costs, so it is one value, read in both
  // places, rather than the same test written twice.
  const hasResult = messages.some(m => m.analysis);

  // What the next send will cost, as far as it can be known before it is sent.
  //
  // A video is 5 whether it is linked or uploaded. Everything else goes to the
  // router first, which charges a follow-up, and a hook or a script then costs
  // its own price on top - so a plain message is quoted at its floor rather
  // than at a guess. The floor is what the gate below needs: it is the point
  // at which a send cannot even be attempted.
  const nextCost = (() => {
    const text = composer.trim();
    if (files.some(f => !isImage(f))) return CREDIT_COSTS.video_analysis;
    const url = text.match(/https?:\/\/\S+/)?.[0] ?? text;
    if (text && extractVideoId(url)) return CREDIT_COSTS.video_analysis;
    return CREDIT_COSTS.chat_followup;
  })();

  const left = usage ? Math.max(0, usage.creditsLimit - usage.creditsUsed) : null;
  const broke = left != null && left < nextCost;

  const submit = () => {
    const text = composer.trim();
    if (busy || broke) return;

    // The attachments split into at most one video and the screenshots around
    // it. A video is the thing being reviewed; screenshots are evidence about
    // whatever is being reviewed, and on their own they are the whole message.
    const video = files.find(f => !isImage(f));
    const shots = files.filter(isImage);

    const url = text.match(/https?:\/\/\S+/)?.[0] ?? text;
    const videoId = text ? extractVideoId(url) : null;

    // Nothing typed and nothing attached.
    if (!video && !shots.length && !text) return;

    setFiles([]);
    setComposer('');
    setStopped(false);

    // Two rules, no exceptions to either. A link means watch that video. Every
    // other message is put to the model to be identified.
    //
    // What used to be here instead: a link was skipped if the thread already
    // had a review, then skipped again if that video had been seen before, and
    // the text beside it was only treated as a question when it contained a
    // question mark. Three guesses, each cheap, each wrong often enough that
    // the product stopped feeling dependable - which costs more than the credit
    // any of them saved.
    // An uploaded file beats a link in the same message: they attached the cut
    // they want looked at, and the link is something they were talking about.
    if (video) {
      const shown = [video.name, ...shots.map(s => s.name)].join('\n');
      runUpload(video, shots, text, text ? `${shown}\n\n${text}` : shown);
      return;
    }
    if (videoId) {
      runAnalysis(videoId, shots, text.replace(url, '').trim(), text);
      return;
    }
    // Screenshots with no video anywhere: the pictures are the question.
    if (shots.length) {
      askWithImages(shots, text);
      return;
    }
    routeMessage(text, { ideaId: ideaRef.current ?? undefined, videoId: videoRef.current ?? undefined });
  };



  const empty = messages.length === 0 && !opening;

  // What the next send costs, on screen before it is sent rather than
  // discovered afterwards on the Usage tab. Analyze took over Hook Lab and
  // Script Lab and then grew an open-ended conversation on top, so "one
  // analysis, one charge" stopped being true: a thread can run all afternoon.
  // Two numbers, not four. Everything the chat does to text - answer, score a
  // hook, score a script - is one credit; watching a video is the expensive
  // one and is the only exception worth printing.
  const priceLine = `${CREDIT_COSTS.chat_followup} a message, ${CREDIT_COSTS.video_analysis} a video`;

  // The balance is checked here, not only by the edge function. Finding out
  // the account is empty AFTER watching a stage line count through four steps
  // is the same information delivered at the worst possible moment.
  const Price = () => (
    broke ? (
      <p className="label-mono mt-2.5 text-center">
        <span style={{ color: 'var(--text)' }}>
          {left} left, {nextCost} needed
        </span>
        {' · '}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: 'upgrade' }))}
          className="underline underline-offset-2 hover:opacity-80"
          style={{ color: 'var(--text)' }}
        >
          Get more
        </button>
      </p>
    ) : (
      <p className="label-mono mt-2.5 text-center">
        {priceLine}
        {left != null && ` · ${left} left`}
      </p>
    )
  );

  // Flat ground, like every other tab: the grid that used to sit behind the
  // conversation is gone (see AppShell).
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* History is a door, not a drawer. The hub already lists every
          conversation with rename, delete and filing on each one; a second
          list in here would be the same work twice and would put a sidebar
          back on the one screen that is meant to be open space. */}
      <div className="flex-shrink-0 flex items-center justify-end gap-2 px-5 pt-4">
        <button onClick={requestHistory} className="chip" title="All your conversations">
          <History className="w-3.5 h-3.5" /> History
        </button>
        {!empty && (
          <button onClick={newChat} className="chip" title="Start a new conversation">
            <NewChat className="w-3.5 h-3.5" /> New
          </button>
        )}
      </div>

      {empty ? (
        <div className="flex-1 flex flex-col items-center justify-center px-5 pb-10">
          <h1 className="display mb-8 text-center" style={{ color: 'var(--text)' }}>What are we looking at?</h1>
          <div className="w-full max-w-2xl">
            <Composer
              value={composer} onChange={setComposer} onSubmit={submit} onStop={stop}
              busy={busy} blocked={broke}
              files={files} setFiles={setFiles} onFileError={m => setFailure(m ? { kind: 'input', message: m } : null)}
              fileRef={fileRef} taRef={taRef}
              placeholder="Paste a link, a hook or a script, or just ask"
            />
            <Price />

            {/* No starter chips under the box. They were four more things to
                read on an empty screen, wrapped badly in the side panel and on
                phones, and the chat no longer needs a keyword to route: the
                placeholder says what it takes. */}

            {/* The hero had nowhere to say no. Nothing could fail here before -
                a send left this screen immediately - but a file can be turned
                down before it is ever sent. */}
            {failure && <div className="mt-4"><FailureNotice failure={failure} onDismiss={() => setFailure(null)} /></div>}
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-5 pt-4 pb-8 space-y-6">
              {opening && !messages.length && (
                <div className="space-y-3">
                  <div className="h-3 w-32 rounded skeleton ml-auto" />
                  <div className="h-24 rounded-2xl skeleton" />
                </div>
              )}

              {messages.map(m => (
                m.role === 'user' ? (
                  <div key={m.id} className={`flex justify-end ${m.fresh ? 'animate-msg-in' : ''}`}>
                    <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-line break-words"
                         style={{ background: 'var(--bg-raised)', color: 'var(--text)' }}>
                      {!!m.images?.length && (
                        <div className={`flex flex-wrap gap-1.5 ${m.content ? 'mb-2' : ''}`}>
                          {m.images.map((src, i) => (
                            <img key={i} src={src} alt=""
                                 className="rounded-xl max-w-full w-auto"
                                 style={{ maxHeight: m.images!.length > 1 ? '9rem' : '18rem' }} />
                          ))}
                        </div>
                      )}
                      {m.content}
                    </div>
                  </div>
                ) : m.analysis ? (
                  <div key={m.id} className={`space-y-2 ${m.fresh ? 'animate-msg-in' : ''}`}>
                    {/* A chat answer that came with a card, from before the
                        score was dropped: the answer first, the review under. */}
                    {m.content && (
                      <div className="flex flex-col items-start gap-1">
                        <div
                          className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-line break-words"
                          style={{ background: 'var(--bg-raised)', color: 'var(--text)' }}
                        >
                          {m.fresh ? <RevealText text={m.content} onAdvance={() => scrollToEnd()} /> : m.content}
                        </div>
                      </div>
                    )}
                    <ReviewMessage a={m.analysis} fresh={m.fresh && !m.content} onAdvance={() => scrollToEnd()} />
                  </div>
                ) : (
                  /* On a plate, like the creator's own messages and like the
                     review card. Bare text floating between two bubbles read as
                     a system notice rather than as the other side of a
                     conversation. Alignment carries who is speaking; the plate
                     is the same either way.

                     --text, not --text-muted: this is the answer, the thing on
                     the screen worth reading, and muted is the weight for the
                     labels and captions around it. */
                  <div key={m.id} className={`flex flex-col items-start gap-1 ${m.fresh ? 'animate-msg-in' : ''}`}>
                    <div
                      className="max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-line break-words"
                      style={{ background: 'var(--bg-raised)', color: 'var(--text)' }}
                    >
                      {m.fresh
                        ? <RevealText text={m.content} onAdvance={() => scrollToEnd()} />
                        : m.content}
                    </div>
                    <CopyButton text={m.content} title="Copy this answer" className="-ml-1" />
                  </div>
                )
              ))}

              {busy && <Working kind={busyKind} onStop={stop} />}

              {/* Aborting the request is all the browser can do; the function
                  on the other end finishes on its own clock. Saying "stopped,
                  nothing charged" would be a refund this cannot promise. */}
              {stopped && !busy && (
                <p className="text-[13px]" style={{ color: 'var(--text-faint)' }}>
                  Stopped. If the run had already finished, it may still have been charged.
                </p>
              )}

              {failure && <FailureNotice failure={failure} onDismiss={() => setFailure(null)} />}
              <div ref={endRef} />
            </div>
          </div>

          <div className="flex-shrink-0 px-5 pb-5">
            <div className="max-w-2xl mx-auto">
              <Composer
                value={composer} onChange={setComposer} onSubmit={submit} onStop={stop}
                busy={busy} blocked={broke}
                files={files} setFiles={setFiles} onFileError={m => setFailure(m ? { kind: 'input', message: m } : null)}
                fileRef={fileRef} taRef={taRef}
                placeholder={hasResult ? 'Ask about the fixes, or send another link' : 'Ask anything, or send a link'}
              />
              <Price />
            </div>
          </div>
        </>
      )}

    </div>
  );
}

// A failure said in the register it belongs to. Only the third of these is the
// red "our fault, send it to Discord" plate, because only the third of them is.
function FailureNotice({ failure, onDismiss }: { failure: Failure; onDismiss: () => void }) {
  if (failure.kind === 'credits') {
    return (
      <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
           style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)' }}>
        <p className="text-[13px]" style={{ color: 'var(--text)' }}>{failure.message}</p>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: 'upgrade' }))}
          className="btn-primary text-[13px] px-3 py-1.5"
        >
          Get more credits
        </button>
      </div>
    );
  }

  if (failure.kind === 'input') {
    return (
      <div className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
           style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)' }}>
        <p className="text-[13px]" style={{ color: 'var(--text)' }}>{failure.message}</p>
        <button onClick={onDismiss} className="chip">Dismiss</button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ErrorNotice message={failure.message} />
      {failure.retry && (
        <button onClick={failure.retry} className="chip">
          <Restart className="w-3.5 h-3.5" /> Try again
        </button>
      )}
    </div>
  );
}

function Composer({
  value, onChange, onSubmit, onStop, busy, blocked, files, setFiles, onFileError, fileRef, taRef, placeholder,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; onStop: () => void;
  busy: boolean; blocked: boolean;
  files: File[]; setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  onFileError: (msg: string) => void;
  fileRef: React.RefObject<HTMLInputElement>; taRef: React.RefObject<HTMLTextAreaElement>;
  placeholder: string;
}) {
  // Three ways in, one gate. The file picker was the only one, which is the
  // wrong single way for this product: a screenshot lives in the clipboard
  // straight after Cmd+Shift+4, and going through Finder to fetch it back off
  // the desktop is the long way round the thing they are trying to ask.
  const [dragging, setDragging] = useState(false);

  // Grows with the text the way a chat input should, up to a ceiling.
  const fit = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, MAX_COMPOSER_PX) + 'px';
  };

  useEffect(fit, [value, files.length]);

  // The first measurement lands before the layout has given this element its
  // width. At 40px wide an empty placeholder wraps to twenty lines, the
  // ceiling wins, and the composer opens 200px tall - then stays that way,
  // because nothing re-measures it until the first keystroke. It is the first
  // thing on the screen and it was the wrong shape every single time.
  //
  // So it is measured again once there is a layout to measure: on the next
  // frame, once the webfont has swapped in (Geist changes the line box), and
  // whenever the window changes width.
  useEffect(() => {
    const raf = requestAnimationFrame(fit);
    document.fonts?.ready.then(fit).catch(() => {});
    window.addEventListener('resize', fit);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
    };
  }, []);

  const accept = (incoming: File | null | undefined | FileList): boolean => {
    if (!incoming) return false;
    const list = incoming instanceof File ? [incoming] : Array.from(incoming);
    if (!list.length) return false;

    for (const f of list) {
      const bad = validateFile(f);
      if (bad) { onFileError(bad); return false; }
    }

    // One video at a time. Two cuts in one message is two reviews, two prices
    // and one answer that has to talk about both, which is worse than sending
    // them one after the other.
    const videos = [...files, ...list].filter(f => !isImage(f));
    if (videos.length > 1) {
      onFileError('One video at a time. Screenshots can come with it.');
      return false;
    }
    const shots = [...files, ...list].filter(isImage);
    if (shots.length > MAX_IMAGES) {
      onFileError(`That is too many images. Send up to ${MAX_IMAGES} at a time.`);
      return false;
    }

    onFileError('');
    setFiles(prev => [...prev, ...list]);
    return true;
  };

  return (
    <div
      className="overflow-hidden transition-colors"
      style={{
        background: 'var(--bg-raised)',
        border: `1px solid ${dragging ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 'var(--r-lg)',
      }}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => {
        // Children fire dragleave as the cursor crosses them. Only the pointer
        // actually leaving the composer counts.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={e => { e.preventDefault(); setDragging(false); accept(e.dataTransfer.files); }}
    >
      <input ref={fileRef} type="file" className="hidden"
             accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,.mp4,.mov,.webm,.avi,image/png,image/jpeg,image/webp"
             multiple
             onChange={e => {
               const picked = e.target.files;
               const list = picked ? Array.from(picked) : [];
               e.currentTarget.value = '';
               if (list.length) accept(picked);
             }} />

      {files.length > 0 && (
        <div className="mx-2 mt-2 space-y-1.5">
          {files.map((f, i) => (
            <div key={`${f.name}-${f.size}-${i}`}
                 className="rounded-2xl px-3 py-2.5 flex items-center gap-3"
                 style={{ background: 'rgba(255,255,255,0.05)' }}>
              {isImage(f)
                ? <ImageIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />
                : <Film className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />}
              <p className="flex-1 min-w-0 text-[13px] truncate" style={{ color: 'var(--text)' }}>{f.name}</p>
              <span className="font-mono text-[11px] flex-shrink-0" style={{ color: 'var(--text-faint)' }}>{formatSize(f.size)}</span>
              <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                      className="p-1 transition-colors" style={{ color: 'var(--text-faint)' }} aria-label={`Remove ${f.name}`}>
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
        onPaste={e => {
          // Only intercept a pasted image. Text, and a screenshot pasted as a
          // file path, go through untouched.
          const item = Array.from(e.clipboardData.items)
            .find(i => i.kind === 'file' && i.type.startsWith('image/'));
          if (!item) return;
          if (accept(item.getAsFile())) e.preventDefault();
        }}
        rows={1}
        placeholder={files.length
          ? (files.every(isImage) ? 'Ask about it, or just send' : 'Add context, or just send')
          : placeholder}
        autoComplete="off"
        spellCheck={false}
        className="w-full bg-transparent resize-none px-5 pt-4 pb-1 text-[15px] leading-relaxed focus:outline-none"
        style={{ color: 'var(--text)' }}
      />

      <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-1">
        <button type="button" onClick={() => fileRef.current?.click()} title="Attach a video or a screenshot"
                className="w-8 h-8 rounded-full flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          <Plus className="w-[18px] h-[18px]" />
        </button>
        {/* One button, two jobs, and the second one is the whole point: a
            minute of watching used to end only when it ended. A spinner here
            said "wait" and offered nothing to press; this says "stop" and
            means it. */}
        {busy ? (
          <button onClick={onStop} title="Stop"
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            <Stop className="w-[18px] h-[18px]" />
          </button>
        ) : (
          <button onClick={onSubmit} disabled={blocked || (!value.trim() && !files.length)} title="Send"
                  className="w-8 h-8 rounded-full flex items-center justify-center transition-opacity disabled:opacity-25"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            <ArrowUp className="w-[18px] h-[18px]" />
          </button>
        )}
      </div>
    </div>
  );
}
