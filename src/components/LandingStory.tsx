import { useEffect, useState } from 'react';
import { useInView } from './LandingMotion';

// The middle of the landing (2026-11-09, Ivan): less "four steps", less text,
// fewer plates. Three scenes that show the thing instead of describing it: it
// watches your channel, it knows who is winning, you wake up with ideas.
//
// Every number is real (the Ideas pool), and every scene renders its finished
// state until JavaScript has run and it is on screen.

const thumb = (id: string) => `/landing/${id}.webp`;

export interface StoryIdea { id: string; source: string; pitch: string; multiple: number; channel: string }

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
      <h2 className={`story-title text-balance ${flip ? 'lg:order-2' : ''}`}
          style={{ opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(14px)', transition: 'opacity .7s ease, transform .7s cubic-bezier(.2,.7,.2,1)' }}>
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

// The creators around you, drawn in one by one.
function Rivals({ ideas }: { ideas: StoryIdea[] }) {
  const { ref, inView } = useInView<HTMLDivElement>(0.4);
  const shown = inView !== false;
  const nodes = ideas.slice(0, 7).map((d, i, all) => {
    const a = (i / all.length) * Math.PI * 2 - Math.PI / 2;
    return { ...d, x: 50 + Math.cos(a) * 39, y: 50 + Math.sin(a) * 39, size: i % 2 ? 19 : 24 };
  });
  return (
    <div ref={ref} className="relative aspect-square w-full max-w-[420px] mx-auto">
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full" aria-hidden="true">
        {nodes.map((n, i) => (
          <line key={n.id} x1="50" y1="50" x2={n.x} y2={n.y} stroke="rgba(255,255,255,0.16)" strokeWidth="0.25"
                pathLength={1} strokeDasharray="1" strokeDashoffset={shown ? 0 : 1}
                style={{ transition: `stroke-dashoffset .6s ease ${i * 120}ms` }} />
        ))}
      </svg>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[17%] aspect-square rounded-full flex items-center justify-center"
           style={{ background: 'var(--accent)' }}>
        <img src="/chumoku-mark.png" alt="" className="w-[58%] h-auto invert" />
      </div>
      {nodes.map((n, i) => (
        <div key={n.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${n.x}%`, top: `${n.y}%`, width: `${n.size}%` }}>
          <div className="relative" style={{ opacity: shown ? 1 : 0, transform: shown ? 'none' : 'scale(.6)', transition: `opacity .45s ease ${200 + i * 120}ms, transform .55s cubic-bezier(.2,1.3,.4,1) ${200 + i * 120}ms` }}>
            <img src={thumb(n.id)} alt="" loading="lazy" className="w-full aspect-square rounded-full object-cover object-top" />
            <span className="absolute -right-1 -bottom-1 px-1.5 py-px rounded-full text-[11px] font-medium tabular-nums"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>{n.multiple}×</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// One after another: what blew up for them, and what you film.
function Morning({ ideas }: { ideas: StoryIdea[] }) {
  const { ref, inView } = useInView<HTMLDivElement>(0.4);
  const [i, setI] = useState(0);
  useEffect(() => {
    if (inView !== true || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setI(n => (n + 1) % ideas.length), 2800);
    return () => clearInterval(t);
  }, [inView, ideas.length]);
  const d = ideas[i];
  return (
    <div ref={ref} key={d.id} className="animate-fade-in flex items-center gap-4 sm:gap-6">
      <div className="relative w-[30%] max-w-[150px] flex-shrink-0 aspect-[4/5] overflow-hidden rounded-2xl">
        <img src={thumb(d.id)} alt="" className="w-full h-full object-cover" />
        <span className="absolute left-2 bottom-2 px-2 py-0.5 rounded-full text-[12px] font-medium tabular-nums" style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>{d.multiple}×</span>
      </div>
      <p className="text-[clamp(1.35rem,1rem+1.5vw,2rem)] font-medium leading-tight tracking-tight text-balance" style={{ color: 'var(--text)' }}>{d.pitch}</p>
    </div>
  );
}

export function LandingStory({ ideas }: { ideas: StoryIdea[] }) {
  return (
    <div>
      <Scene id="product" title="It watches" muted="everything you post."><Watching /></Scene>
      <Scene flip title="It knows who is" muted="winning your niche."><Rivals ideas={ideas} /></Scene>
      <Scene title="You wake up" muted="knowing what to film."><Morning ideas={ideas} /></Scene>
    </div>
  );
}
