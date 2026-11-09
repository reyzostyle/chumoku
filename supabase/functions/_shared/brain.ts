// The channel brain: one model-written read of who this creator is, cached on
// user_tokens and reused by every prompt that adapts something "for your
// channel".
//
// Before this, each of those prompts pasted in four boxes the creator had
// typed - niche, description, audience, extra context. Most accounts leave
// them empty, and the ones that do not describe the channel they intend to
// run. The brain takes the two things nobody can get wrong (a level and a
// couple of sentences) plus the evidence (their last uploads, via
// channel-scan) and writes the profile the prompts actually need.
//
// It is built on demand - onboarding, saving the profile, pressing rebuild -
// never lazily inside an analysis. A creator waiting on a video breakdown
// should not also be paying for a second model call they did not ask for.

import { callLLM } from './llm.ts';
import { languageRule, loadLanguage } from './language.ts';
import { parseModelJson } from './json.ts';
import { loadChannelScan, type ChannelScan } from './channel-scan.ts';
import type { RetentionLessons } from './retention-sync.ts';

export interface ChannelBrain {
  // Second person, written to be read by the creator as well as by the model:
  // this is what Settings shows them, and a profile nobody can check is a
  // profile nobody trusts.
  summary: string;
  niche: string;
  format: string;
  audience: string;
  voice: string;
  strengths: string[];
  watch_outs: string[];
  // The part the rest of the product came here for: how to remake someone
  // else's video on THIS channel.
  adapt_rules: string[];
  // 'uploads' when their own videos were part of the read, 'stated' when all
  // there was to go on is what they typed. Callers say which, because advice
  // built on a guess should not be delivered in the same voice as advice built
  // on twenty titles.
  source: 'uploads' | 'stated';
  // What their real retention curves add up to (retention-sync.ts). Not part
  // of the stored read: attached by loadBrain from its own column, so the
  // weekly rebuild can never wipe it and every prompt that takes the brain
  // gets it.
  retention?: RetentionLessons | null;
  // How their TikToks and Reels did against their usual (user_tokens.
  // social_summary). Attached on load like retention, not part of the stored read.
  social?: string | null;
  // What they say the channel is about now and what they want from it
  // (user_tokens.channel_description, channel_goal). Attached on load, so a
  // change counts at once and the weekly rebuild cannot lose it.
  direction?: string | null;
  goal?: string | null;
}

const GOALS: Record<string, string> = {
  sell: 'selling their product or service through their videos',
  followers: 'growing a following',
  viral: 'getting as many views as possible',
};

// The niche vocabulary, moved here from src/lib/niches.ts when the chips came
// off the profile screen and nothing in the frontend picked a niche any more.
//
// It stays a fixed list for the same reason it always was: the niche is the
// key a benchmark groups by. Someone posting every other day has fifteen data
// points a month and cannot tell a bad week from a bad video on their own, so
// the comparison has to come from everyone else making the same thing - and
// free text groups with nothing. Both halves of the audience are on it, the
// shorts-native ones first: this product is mostly ranking, commentary,
// Minecraft and Roblox channels, and a list of Finance / Fitness / Lifestyle
// had a chip for none of them.
const NICHES = [
  'ranking', 'commentary', 'gaming', 'anime',
  'reddit', 'facts', 'movies', 'sports',
  'motivation', 'comedy', 'fitness', 'finance',
];

const LEVEL_GUIDANCE: Record<string, string> = {
  beginner: 'They are new. Assume no equipment, no editing habits worth protecting and no audience yet. Fundamentals beat nuance.',
  intermediate: 'They post regularly and know the basics. Skip the fundamentals; the useful advice is about execution and consistency.',
  advanced: 'They are experienced and probably right about the basics. Only nuance is worth their time - do not explain what a hook is.',
};

function scanEvidence(scan: ChannelScan | null): string {
  if (!scan) return 'Their channel is not connected, so there are no uploads to read. Work from what they wrote and say so.';
  const titles = scan.videos.slice(0, 20)
    .map(v => `- ${v.title} (${v.views.toLocaleString()} views)`)
    .join('\n');
  return `Channel: ${scan.channelTitle}${scan.subscribers != null ? ` (${scan.subscribers.toLocaleString()} subscribers)` : ''}
Their own YouTube description: ${scan.description ? scan.description.slice(0, 600) : 'not set'}
${titles ? `Their last ${scan.videos.length} uploads, newest first:\n${titles}` : 'No uploads found.'}`;
}

