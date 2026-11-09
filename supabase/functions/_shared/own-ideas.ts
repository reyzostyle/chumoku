// deno-lint-ignore-file no-explicit-any
import { languageRule, loadLanguage } from './language.ts';
import { callLLM, searchWeb } from './llm.ts';
import { parseModelJson } from './json.ts';
import { loadBrain, brainBlock, type ChannelBrain } from './brain.ts';
import { loadChannelScan, type ChannelScan } from './channel-scan.ts';
import { currentRule } from './current.ts';

// Ideas Chumoku finds for the creator itself (2026-10-27).
//
// Everything else in the drop is someone else's Short that beat its channel:
// proven, but proven for them. These are a researcher's picks instead: what is
// new or being talked about in the creator's subject this week, turned into a
// video that fits their channel. Now and then one remixes an upload of theirs
// that beat their usual, but that is the exception (Ivan, same day: "find
// ideas, don't rework old videos; reworking is fine if it's good, not the main
// thing").
//
// Nothing has tested them, so they are rows of their own kind (source 'ai', no
// real video behind them) and the client draws them as a script, not a Short.
// `video_id` is a made-up `ai-` key only because the table is unique on
// (user_id, video_id) and save, dismiss and chat all key on it; nothing ever
// loads it as a YouTube id.
//
// One web search and one writer call per batch.

export const MIN_UPLOADS = 3;

export type IdeaBasis =
  | { kind: 'research'; hook: string; source: string; why: string }
  | { kind: 'remix'; hook: string; video_id: string | null; title: string; views: number; multiple: number; why: string };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Something to research for: real uploads, or at least a brain.
export function canSuggest(scan: ChannelScan | null, brain: ChannelBrain | null): boolean {
  return (scan?.videos?.length ?? 0) >= MIN_UPLOADS || !!brain;
}

// What is fresh in their subject. Never throws: without it the ideas are less
// current, not absent.
async function research(brain: ChannelBrain | null, scan: ChannelScan | null): Promise<string> {
  const subject = [brain?.niche, brain?.summary].filter(Boolean).join('. ')
    || (scan ? `${scan.channelTitle}: ${scan.videos.slice(0, 8).map(v => v.title).join('; ')}` : '');
  if (!subject) return '';
  try {
    const { answer } = await searchWeb(
      `A YouTube Shorts creator makes videos about: ${subject.slice(0, 600)}\n\n`
      + 'What is new or being talked about in exactly this subject in the last 14 days? '
      + 'List 8 specific, dated things they could make a Short about right now: launches, updates, trends, '
      + 'results people are sharing, arguments. One line each, with the date.');
    return answer.trim();
  } catch (e) {
    console.error('[own-ideas] research failed:', e);
    return '';
  }
}

