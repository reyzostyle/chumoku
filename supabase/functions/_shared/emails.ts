// Onboarding drip copy + markup.
//
// Kept as one module so the worker stays plumbing and the words live in a
// single place you can edit without touching delivery logic.
//
// Markup rules that email clients force on us, and why this looks dated:
//   - table wrapper, not flexbox: Outlook's Word renderer ignores modern CSS
//   - every style inlined: Gmail strips <style> blocks in many contexts
//   - the CTA is a padded <a>, not a <button>: buttons don't render reliably
//   - explicit colours on every element: clients inject their own defaults,
//     and a dark shell with inherited text colour goes black-on-black
// Each email ships a text/plain twin. That isn't politeness, it's
// deliverability: HTML-only mail scores as spammier almost everywhere.

// The app's own tokens, hex-frozen. Email clients cannot read CSS variables, so
// these are copies of :root in src/index.css and have to be updated with it.
//
// They were a different product's colours until now: a #0EA4E9 blue button on a
// navy card, from before the redesign. The blue was the thing that made the app
// look generated, and removing it was the point - white is the accent and the
// only filled action, and green means process, never decoration. An email is
// the first thing a new account sees, so it was the one surface still shipping
// the look everything else stopped using.
const ACCENT = '#FFFFFF';      // --accent
const ON_ACCENT = '#0A0A0B';   // --on-accent
const BG = '#121214';          // rgb(var(--surface-rgb))
const CARD = '#17171A';        // --bg-raised-hover, a step up from the page
const TEXT = '#ECECEC';        // --text
const MUTED = '#9B9B9B';       // --text-muted
const FAINT = '#6E6E6E';       // --text-faint
const LINE = 'rgba(255,255,255,0.07)';   // --line

// Geist is the app's face and is not a websafe font, so it is asked for first
// and falls back to the system stack every client will actually have. Most will
// render the fallback; the ones that do not look like the product.
const FONT = "'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export interface EmailCtx {
  appUrl: string;
  unsubscribeUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function layout(opts: {
  preheader: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  // Absent on mail about something they did (a purchase): that is not
  // marketing, there is nothing to unsubscribe from.
  unsubscribeUrl?: string;
  footer?: string;
}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};">
  <!-- Preheader: the grey line clients show next to the subject. Hidden in the
       body itself, otherwise it renders twice. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${CARD};border:1px solid ${LINE};border-radius:18px;">
        <tr><td style="padding:30px 30px 6px 30px;">
          <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:2.4px;color:${MUTED};">CHUMOKU</div>
        </td></tr>
        <tr><td style="padding:12px 30px 4px 30px;font-family:${FONT};font-size:15px;line-height:1.65;color:${TEXT};">
          ${opts.body}
        </td></tr>
        <tr><td style="padding:22px 30px 30px 30px;">
          <!-- White, like every filled action in the app. Dark text on it, so
               it stays legible in clients that force their own link colour. -->
          <a href="${opts.ctaUrl}" style="display:inline-block;background:${ACCENT};color:${ON_ACCENT};font-family:${FONT};font-size:14px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:10px;">${opts.ctaLabel}</a>
        </td></tr>
        <tr><td style="padding:18px 30px 26px 30px;font-family:${FONT};font-size:12px;line-height:1.6;color:${FAINT};border-top:1px solid ${LINE};">
          ${opts.unsubscribeUrl
            ? `you're getting this because you made a chumoku account.
          <a href="${opts.unsubscribeUrl}" style="color:${FAINT};text-decoration:underline;">unsubscribe</a>`
            : (opts.footer ?? '')}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const p = (s: string) => `<p style="margin:0 0 14px 0;">${s}</p>`;
const strong = (s: string) => `<strong style="color:${TEXT};font-weight:600;">${s}</strong>`;

// A headline, so the mail opens with a statement instead of the first line of a
// paragraph. Same job as the display type at the top of a page in the app.
// The mascot, from chumoku.co/mascot (brand/mascot/make.py). PNG, because
// mail clients do not render SVG.
const mascot = (pose: 'happy' | 'excited' | 'wink') =>
  `<img src="https://chumoku.co/mascot/chumoku-${pose}.png" width="84" height="92" alt="" style="display:block;margin:0 0 6px -6px;border:0;">`;

const h = (s: string) =>
  `<p style="margin:0 0 16px 0;font-size:21px;line-height:1.3;font-weight:600;color:${TEXT};letter-spacing:-0.2px;">${s}</p>`;

// A piece of the product, not a description of it.
//
// Every one of these emails was prose ABOUT what comes back. Showing the thing
// itself - the score, in the mono face it is set in on screen, with one real
// fix under it - does the same work in a quarter of the words and looks like
// the tool rather than like a newsletter about the tool.
const specimen = (score: string, line: string) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;background:${BG};border:1px solid ${LINE};border-radius:12px;">
  <tr><td style="padding:16px 18px;">
    <div style="font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;font-weight:600;color:${TEXT};line-height:1;">${score}<span style="font-size:12px;color:${FAINT};font-weight:400;"> / 100</span></div>
    <div style="margin-top:10px;font-size:13px;line-height:1.6;color:${MUTED};">${line}</div>
  </td></tr>
