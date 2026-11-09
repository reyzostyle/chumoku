// deno-lint-ignore-file no-explicit-any
import { languageRule, loadLanguage } from './language.ts';
import { callLLM } from './llm.ts';
import { parseModelJson } from './json.ts';
import { loadBrain, brainBlock } from './brain.ts';
import { loadChannelScan, channelScanBlock } from './channel-scan.ts';
import { currentRule, inventsVersion } from './current.ts';

// One cheap call over titles only: for each pooled Short, what THIS creator's
// version would be and whether it fits their channel. Shared by pitch-ideas
// (the feed, on demand) and daily-ideas (the morning drop). Writes the
// competitor_ideas rows and returns them; `extra` rides along on every row.

export interface PitchSource {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string | null;
  views: number | null;
  published_at: string | null;
  outlier_score: number | null;
}

export async function pitchVideos(
  supabase: any,
  userId: string,
  todo: PitchSource[],
  extra: Record<string, unknown> = {},
): Promise<any[]> {
  if (todo.length === 0) return [];

  const brain = await loadBrain(supabase, userId);
  const scan = channelScanBlock(await loadChannelScan(supabase, userId));
  const who = brain ? brainBlock(brain) : '';
  if (!who && !scan) {
    // Nothing to adapt against. Better no pitch than a pitch for nobody.
    return [];
  }

  const list = todo.map((p, i) => `${i + 1}. [${p.video_id}] "${p.title ?? ''}" (${p.channel_name ?? 'unknown channel'}, ${(p.views ?? 0).toLocaleString('en-US')} views)`).join('\n');

  const prompt = `You help one Shorts creator decide which viral Shorts from other channels are worth stealing the format of.

${who}${scan}

Below are Shorts that beat their own channel's usual views. You only have the title, the channel and the views. For each one:

- fit:
  "no" when there is nothing a creator can copy. A company announcing or advertising its own product, a customer story, a trailer. Views that come from who posted it and not from the idea. A meme or in-joke that only works on that channel. A title not in English. Also "no" when it does not transfer to this creator at all.
  "yes" only when this creator could film their version this week with what they already make, and their viewers would click it.
  "stretch" when it needs a real change of subject or setup, or the title is too vague to judge.
  Be strict. Most of these should not be "yes".

- pitch: ONE line, under 90 characters, the title THIS creator would post. Not advice, no hashtags.
  Keep what made the original work: its promise and its shape. Point that at what this creator's viewers come for. When the original is already close to their subject, stay close and change only what has to change; do not reach for a distant topic just to be different. When it is far away, carry over only the shape.
  Example of the move, from other fields: "How to copy any physique without a coach", for a cooking channel, becomes "How to copy any restaurant dish without a recipe".

Shorts:
${list}

Respond with JSON only, one entry per Short, same ids:
{"ideas":[{"id":"<video id>","pitch":"...","fit":"yes|stretch|no"}]}

Never use an em-dash or en-dash, only the regular hyphen.`;

  // The writer model since 2026-11-09: this line is the idea itself, and the
  // bulk model was calling nearly everything a fit.
  const raw = await callLLM(prompt + languageRule(await loadLanguage(supabase, userId)) + currentRule(), { maxTokens: 4000, tier: 'writer' });
  const parsed = parseModelJson(raw, 'pitch-ideas') as { ideas?: Array<{ id?: string; pitch?: string; fit?: string }> };
  const byId = new Map(todo.map(p => [p.video_id, p]));

  const rows = (parsed.ideas ?? [])
    .filter(r => r.id && byId.has(r.id) && r.pitch && !inventsVersion(r.pitch, byId.get(r.id)!.title ?? ''))
    .map(r => {
      const p = byId.get(r.id!)!;
      return {
        user_id: userId,
        video_id: p.video_id,
        channel_id: p.channel_id,
        channel_name: p.channel_name,
        video_title: p.title,
        video_views: p.views,
        video_published_at: p.published_at,
        outlier_score: p.outlier_score,
        pitch: String(r.pitch).replace(/[—–]/g, '-').trim().slice(0, 140),
        fit: r.fit === 'yes' || r.fit === 'no' ? r.fit : 'stretch',
        ...extra,
      };
    });
  if (rows.length === 0) return [];

  // liked is not in the row, so an upsert never touches a save or a dismiss.
  const { data: saved, error } = await supabase
    .from('competitor_ideas')
    .upsert(rows, { onConflict: 'user_id,video_id' })
    .select();
  if (error) throw error;

  return saved ?? [];
}