export async function suggestFromChannel(
  supabase: any,
  userId: string,
  count: number,
  dropDate: string,
): Promise<number> {
  if (count <= 0) return 0;
  let scan = await loadChannelScan(supabase, userId);
  // A scan cached before uploads carried their ids: read it again once, so a
  // remix can point at the Short it builds on.
  if (scan?.videos?.length && !scan.videos[0].id) scan = await loadChannelScan(supabase, userId, 0) ?? scan;
  const brain = await loadBrain(supabase, userId);
  if (!canSuggest(scan, brain)) return 0;

  const videos = scan?.videos ?? [];
  // A video only a day or two old has not had its views yet.
  const settled = videos.filter(v => Date.now() - new Date(v.publishedAt).getTime() > 2 * 86_400_000);
  const base = median((settled.length >= MIN_UPLOADS ? settled : videos).map(v => v.views)) || 1;
  const uploads = videos.map((v, i) => ({
    n: i + 1, ...v, multiple: Math.round((v.views / base) * 10) / 10,
  }));
  const list = uploads
    .map(v => `${v.n}. "${v.title}" - ${v.views.toLocaleString()} views (${v.multiple}x their usual)`)
    .join('\n');

  // What it suggested before, so tomorrow is not today again.
  const [{ data: earlier }, fresh] = await Promise.all([
    supabase.from('competitor_ideas').select('pitch')
      .eq('user_id', userId).eq('source', 'ai')
      .order('created_at', { ascending: false }).limit(40),
    research(brain, scan),
  ]);
  const before = (earlier ?? []).map((r: any) => r.pitch).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are a researcher for one Shorts creator. Your job is to find what they should film next.

${brainBlock(brain)}
${uploads.length ? `
## Their last ${uploads.length} uploads, newest first
${scan?.channelTitle ? `Channel: ${scan.channelTitle}${scan.subscribers != null ? ` (${scan.subscribers.toLocaleString()} subscribers)` : ''}\n` : ''}"Their usual" is the median, ${Math.round(base).toLocaleString()} views.
${list}
` : ''}
## Fresh in their subject (web search, today is ${today})
${fresh || 'Search unavailable today: use what you know of their subject, and nothing you are unsure is real.'}

Write ${count} video ideas for them.
- Most are NEW (kind "research"): a subject they have not posted, found in the fresh list above or in what you know of their subject, that fits their channel: the same subject area, the same kind of viewer, a format they already make. Take the format and tone from what beat their usual.
- At most one in four may be a "remix": one of their uploads that beat their usual, pushed into a new angle. Never a remake of a video they already posted.
- Every fact you use must come from the fresh list or be something you are sure of. Never invent a release, a number or a quote.

For each idea:
- kind: "research" or "remix"
- pitch: the working title, under 80 characters, the way they would title it, no hashtags. Not advice, not "Make a video about".
- premise: two short sentences, what happens on screen.
- hook: the first line they say on camera, under 90 characters.
- source: for research, what it is based on, under 50 characters (like "Claude Code web launch, Oct 20"); for a remix, the number of the upload.
- why: under 70 characters, why it fits them now. Plain words, no numbers.

${before.length ? `Already suggested on earlier days, do not repeat these or near-copies:\n${before.map((p: string) => `- ${p}`).join('\n')}\n\n` : ''}Respond with JSON only:
{"ideas":[{"kind":"research","pitch":"...","premise":"...","hook":"...","source":"...","why":"..."}]}

Never use an em-dash or en-dash, only the regular hyphen.`;

  const raw = await callLLM(prompt + languageRule(await loadLanguage(supabase, userId)) + currentRule(), { maxTokens: 3500, tier: 'writer' });
  const parsed = parseModelJson(raw, 'own-ideas') as {
    ideas?: Array<{ kind?: string; pitch?: string; premise?: string; hook?: string; source?: string | number; why?: string }>;
  };
  const clean = (s: unknown, max: number) => String(s ?? '').replace(/[—–]/g, '-').trim().slice(0, max);
  // Their titles carry hashtags; on a card they are noise.
  const untag = (s: string) => s.replace(/(^|\s)#[\w-]+/g, '').replace(/\s{2,}/g, ' ').trim();

  const rows = (parsed.ideas ?? [])
    .filter(r => r.pitch && r.premise)
    .slice(0, count)
    .map(r => {
      const hook = clean(r.hook, 140);
      const why = clean(r.why, 120);
      const src = r.kind === 'remix' ? uploads.find(v => v.n === Number(r.source)) : undefined;
      const basis: IdeaBasis = src
        ? { kind: 'remix', hook, video_id: src.id ?? null, title: untag(src.title), views: src.views, multiple: src.multiple, why }
        : { kind: 'research', hook, source: clean(typeof r.source === 'number' ? '' : r.source, 80), why };
      return {
        user_id: userId,
        video_id: `ai-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
        source: 'ai',
        channel_id: null,
        channel_name: scan?.channelTitle || null,
        video_title: null,
        pitch: untag(clean(r.pitch, 140)),
        adapted_idea: clean(r.premise, 600),
        fit: 'yes',
        basis,
        drop_date: dropDate,
      };
    });
  if (rows.length === 0) return 0;

  const { error } = await supabase.from('competitor_ideas').insert(rows);
  if (error) throw error;
  return rows.length;
}