</table>`;

// Step 1 — immediately on signup.
//
// The one job here is to stop this reading as another AI chat box. The thing
// that is not true of a chat box is that this one has read their channel, so
// that is what the mail leads on, and the first action asks for the link that
// makes it true.
function welcome(ctx: EmailCtx): RenderedEmail {
  // Rewritten 2026-10-30 (Ivan: "looks nice and has some adorable text").
  // The old one sold a 62 / 100 score the product dropped a month earlier.
  // Written as Chumoku itself saying hello: short, warm, one thing to do.
  const text = `hi, i'm chumoku.

every morning i go through the shorts that just did way better than their
channel usually does, and turn the best ones into ideas for yours. not
for creators in general. for you.

your first ten are already waiting.

  1. pick one you like
  2. press once, and i write the script the way you talk
  3. film it

if you connect your youtube, i read your own shorts too, so every week
the ideas get a little more yours.

really glad you're here.
chumoku (and ivan, who made me)

see your ideas: ${ctx.appUrl}

unsubscribe: ${ctx.unsubscribeUrl}`;

  const step = (n: string, line: string) => `
<tr><td style="padding:0 0 10px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="width:26px;height:26px;border-radius:13px;background:${BG};border:1px solid ${LINE};text-align:center;font-size:12px;font-weight:600;color:${TEXT};">${n}</td>
    <td style="padding-left:12px;font-size:15px;color:${TEXT};">${line}</td>
  </tr></table>
</td></tr>`;

  return {
    subject: "hi, i'm chumoku. your first ideas are here",
    text,
    html: layout({
      preheader: 'ten ideas for your channel, already waiting',
      ctaLabel: 'see your ideas',
      ctaUrl: ctx.appUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
      body:
        mascot('happy') +
        h("hi, i'm chumoku.") +
        p(`every morning i go through the shorts that just did ${strong('way better than their channel usually does')}, and turn the best ones into ideas for yours. not for creators in general. for you.`) +
        p(`your first ${strong('ten')} are already waiting.`) +
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 16px 0;">
          ${step('1', 'pick one you like')}
          ${step('2', 'press once, and i write the script the way you talk')}
          ${step('3', 'film it')}
        </table>` +
        p('if you connect your youtube, i read your own shorts too, so every week the ideas get a little more yours.') +
        p(`really glad you're here.<br><span style="color:${MUTED};">chumoku (and ivan, who made me)</span>`),
    }),
  };
}

// Step 2 — +24h.
//
// The old version of this sold "script lab", a tab that no longer exists, and
// stopped at scoring. Scoring is half of it now: it will write the thing.
function hookAndScript(ctx: EmailCtx): RenderedEmail {
  const text = `most shorts do not die at the end. they die around second three.

you do not have to guess at that one. paste a hook, or the whole script,
BEFORE you film. chumoku scores it, says exactly where it drags, and hands
back openings that still sound like you.

  41 / 100
  it states a fact. nothing in it is a reason to keep watching.

and it works the other way round. ask it to write one and it will, against
your channel: your format, your length, the way you actually talk. "write
me a script about ranking minecraft mobs" gets you the lines, in order,
not advice about how to write them.

fixing this before you shoot is the cheapest edit you will ever make.

check a hook: ${ctx.appUrl}

unsubscribe: ${ctx.unsubscribeUrl}`;

  return {
    subject: 'your first 3 seconds decide the whole video',
    text,
    html: layout({
      preheader: 'score the hook before you film, not after it flops',
      ctaLabel: 'check a hook',
      ctaUrl: ctx.appUrl,
      unsubscribeUrl: ctx.unsubscribeUrl,
      body:
        h('most shorts die around second three.') +
        p(`paste a hook, or the whole script, ${strong('before you film')}. chumoku scores it and says exactly where it drags.`) +
        specimen('41', 'it states a fact. nothing in it is a reason to keep watching.') +
        p(`and it works the other way round. ${strong('ask it to write one')} and it will, against your channel: your format, your length, the way you actually talk. "write me a script about ranking minecraft mobs" gets you the lines, in order, not advice about how to write them.`) +
        p('fixing this before you shoot is the cheapest edit you will ever make.'),
    }),
  };
}

