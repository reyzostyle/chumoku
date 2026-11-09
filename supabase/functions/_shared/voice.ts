// deno-lint-ignore-file no-explicit-any
import { watchVideo } from './analyze-video.ts';
import { callLLM } from './llm.ts';
import { parseModelJson } from './json.ts';

// How this creator actually talks on camera, taken from their own Shorts.
//
// Ivan, 2026-10-10: scripts and outlines read like AI, not like the person
// filming them. The brain's "voice" field could not fix that: it is written
// from titles, so it comes out as "Direct, informal, fast-paced", which
// describes half of YouTube and gives a model nothing to copy. Five transcripts
// existed across all users, so there was no text to learn from either.
//
// So the model watches the creator's two best-performing Shorts and writes down
// what it hears: the opening lines verbatim, the words they reach for, how long
// their sentences run, what they put on screen. Writers then get real lines to
// match instead of adjectives. Built in the background (daily-ideas cron),
// checked weekly (the model only runs again when the month's top Shorts have
// changed), and absent for anyone without a connected channel, in which case
// everything falls back to the brain as before.
//
// The risk with handing a model real lines is that it pastes them back: in the
// first test a 30-second script used "literally" twice and every catchphrase in
// the list. So the block says what the examples are for, shows a different
// few each time, and caps their phrases at one per script.

export interface CreatorVoice {
  example_lines: string[];   // verbatim, as spoken
  how_they_talk: string;     // concrete: sentence length, person, energy, slang
  words_they_use: string[];
  never: string[];           // things that would sound wrong from them
  hook_style: string;
  on_screen: string;
  built_from: string[];      // video ids
}

export const VOICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAMPLES = 2;

// The voice block for a prompt: the heard profile, with the creator's own
// edit (brain_overrides.voice, from Settings) taking the place of the
// description when they wrote one.
export async function loadVoiceBlock(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase.from('user_tokens').select('voice, brain_overrides').eq('user_id', userId).maybeSingle();
  const v = data?.voice && Array.isArray(data.voice.example_lines) ? data.voice as CreatorVoice : null;
  return voiceBlock(v, data?.brain_overrides?.voice ?? null);
}

export async function loadVoice(supabase: any, userId: string): Promise<CreatorVoice | null> {
  const { data } = await supabase.from('user_tokens').select('voice').eq('user_id', userId).maybeSingle();
  const v = data?.voice;
  return v && Array.isArray(v.example_lines) ? v as CreatorVoice : null;
}

export function voiceBlock(voice: CreatorVoice | null, override?: string | null): string {
  if (!voice && !override) return '';
  if (!voice) return `## How they talk on camera (in their words)\n${override}\n\n`;
  // A different few lines each time, so no single line becomes the template.
  const lines = [...voice.example_lines].sort(() => Math.random() - 0.5).slice(0, 3);
  return `## How they talk on camera (heard in their own Shorts)
${override?.trim() || voice.how_they_talk}
Hooks: ${voice.hook_style}
On screen: ${voice.on_screen}
Their usual words: ${voice.words_they_use.join(', ') || 'none noted'}
Would sound wrong from them: ${voice.never.join('; ') || 'none noted'}
A few lines they really said:
${lines.map(l => `- "${l}"`).join('\n')}

How to use this: it is their register, not material. Match the sentence length, the plainness and the energy. Do not reuse those lines, and use at most one of their usual words in a script, only where it would come naturally. Whatever those videos were about is not a topic to bring back.

`;
}

// The two most viewed Shorts they posted in the last 30 days (Ivan's rule:
// "the month's two most popular"). A quiet month falls back to the best two of
// their ten latest. Recent rather than all-time because channels change: his
// all-time top Shorts are old Fortnite videos with a text-to-speech voiceover,
// and the first voice built from them described a channel he no longer makes.
// Only real YouTube ids: the table also holds demo rows ("rankdemo01").
async function topShorts(supabase: any, userId: string): Promise<{ video_id: string; title: string }[]> {
  const { data } = await supabase
    .from('videos').select('video_id, title, views, duration, published_at')
    .eq('user_id', userId).lte('duration', 180).gt('duration', 0)
    .order('published_at', { ascending: false, nullsFirst: false }).limit(25);
  const real = (data ?? []).filter((v: any) => /^[\w-]{11}$/.test(v.video_id));
  const byViews = (xs: any[]) => [...xs].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const month = real.filter((v: any) => v.published_at && Date.now() - new Date(v.published_at).getTime() < 30 * 86_400_000);
  const pick = month.length >= SAMPLES ? byViews(month) : byViews(real.slice(0, 10));
  return pick.slice(0, SAMPLES);
}