// deno-lint-ignore no-explicit-any
export async function buildBrain(supabase: any, userId: string): Promise<ChannelBrain | null> {
  const { data: row } = await supabase
    .from('user_tokens')
    .select('social_summary, creator_level, channel_goal, channel_description, channel_niche, target_audience, channel_context, brain, brain_overrides, retention_lessons')
    .eq('user_id', userId)
    .maybeSingle();

  // A day old at most: this runs weekly from the cron, and the scan's own
  // week-long cache would otherwise hand it last week's uploads.
  const scan = await loadChannelScan(supabase, userId, 24 * 60 * 60 * 1000);

  // Their best videos ever, beside the latest twenty. The latest alone made
  // the read follow whatever they posted this week; what the channel is shows
  // across both.
  const { data: best } = await supabase
    .from('videos').select('video_id, title, views')
    .eq('user_id', userId).order('views', { ascending: false }).limit(25);
  const bestTitles = (best ?? [])
    .filter((v: { video_id: string }) => /^[\w-]{11}$/.test(v.video_id))
    .slice(0, 10)
    .map((v: { title: string; views: number }) => `- ${v.title} (${(v.views ?? 0).toLocaleString()} views)`)
    .join('\n');

  const previous = row?.brain as ChannelBrain | null;
  const edits = row?.brain_overrides as BrainOverrides | null;

  // Legacy accounts filled in four boxes; those are still the only thing some
  // of them have said about themselves, so they go in as "what they wrote"
  // rather than being thrown away on the first rebuild.
  const stated = [
    row?.channel_description && `About them, in their words: ${row.channel_description}`,
    row?.channel_niche && `Niche they picked: ${row.channel_niche}`,
    row?.target_audience && `Audience they named: ${row.target_audience}`,
    row?.channel_context && `Extra context they added: ${row.channel_context}`,
    GOALS[row?.channel_goal] && `What they want from their videos: ${GOALS[row.channel_goal]}`,
  ].filter(Boolean).join('\n') || 'They wrote nothing about themselves.';

  const level = (row?.creator_level as string) || 'intermediate';

  if (!scan && !row?.social_summary && stated.startsWith('They wrote nothing')) return null;

  const prompt = `You are building the working profile of one short-form creator. Everything this product later writes for them - competitor ideas remade for their channel, outlines, hook rewrites - is written against this profile, so it has to be true to the channel they are making now.

## What they told us
Level: ${level}. ${LEVEL_GUIDANCE[level] || LEVEL_GUIDANCE.intermediate}
${stated}

## What they actually publish
${scanEvidence(scan)}
${bestTitles ? `\nTheir most viewed videos of all time:\n${bestTitles}\n` : ''}${row?.social_summary ? `\n## How their TikToks and Reels did\n${row.social_summary}\n` : ''}${retentionEvidence(row?.retention_lessons as RetentionLessons | null)}${previous?.summary ? `
## The previous read (last week)
${previous.summary}
Niche: ${previous.niche} | Format: ${previous.format}
Keep what still holds. Change it only where the uploads have actually moved or what they wrote says otherwise, not because of one new video.
` : ''}${edits && Object.keys(edits).length ? `
## Corrections the creator made by hand
${Object.entries(edits).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('\n')}
These are true. Build around them; never contradict them.
` : ''}
Describe what is STABLE across many uploads. A topic, joke, guest or format that shows up once, or only in the last few videos, is not the channel: do not name it in the profile and do not build rules around it. Rules and strengths have to hold for the next ten videos, not describe the last two.

Use the uploads for how the channel is made and what has worked: format, voice, strengths, the view range. What they wrote about their channel decides its subject (Ivan, 2026-11-09: creators change direction, and old uploads kept pulling every idea back to the old topic). Where the uploads are about something else, write the summary, niche, audience and adapt_rules for what they say it is now. If they wrote nothing, the uploads decide everything. If there are no uploads, work from what they wrote and keep every claim to what it supports - do not invent a format, a voice or an audience out of one sentence.

Pay attention to the view range. An idea that only works at a scale they are nowhere near is not useful to them, and neither is advice pitched at a level they are past.

Answer with JSON and nothing else:
{
  "summary": "2-4 sentences, second person, addressed to the creator: what their channel is, who turns up for it, and where it stands. Concrete. No praise, no filler, no 'you seem to be'.",
  "niche": "the subject, lowercase. Use one of these words where one honestly fits, because it is the key channels get grouped and benchmarked by: ${NICHES.join(', ')}. Add a second, comma-separated, only when the channel genuinely straddles two. If none of them fit, write your own 1-3 words.",
  "format": "the shape of a typical video: length, whether they are on camera, what the footage is, how it is edited, what the recurring structure is",
  "audience": "who watches, in one sentence - age, why they clicked, what they came for",
  "voice": "how it sounds and reads: pace, tone, humour, on-screen text style",
  "strengths": ["2-4 things this channel already does that work, each specific enough to be worth repeating"],
  "watch_outs": ["2-4 things to avoid when writing for them, at their level - formats they cannot execute, scales they are nowhere near, habits the uploads show going wrong"],
  "adapt_rules": ["3-5 instructions for remaking someone else's video on THIS channel: what to keep, what to swap, what will never fit. Written as orders to whoever is doing the adapting, not as advice to the creator."]
}`;

  const raw = await callLLM(prompt + languageRule(await loadLanguage(supabase, userId)), { maxTokens: 1200, tier: 'writer' });
  const parsed = parseModelJson<Partial<ChannelBrain>>(raw, 'channel brain');

  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, 6) : [];

  const brain: ChannelBrain = {
    summary: String(parsed.summary || '').trim(),
    niche: String(parsed.niche || '').trim().slice(0, 80),
    format: String(parsed.format || '').trim(),
    audience: String(parsed.audience || '').trim(),
    voice: String(parsed.voice || '').trim(),
    strengths: asList(parsed.strengths),
    watch_outs: asList(parsed.watch_outs),
    adapt_rules: asList(parsed.adapt_rules),
    source: scan?.videos?.length ? 'uploads' : 'stated',
  };

  if (!brain.summary) throw new Error('The model returned a profile with nothing in it');

  // The derived niche and audience are written back to the columns they used
  // to be typed into. Nothing asks for them on screen any more, but six
  // functions still read them, and a brain that quietly left them empty would
  // break competitor search for every account that rebuilt one.
  await supabase.from('user_tokens').update({
    brain,
    brain_at: new Date().toISOString(),
    ...(brain.niche ? { channel_niche: brain.niche } : {}),
    ...(brain.audience ? { target_audience: brain.audience } : {}),
  }).eq('user_id', userId);

  return brain;
}