// Step 3 — +3d.
function competitors(ctx: EmailCtx): RenderedEmail {
  const url = ctx.appUrl;
  const text = `most "find trending ideas" tools just show you whatever is big right now.
chumoku does the opposite.

you add channels in your niche, and it only surfaces the shorts that beat
that channel's OWN average views per day. so a small channel's breakout
shows up, and a big channel's routine upload doesn't. that difference is
the whole feature.

then it re-angles the idea for your niche and writes it out as a script in
your voice, so you're not copying anyone.

finding them costs nothing. you only spend a credit on the one you decide
to open.

open ideas: ${url}

unsubscribe: ${ctx.unsubscribeUrl}`;

  return {
    subject: 'steal what already works (not what "trends")',
    text,
    html: layout({
      preheader: "outliers on their channel, not whatever is big this week",
      ctaLabel: 'find my outliers',
      ctaUrl: url,
      unsubscribeUrl: ctx.unsubscribeUrl,
      body:
        h('a big channel\u2019s routine upload is not an idea.') +
        p('most "trending ideas" tools show you whatever is big right now. chumoku does the opposite.') +
        p(`you add channels in your niche, and it only surfaces shorts that beat ${strong("that channel's own average views per day")}. a small channel's breakout shows up. a big channel's routine upload doesn't. that difference is the whole feature.`) +
        p('then it re-angles the idea for your niche and writes it out as a script in your voice, so you land it as your video instead of a copy.') +
        p(`finding them costs ${strong('nothing')}. you only spend a credit on the one you decide to open.`),
    }),
  };
}

// Step 4, +5d. There is no free plan since 2026-11-09.
function upgrade(ctx: EmailCtx): RenderedEmail {
  const url = `${ctx.appUrl}/#pricing`;
  const text = `chumoku runs on a subscription.

Plus is $9.99 a month: ten new ideas every morning and about 30 scripts, each
one written from an idea in one press. Pro is $19.99, about 100, for posting
every day.

the part worth knowing: the more you use it, the better it gets at your
channel specifically. it reads your uploads, remembers the ideas you kept
and the notes you wrote, and answers against them.

see the plans: ${url}

unsubscribe: ${ctx.unsubscribeUrl}`;

  return {
    subject: 'from an idea to a script',
    text,
    html: layout({
      preheader: 'ten ideas every morning and the scripts for them',
      ctaLabel: 'see the plans',
      ctaUrl: url,
      unsubscribeUrl: ctx.unsubscribeUrl,
      body:
        h('your next idea is waiting.') +
        p(`${strong('Plus, $9.99 a month')}: ten new ideas every morning and about 30 scripts, each one written from an idea in one press. ${strong('Pro, $19.99')}, about 100, for posting every day.`) +
        p('the part worth knowing: the more you use it, the better it gets at your channel specifically. it reads your uploads, remembers the ideas you kept and the notes you wrote, and answers against them.'),
    }),
  };
}

// Order is data, not control flow: swapping two steps here (and the matching
// send_at intervals in the migration) reorders the sequence without touching
// the worker.
//
// hookAndScript now goes out at +24h and competitors at +3d (swapped from the
// first draft): competitor tracking is Plus-only, so pitching it to a free
// user on day one before they've had a chance to spend a single credit was
// pushing an upgrade nobody asked for yet. Hook/script checks work on the
// free tier, so that's the thing worth showing first.
export const DRIP_STEPS: Record<number, (ctx: EmailCtx) => RenderedEmail> = {
  1: welcome,
  2: hookAndScript,
  3: competitors,
  4: upgrade,
};

export function renderStep(step: number, ctx: EmailCtx): RenderedEmail | null {
  const fn = DRIP_STEPS[step];
  return fn ? fn(ctx) : null;
}

// Sent once, when a subscription is paid for the first time (stripe-webhook,
// _shared/apple.ts). What they bought in numbers, when it comes back, and how
// to stop it, in the same voice as the drip.
export function subscribed(opts: { appUrl: string; plan: 'pro' | 'agency'; store: 'stripe' | 'apple' }): RenderedEmail {
  const name = opts.plan === 'agency' ? 'pro' : 'plus';
  const credits = opts.plan === 'agency' ? 300 : 100;
  const scripts = opts.plan === 'agency' ? 100 : 30;
  const manage = opts.store === 'apple'
    ? "cancel any time in your apple id's subscriptions on your iphone."
    : 'cancel any time in settings on chumoku.co.';
  const text = `you're on ${name}.

${credits} credits, starting now. a script from an idea is 3, a message in
the chat is 1, so that is about ${scripts} scripts a month.

they come back every month on the day you subscribed. ${manage}

open today's ideas: ${opts.appUrl}`;

  return {
    subject: `you're on ${name}. ${credits} credits are yours`,
    text,
    html: layout({
      preheader: `about ${scripts} scripts a month, starting now`,
      body:
        mascot('excited') +
        h(`you're on ${name}.`) +
        p(`${strong(`${credits} credits`)}, starting now. a script from an idea is 3, a message in the chat is 1, so that is about ${scripts} scripts a month.`) +
        p(`they come back every month on the day you subscribed. ${manage}`),
      ctaLabel: "open today's ideas",
      ctaUrl: opts.appUrl,
      footer: "you're getting this because you subscribed to chumoku.",
    }),
  };
}