export async function buildVoice(supabase: any, userId: string): Promise<CreatorVoice | null> {
  const shorts = await topShorts(supabase, userId);
  if (shorts.length === 0) return null;

  // Same two videos as last time: nothing new to hear, no model call.
  const previous = await loadVoice(supabase, userId);
  const ids = shorts.map(s => s.video_id).sort().join(',');
  if (previous && [...previous.built_from].sort().join(',') === ids) return previous;

  const heard: string[] = [];
  for (const v of shorts) {
    try {
      const notes = await watchVideo(
        { fileUri: `https://www.youtube.com/watch?v=${v.video_id}`, mimeType: 'video/mp4' },
        `This is one of the creator's own YouTube Shorts ("${v.title}"). Listen to how they talk.

1. Write down, word for word, the first five to eight things they say. Exactly as spoken, filler words and slang included. Do not clean it up.
2. Then, in a few short lines: how long their sentences are, whether they talk to camera or narrate over footage, their energy, any phrases or slang they repeat, and what text or visuals they put on screen.

Plain text.`,
        { maxTokens: 1200 },
      );
      if (notes.trim()) heard.push(`Video: "${v.title}"\n${notes.trim()}`);
    } catch (e) {
      console.error(`[voice] could not watch ${v.video_id}:`, e);
    }
  }
  if (heard.length === 0) throw new Error('could not watch any of their Shorts');

  const raw = await callLLM(`Below are notes on how one creator talks in their own Shorts, including lines transcribed word for word.

${heard.join('\n\n')}

${previous ? `The profile from their earlier videos, for continuity:
How they talk: ${previous.how_they_talk}
Hooks: ${previous.hook_style}
Keep what still holds. Change only what these videos clearly show is different. A topic, joke or bit that appears in one video is a one-off, not part of how they talk.

` : ''}Turn this into a voice profile another writer can copy. Describe HOW they talk, not WHAT these particular videos were about. Be concrete: "sentences of four to eight words, says 'bro' and 'lowkey', talks straight to camera" is useful, "direct and engaging" is not.

Respond with JSON only:
{
  "example_lines": ["up to 8 lines copied verbatim from the transcripts above, the most characteristic ones"],
  "how_they_talk": "2-3 concrete sentences",
  "words_they_use": ["words or phrases they actually use"],
  "never": ["phrasings that would sound wrong coming from them, e.g. polished marketing language"],
  "hook_style": "how their videos open, concretely",
  "on_screen": "what they show and put as text on screen"
}

Never use an em-dash or en-dash.`, { maxTokens: 1500, tier: 'writer' });

  const p = parseModelJson(raw, 'voice') as Partial<CreatorVoice>;
  const arr = (x: unknown) => Array.isArray(x) ? x.map(String).map(s => s.replace(/[—–]/g, '-')).filter(Boolean) : [];
  const voice: CreatorVoice = {
    example_lines: arr(p.example_lines).slice(0, 8),
    how_they_talk: String(p.how_they_talk ?? '').replace(/[—–]/g, '-'),
    words_they_use: arr(p.words_they_use).slice(0, 15),
    never: arr(p.never).slice(0, 8),
    hook_style: String(p.hook_style ?? '').replace(/[—–]/g, '-'),
    on_screen: String(p.on_screen ?? '').replace(/[—–]/g, '-'),
    built_from: shorts.map(s => s.video_id),
  };
  if (voice.example_lines.length === 0) return null;

  await supabase.from('user_tokens')
    .update({ voice, voice_at: new Date().toISOString() }).eq('user_id', userId);
  return voice;
}
