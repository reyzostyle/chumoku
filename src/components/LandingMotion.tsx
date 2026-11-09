import { useEffect, useRef, useState } from 'react';

// The landing page's moving parts, after money.x.com.
//
// What was worth taking from it is not a look but a rhythm: every section
// opens on a hairline, a two-tone headline sits on the left with one short
// paragraph opposite it, and the proof is a small piece of live interface that
// does something as you reach it - a number counts, a list fills in, a curve
// draws. Nothing floats in from off-screen and nothing loops for attention.
//
// Every tile here shows real words and real product numbers (the credit
// prices, the score scale, the shape of a retention curve), never skeleton
// bars. The one rule carried over from the old page: a mockup that shows grey
// placeholders reads as a page that failed to load.
//
// Server-rendered first (src/prerender.tsx), so every component renders its
// FINISHED state until JavaScript is running and the element is on screen.
// A crawler and a reader without JS see "72 / 100", never "0 / 100".

// ─── In view ─────────────────────────────────────────────────────────────────

export function useInView<T extends HTMLElement = HTMLDivElement>(threshold = 0.25) {
  const ref = useRef<T>(null);
  // null = not measured yet (server, or before the effect), so animated
  // components can render their end state on the server.
  const [inView, setInView] = useState<boolean | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) { setInView(true); return; }
    setInView(false);
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setInView(true); io.disconnect(); } },
      { threshold, rootMargin: '0px 0px -60px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Staggered entrance for a child: hidden only once we know it is off screen.
function enter(inView: boolean | null, i = 0, base = 0): React.CSSProperties {
  const shown = inView !== false;
  return {
    opacity: shown ? 1 : 0,
    transform: shown ? 'none' : 'translateY(8px)',
    transition: `opacity 0.55s ease ${base + i * 90}ms, transform 0.55s cubic-bezier(.2,.7,.2,1) ${base + i * 90}ms`,
  };
}

// ─── Section head ────────────────────────────────────────────────────────────
// Hairline, eyebrow, one headline that fits on one line: the bright half and
// its muted tail on the same line. There used to be a paragraph opposite it;
// it was the text nobody read, and at that width it kept leaving a single word
// on its second line.

export function Head({ eyebrow, title, muted, id }: {
  eyebrow?: string; title: string; muted?: string; id?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  return (
    <div ref={ref} id={id} className="pt-8 sm:pt-10 mb-10 sm:mb-12 scroll-mt-16" style={{ borderTop: '1px solid var(--line)' }}>
      {eyebrow && <p className="label-mono mb-5" style={enter(inView)}>{eyebrow}</p>}
      <h2 className="display text-balance" style={{ ...enter(inView, 1), color: 'var(--text)' }}>
        {title}
        {muted && <span style={{ color: 'var(--text-muted)' }}> {muted}</span>}
      </h2>
    </div>
  );
}

// ─── The workflow, 01 to 04 ──────────────────────────────────────────────────

const tile: React.CSSProperties = {
  background: 'var(--bg-raised)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
};

function Tile({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative h-[188px] overflow-hidden p-4 ${className}`} style={tile}>
      {children}
    </div>
  );
}

// Three real ideas fanned out like cards in a hand: the frame and how far it
// beat its channel, which is all you need to see to want one. Same Shorts,
// same measured multiples as the cards at the top of the page.
function FindTile({ inView }: { inView: boolean | null }) {
  const cards = [
    { id: 'EocsE3pFnAI', m: '17×', r: -9, x: -58 },
    { id: 'nGPFYc6eTKw', m: '11×', r: 9, x: 58 },
    { id: '3iUo7bnsN30', m: '65×', r: 0, x: 0 },
  ];
  return (
    <Tile className="flex items-center justify-center">
      {cards.map((c, i) => (
        <div key={c.id} className="fan-card"
             style={{
               ...enter(inView, i, 150),
               transform: `translateX(${c.x}px) rotate(${inView === false ? 0 : c.r}deg)`,
               zIndex: i,
             }}>
          <img src={`/landing/${c.id}.webp`} alt="" loading="lazy" />
          <span>{c.m}</span>
        </div>
      ))}
    </Tile>
  );
}

// The two icons the extension actually injects (extension/content.js), so the
// tile shows the real buttons and not two blank circles.
function AskGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z" />
    </svg>
  );
}
function StealGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
      <path d="M14 11.5v5M11.5 14h5" />
    </svg>
  );
}

function StealTile({ inView }: { inView: boolean | null }) {
  // Just the two buttons the extension adds, at a size you can read. Steal is
  // the filled one and pulses once as the tile comes into view.
  return (
    <Tile className="flex items-center justify-center">
      <span className="absolute left-4 top-4 label-mono">On YouTube</span>
      <div className="flex items-center gap-2.5">
        {[
          { l: 'Steal', G: StealGlyph, primary: true },
          { l: 'Ask', G: AskGlyph, primary: false },
        ].map(({ l, G, primary }, i) => (
          <span key={l}
                className={`flex items-center gap-2 pl-3.5 pr-4 py-2.5 rounded-full text-[13.5px] font-medium ${primary && inView ? 'lp-pulse' : ''}`}
                style={{
                  ...enter(inView, i, 200),
                  background: primary ? 'var(--accent)' : 'transparent',
                  color: primary ? 'var(--on-accent)' : 'var(--text)',
                  border: primary ? '1px solid transparent' : '1px solid var(--line-strong)',
                }}>
            <G className="w-4 h-4" />
            {l}
          </span>
        ))}
      </div>
    </Tile>
  );
}

// The idea screen's three steps, the first two already open.
function UnlockTile({ inView }: { inView: boolean | null }) {
  const steps = [
    { n: 1, t: 'Your angle', done: true },
    { n: 2, t: 'Outline', done: true },
    { n: 3, t: 'Script', done: false },
  ];
  return (
    <Tile className="flex flex-col justify-center gap-2.5">
      {steps.map((st, i) => (
        <div key={st.n} className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
             style={{ ...enter(inView, i, 250), background: 'var(--bg-app)', border: '1px solid var(--line)' }}>
          <span className="idea-step__n" data-done={st.done ? 'true' : undefined}>{st.n}</span>
          <span className="text-[13.5px] font-medium" style={{ color: st.done ? 'var(--text)' : 'var(--text-faint)' }}>{st.t}</span>
        </div>
      ))}
    </Tile>
  );
}

function ChatTile({ inView }: { inView: boolean | null }) {
  return (
    <Tile className="flex flex-col justify-end gap-2">
      <div className="self-end max-w-[85%] px-3 py-2 rounded-2xl text-[12px]" style={{ ...enter(inView, 0, 100), background: 'var(--bg-app)', border: '1px solid var(--line)', color: 'var(--text)' }}>
        write the script for my saved idea
      </div>
      <div className="max-w-[92%] px-3 py-2 rounded-2xl text-[12px] leading-snug" style={{ ...enter(inView, 1, 500), background: 'var(--bg-app)', border: '1px solid var(--line)', color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--text)' }}>Hook:</span> "Everyone on this server is rich. I have one dirt block."
      </div>
    </Tile>
  );
}

const STEPS: { n: string; title: string; Tile: (p: { inView: boolean | null }) => JSX.Element }[] = [
  // One line each at the tile's width. Two-line captions kept ending on a
  // single word, which reads as copy that ran out of room.
  // Titles only. A caption under each one explained what the tile already
  // shows, and Ivan's rule (2026-09-30) is that nothing on the page describes
  // what is on the page.
  { n: '01', title: 'Find what is blowing up', Tile: FindTile },
  { n: '02', title: 'Steal any Short', Tile: StealTile },
  { n: '03', title: 'Unlock your version', Tile: UnlockTile },
  { n: '04', title: 'Get the script', Tile: ChatTile },
];

export function WorkflowGrid() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-10">
      {STEPS.map(s => <Step key={s.n} {...s} />)}
    </div>
  );
}

function Step({ n, title, Tile: T }: (typeof STEPS)[number]) {
  const { ref, inView } = useInView<HTMLDivElement>(0.35);
  return (
    <div ref={ref} style={enter(inView)}>
      <T inView={inView} />
      <p className="flex gap-3 mt-4 text-[14.5px] font-medium" style={{ color: 'var(--text)' }}>
        <span className="text-[12px] tabular-nums pt-0.5" style={{ color: 'var(--text-faint)' }}>{n}</span>
        {title}
      </p>
    </div>
  );
}

// ─── Chumoku brain, reading ──────────────────────────────────────────────────
// The brain as the thing it actually does: it reads your uploads one by one,
// then says three short things about the channel. Replaced a node graph of
// "YOU" wired to four labels, which looked generated and explained nothing.

const UPLOADS = [
  'i tried every ai editor so you dont have to',
  'this app is lying to you',
  'stop paying for this',
  'the worst update they ever shipped',
  'ranking every tool by how much it saves',
  'nobody talks about this setting',
];
const LEARNED: { k: string; v: string }[] = [
  { k: 'Niche', v: 'Tech commentary' },
  { k: 'Format', v: '30-45s, to camera' },
  { k: 'Works best', v: 'a ranking you argue with' },
];

export function BrainScan() {
  const { ref, inView } = useInView<HTMLDivElement>(0.35);
  const [read, setRead] = useState(UPLOADS.length);
  useEffect(() => {
    if (inView === false) { setRead(0); return; }
    if (inView !== true || prefersReducedMotion()) { setRead(UPLOADS.length); return; }
    setRead(0);
    const timers = UPLOADS.map((_, i) => setTimeout(() => setRead(i + 1), 300 + i * 320));
    return () => timers.forEach(clearTimeout);
  }, [inView]);
  const done = read >= UPLOADS.length;

  return (
    <div ref={ref} className="grid md:grid-cols-2 overflow-hidden"
         style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)' }}>
      <div className="p-4 sm:p-6 md:border-r" style={{ borderColor: 'var(--line)' }}>
        <p className="label-mono mb-3">Reading your uploads</p>
        <div className="space-y-1">
          {UPLOADS.map((t, i) => (
            <div key={t} className="flex items-center gap-2.5 py-1.5">
              <span className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{
                      border: `1px solid ${i < read ? 'transparent' : 'var(--line-strong)'}`,
                      background: i < read ? 'rgba(var(--process-rgb),0.15)' : 'transparent',
                      transition: 'background 0.3s ease, border-color 0.3s ease',
                    }}>
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" style={{ opacity: i < read ? 1 : 0, transition: 'opacity 0.3s ease' }}>
                  <path d="M2.5 6.2l2.2 2.2 4.8-4.9" fill="none" stroke="var(--process)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="text-[13px] truncate" style={{ color: i < read ? 'var(--text)' : 'var(--text-faint)', transition: 'color 0.3s ease' }}>{t}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="p-4 sm:p-6 border-t md:border-t-0" style={{ borderColor: 'var(--line)' }}>
        <p className="label-mono mb-3">What it learned</p>
        <div className="space-y-2">
          {LEARNED.map((l, i) => (
            <div key={l.k} className="flex items-baseline justify-between gap-4 px-3 py-2.5 rounded-lg"
                 style={{
                   background: 'var(--bg-app)', border: '1px solid var(--line)',
                   opacity: done ? 1 : 0, transform: done ? 'none' : 'translateY(6px)',
                   transition: `opacity 0.45s ease ${i * 120}ms, transform 0.45s cubic-bezier(.2,.7,.2,1) ${i * 120}ms`,
                 }}>
              <span className="font-mono text-[10.5px] uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--text-faint)' }}>{l.k}</span>
              <span className="text-[13px] text-right truncate" style={{ color: 'var(--text)' }}>{l.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
