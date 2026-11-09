import { useEffect, useState } from 'react';
import { useInView } from './LandingMotion';

// The middle of the landing (2026-11-09, Ivan): it watches your channel, it
// saves you the scrolling, nothing new gets past you, you know what to film.
// Thumbnails stay in the hero and the first scene; the rest is type and one
// real card, so the page does not turn into a wall of previews.
//
// Every scene renders its finished state until JavaScript has run and it is on
// screen.

const thumb = (id: string) => `/landing/${id}.webp`;

// One creator's latest Shorts with their real views and multiples.
const UPLOADS = [
  { id: '9q5v9oir3UE', views: '38K', x: 1.7 },
  { id: 'XL2wnO2w8GE', views: '42K', x: 1.9 },
  { id: 'SeyUBsB-LSc', views: '57K', x: 2.5 },
  { id: 'QKtxN2ifkQ8', views: '82K', x: 3.6 },
  { id: 'qVMdwstXVHY', views: '238K', x: 10 },
  { id: 'jyJ35knlVKc', views: '143K', x: 6.3 },
];
const BEST = 4;

function Scene({ id, title, muted, flip, children }: {
  id?: string; title: string; muted: string; flip?: boolean; children: React.ReactNode;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const shown = inView !== false;
  return (
    <div ref={ref} id={id} className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center py-12 sm:py-20 scroll-mt-16">
      <h2 className={`display text-balance ${flip ? 'lg:order-2' : ''}`}
          style={{ color: 'var(--text)', opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(14px)', transition: 'opacity .7s ease, transform .7s cubic-bezier(.2,.7,.2,1)' }}>
        {title} <span style={{ color: 'var(--text-muted)' }}>{muted}</span>
      </h2>
      <div className={flip ? 'lg:order-1' : ''}>{children}</div>
    </div>
  );
}

// A light passes over their Shorts, then everything falls back but the one
// that worked.
function Watching() {
  const { ref, inView } = useInView<HTMLDivElement>(0.4);
  const [at, setAt] = useState(UPLOADS.length);
  useEffect(() => {
    if (inView !== true) return;
    setAt(-1);
    const timers = UPLOADS.map((_, i) => setTimeout(() => setAt(i), 300 + i * 340));
    timers.push(setTimeout(() => setAt(UPLOADS.length), 300 + UPLOADS.length * 340 + 200));
    return () => timers.forEach(clearTimeout);
  }, [inView]);
  const done = at >= UPLOADS.length;
  return (
    <div ref={ref} className="grid grid-cols-3 gap-2 sm:gap-3 max-w-md lg:ml-auto">
      {UPLOADS.map((u, i) => {
        const best = i === BEST;
        const lit = done ? best : i === at;
        return (
          <div key={u.id} className="relative aspect-[4/5] overflow-hidden rounded-2xl transition-all duration-500"
               style={{ opacity: lit ? 1 : done ? 0.28 : i < at ? 0.5 : 0.75, transform: done && best ? 'scale(1.06)' : 'none', zIndex: best ? 1 : 0 }}>
            <img src={thumb(u.id)} alt="" loading="lazy" className="w-full h-full object-cover" />
            <span className="absolute left-2 bottom-2 px-2 py-0.5 rounded-full text-[12px] font-medium tabular-nums transition-opacity duration-300"
                  style={{ background: done && best ? 'var(--accent)' : 'rgba(0,0,0,0.6)', color: done && best ? 'var(--on-accent)' : '#fff', opacity: lit ? 1 : 0 }}>
              {done && best ? `${u.x}×` : u.views}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// What it costs to do this by hand, crossed out as you reach it.
function Scrolling() {
  const { ref, inView } = useInView<HTMLDivElement>(0.5);
  const shown = inView !== false;
  return (
    <div ref={ref} className="py-16 sm:py-28 text-center">
      <p className="story-title" style={{ color: 'var(--text-faint)' }}>
        <span className="relative inline-block">
          Hours of scrolling.
          <span aria-hidden="true" className="absolute left-0 right-0 top-[54%] h-[3px] origin-left"
                style={{ background: 'var(--text-muted)', transform: `scaleX(${shown ? 1 : 0})`, transition: 'transform .7s cubic-bezier(.6,0,.2,1) .25s' }} />
        </span>
      </p>
      <p className="story-title mt-2" style={{ color: 'var(--text)', opacity: shown ? 1 : 0, transition: 'opacity .6s ease .8s' }}>Ten ideas at 9:00.</p>
    </div>
  );
}

// Real finds from the daily research, with the idea each one became.
const NEWS = [
  { date: 'Nov 5', what: 'Cursor live app deployment', idea: 'Stop keeping your builds on localhost' },
  { date: 'Oct 29', what: 'YouTube originality update', idea: 'YouTube just killed faceless clip channels' },
  { date: 'Oct 28', what: 'Shorts algorithm shift', idea: 'The 2-second rule killing your Shorts feed' },
];

function News() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const shown = inView !== false;
  return (
    <div ref={ref} style={{ borderTop: '1px solid var(--line)' }}>
      {NEWS.map((n, i) => (
        <div key={n.date} className="py-4" style={{ borderBottom: '1px solid var(--line)', opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(8px)', transition: `opacity .5s ease ${i * 140}ms, transform .5s ease ${i * 140}ms` }}>
          <p className="label-mono">{n.date} · {n.what}</p>
          <p className="mt-1.5 text-[17px] sm:text-[19px] font-medium tracking-tight" style={{ color: 'var(--text)' }}>{n.idea}</p>
        </div>
      ))}
    </div>
  );
}

// One idea from the app, and the words it turns into.
const SCRIPT = [
  "There's a name for coaches who post AI advice.",
  'It is called not having an opinion.',
  'Your clients can tell.',
  'Here is the one thing I changed.',
];

function Filming({ card }: { card: React.ReactNode }) {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const shown = inView !== false;
  return (
    <div ref={ref} className="flex items-start gap-4 sm:gap-6 max-w-lg lg:ml-auto">
      <div className="w-[46%] max-w-[210px] flex-shrink-0">{card}</div>
      <div className="space-y-2.5 pt-1">
        {SCRIPT.map((l, i) => (
          <p key={l} className="text-[14.5px] sm:text-[16px] leading-snug" style={{ color: i ? 'var(--text-muted)' : 'var(--text)', opacity: shown ? 1 : 0, transition: `opacity .5s ease ${300 + i * 420}ms` }}>{l}</p>
        ))}
      </div>
    </div>
  );
}

export function LandingStory({ card }: { card: React.ReactNode }) {
  return (
    <div>
      <Scene id="product" title="It watches" muted="everything you post."><Watching /></Scene>
      <Scrolling />
      <Scene title="Nothing new" muted="gets past you."><News /></Scene>
      <Scene title="You know" muted="what to film."><Filming card={card} /></Scene>
    </div>
  );
}