// What the creator changed by hand in Settings. Kept apart from the brain so a
// rebuild (weekly, by the cron) can never overwrite it: the read is merged
// with the edits every time it is loaded, and the edits win.
export type BrainOverrides = Partial<Pick<ChannelBrain,
  'summary' | 'niche' | 'format' | 'audience' | 'voice' | 'strengths' | 'watch_outs' | 'adapt_rules'>>;

export function mergeBrain(brain: ChannelBrain | null, overrides: BrainOverrides | null): ChannelBrain | null {
  if (!brain) return null;
  if (!overrides) return brain;
  const out = { ...brain };
  for (const [k, v] of Object.entries(overrides)) {
    if (Array.isArray(v) ? v.length : typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export async function loadBrain(supabase: any, userId: string): Promise<ChannelBrain | null> {
  const { data } = await supabase
    .from('user_tokens').select('brain, brain_overrides, retention_lessons, social_summary, channel_description, channel_goal').eq('user_id', userId).maybeSingle();
  const brain = mergeBrain((data?.brain as ChannelBrain) ?? null, (data?.brain_overrides as BrainOverrides) ?? null);
  const lessons = data?.retention_lessons as RetentionLessons | null;
  if (!brain) return brain;
  return {
    ...brain,
    retention: lessons?.lessons?.length ? lessons : brain.retention,
    social: data?.social_summary ?? null,
    direction: data?.channel_description?.trim() || null,
    goal: data?.channel_goal ?? null,
  };
}

// For the brain's own read: the retention lessons are evidence about what
// works on the channel, measured rather than inferred from titles.
function retentionEvidence(l: RetentionLessons | null): string {
  if (!l?.lessons?.length) return '';
  return `
## What their real retention curves show (YouTube Analytics, ${l.videos} Shorts)
${l.summary}
${l.lessons.map(x => `- ${x.rule} (${x.evidence})`).join('\n')}
This is measured. Let it shape strengths and watch_outs where it applies.
`;
}

// The lessons as prompt lines, for brainBlock and brainLine.
function retentionLines(l: RetentionLessons | null | undefined, max: number): string {
  if (!l?.lessons?.length) return '';
  const nums = [
    l.stayed_median != null ? `${Math.round(l.stayed_median)}% of feed viewers stay past the first seconds` : null,
    l.avg_view_median != null ? `average view ${Math.round(l.avg_view_median)}% of the video` : null,
  ].filter(Boolean).join(', ');
  return `What their real retention shows (YouTube Analytics, ${l.videos} of their Shorts${nums ? `; usually ${nums}` : ''}): ${l.summary}
${l.lessons.slice(0, max).map(x => `- ${x.rule}`).join('\n')}`;
}

// The prompt block. One shape for every caller, so "their channel" means the
// same thing in an outline, a competitor adaptation and a follow-up answer.
export function brainBlock(brain: ChannelBrain | null): string {
  if (!brain) return '';
  const list = (xs: string[]) => xs.map(x => `- ${x}`).join('\n');
  return `
## Their channel
${brain.summary}
${brain.direction ? `\nWhat they say this channel is about now, in their words. This decides the subject of every idea; where it differs from anything below, it wins:\n${brain.direction}\n` : ''}${GOALS[brain.goal ?? ''] ? `What they want from these videos: ${GOALS[brain.goal!]}.\n` : ''}${brain.niche ? `Niche: ${brain.niche}` : ''}
${brain.format ? `Format: ${brain.format}` : ''}
${brain.audience ? `Audience: ${brain.audience}` : ''}
${brain.voice ? `Voice: ${brain.voice}` : ''}
${brain.strengths.length ? `\nWhat already works for them:\n${list(brain.strengths)}` : ''}
${brain.watch_outs.length ? `\nDo not suggest:\n${list(brain.watch_outs)}` : ''}
${brain.adapt_rules.length ? `\nWhen remaking anything for this channel:\n${list(brain.adapt_rules)}` : ''}
${brain.retention?.lessons?.length ? `\n${retentionLines(brain.retention, 5)}\nThese come from their own viewers, so they outrank general advice: write every hook, opening and ending against them.` : ''}
${brain.social ? `\nHow their TikToks and Reels did against their usual, by views:\n${brain.social}\nThe topics and openings that beat their usual are the ones to build on; lean away from what fell under it.\n` : ''}${brain.source === 'stated' && !brain.social
  ? '\nThis profile was written from what they told us; their channel is not connected, so none of it is confirmed by real uploads. Do not treat it as fact about their audience or their numbers.'
  : '\nThis profile was read off their real uploads. Trust it over anything the video in front of you implies about them.'}
This is background on who they are, not a checklist. Use the parts that matter for what is being asked and leave the rest out; do not work every point into every idea.`;
}

// The short form, for prompts that are deliberately cheap.
//
// A follow-up answer runs on under a thousand tokens of input by design, and
// dropping the full block into one would triple that for a question like "so
// should I repost it?". Four lines carry the part that changes an answer.
export function brainLine(brain: ChannelBrain | null): string {
  if (!brain) return '';
  return [
    `Their channel: ${brain.summary}`,
    brain.direction && `What they say it is about now, which decides the subject: ${brain.direction}`,
    brain.niche && `Niche: ${brain.niche}`,
    brain.format && `Format: ${brain.format}`,
    brain.audience && `Audience: ${brain.audience}`,
    retentionLines(brain.retention, 3),
    brain.social && `Their TikToks and Reels against their usual:\n${brain.social}`,
  ].filter(Boolean).join('\n');
}
