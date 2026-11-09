import { useEffect, useRef, useState } from 'react';

// The landing page's moving parts, after money.x.com.
//
// What was worth taking from it is not a look but a rhythm: every section
// opens on a hairline, a two-tone headline sits on the left with one short
// paragraph opposite it, and the proof is a small piece of live interface that
// does something as you reach it - a number counts, a list fills in, a curve
// draws. Nothing floats in from off-screen and nothing loops for attention.
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
