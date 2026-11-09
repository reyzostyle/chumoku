import { callLLM } from './llm.ts';
import { watchVideo } from './analyze-video.ts';
import { parseModelJson } from './json.ts';
import { platformOf, videoSource } from './social.ts';
import { currentRule } from './current.ts';

// The two model passes behind taking someone else's Short and making it yours:
// read what the video is and adapt it (enrich-competitor-video), then watch it
// and write the outline (generate-outline). steal-video runs both back to back
// on any Short. They live here so the three callers share one copy of each
// prompt instead of drifting apart.

export type Outline = { hook: string; sections: Array<{ title: string; content: string; duration: string }>; cta: string };

export function stripDashes(s: unknown): unknown {
  if (typeof s === 'string') return s.replace(/[—–]/g, '-');
  if (Array.isArray(s)) return s.map(stripDashes);
  if (s && typeof s === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(s as object)) out[k] = stripDashes((s as Record<string, unknown>)[k]);
    return out;
  }
  return s;
}

export async function fetchTranscript(videoId: string): Promise<string> {
  // Captions are a YouTube read. Without them the callers watch the video.
  if (platformOf(videoId) !== 'youtube') return '';
  try {
    const res = await fetch(
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!res.ok) return '';
    const data = await res.json();
    const events = data.events || [];
    return events
      .filter((e: any) => e.segs)
      .map((e: any) => e.segs.map((s: any) => s.utf8).join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

// Reads the video one of two ways, and the choice is not about cost.
//
// A transcript is free and enough most of the time. But plenty of Shorts have
// no captions at all - no speech, a non-English upload, an author who never
// enabled them - and the old path still charged a full credit to write a
// "breakdown" from a title and a view count. That is a worse answer at the same
// price, and nothing on screen said so. When there is no transcript the model
// watches the video instead: it costs us roughly ten times more on those, and
// the user pays the same one credit, because a predictable price is worth more
// than the margin on the minority of videos that have no captions.
export async function extractConceptAndAdapt(
  videoId: string,
  title: string,
  views: number,
  outlierScore: number | null,
  transcript: string,
  profileBlock: string,
  scanBlock: string,
  niche: string,
  chosen = '',
): Promise<{ concept: string; adapted_idea: string }> {
  const prompt = `You analyze competitor YouTube Shorts and extract the core concept, then adapt it for a different creator.

${profileBlock}${scanBlock}

Competitor video:
Title: ${title}
Views: ${views.toLocaleString()}
Performance: ${outlierScore ? `${outlierScore}x this channel's usual views per day - it outperformed their baseline` : 'N/A'}
${transcript ? `Transcript: ${transcript}` : 'This video has no captions, so you are watching it instead. Read the visuals: what is on screen in the opening second, where the cuts land, what any text overlay says.'}

Extract three things, in this order. The order is the method, not a formatting preference.

1. CONCEPT: what this video is and why it beat the channel's other uploads. 2-3 sentences. Topic included.

2. MECHANISM: the structural move that made it work, with the subject stripped out completely. Describe only the machine underneath: what the first frame shows, what tension is set up, what is withheld, where the turn lands, what the payoff is.
   BANNED from this field: any product, any brand, any software, any price, any money, and any category noun from the competitor's world (tool, app, agent, editor, gym, recipe, and so on). Write about the moves and about what each one does to the viewer's attention, nothing else.
   The test: if someone reading only your mechanism could guess what the competitor's video was about, you have not stripped it. Rewrite it.
   Right level: "open on a number the viewer finds painful, publicly wreck the thing it belongs to, then reveal something that does the same job for nothing, and prove the gap with one side-by-side."
   Wrong level: "compare a paid option with a free open-source alternative." That is still the topic wearing a coat.

3. ADAPTED_IDEA: the mechanism from step 2, applied to something THIS creator already makes videos about.
   Write it as 2-3 sentences describing the video they should make: what it is about, and what to put on screen at the turn. End with one working title in quotes.
   Do not return a list of titles. Do not return three alternatives. One idea, described.

The adapted idea is where this usually goes wrong, so check it against all three of these before you write it:
${chosen ? `- The creator already picked this idea from a card: "${chosen}". Develop exactly that. Do not swap it for a different video.\n` : ''}- It has to be about what THEIR viewers come for. When the competitor's video is already close to their subject, stay close: keep its promise and shape and change only what has to change. When it is far away, carry only the mechanism.
- They must plausibly be able to film it. Do not hand them a topic that needs expertise, footage, credentials or a job they do not have. ${niche ? `Their niche is "${niche}"` : 'They have not filled in a niche, so work entirely from what they publish'}, and their uploads above are what "their channel" means. Anything outside that is a wasted idea.
- Ask yourself: could this title sit in their upload list without looking like it belongs to someone else? If not, it is wrong. Rewrite it.

A competitor from a completely different niche is not a problem and is often the best case: the mechanism is what transfers, and one that arrives from another field is one their audience has not seen worn out.

Focus on what made this specific video out-perform the channel's other uploads, not on generic advice. Never open with a hedge about not knowing their niche - you have their uploads, use them.

Rules:
- Never use em-dash or en-dash. Only regular hyphen (-).
- Respond with JSON only.

{
  "concept": "...",
  "mechanism": "...",
  "adapted_idea": "..."
}${currentRule()}`;

  // `mechanism` is asked for and then thrown away. It exists to force the
  // separation between the move and the subject to actually happen: without it
  // the model reads "same concept, their subject matter" as licence to keep the
  // competitor's topic and swap a single noun, which is how a creator who
  // states plainly that he does not code was handed "make a video about a free
  // alternative to a paid AI coding tool". Storing it would mean a column, and
  // the value is in the model having had to write it, not in reading it back.
  const content = transcript
    ? await callLLM(prompt, { maxTokens: 1400, tier: 'writer' })
    : await watchVideo(
        await videoSource(videoId),
        prompt,
        { maxTokens: 4096 },
      );

  try {
    if (/\{[\s\S]*\}/.test(content)) {
      const parsed = parseModelJson(content);
      return {
        concept: String(stripDashes(parsed.concept) || ''),
        adapted_idea: String(stripDashes(parsed.adapted_idea) || ''),
      };
    }
    throw new Error('No JSON in response');
  } catch {
    // The answer is JSON that did not finish - almost always because it ran
    // into the token ceiling mid-string, so there is no closing brace for the
    // parser to reach. What used to happen here was worse than the failure:
    // the first 300 characters of the raw reply went into the field a creator
    // reads, backticks, "```json" and all.
    //
    // Salvage the one field that matters if it is there, cut at the last
    // sentence that finished so it does not end mid-word, and otherwise say
    // nothing. An empty section is a section that renders as empty; a section
    // showing someone a fenced code block is a bug they have to interpret.
    const match = content.match(/"concept"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!match) return { concept: '', adapted_idea: '' };

    const text = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/[—–]/g, '-')
      .trim();
    const lastStop = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
    return {
      concept: lastStop > 60 ? text.slice(0, lastStop + 1) : '',
      adapted_idea: '',
    };
  }
}

// The outline is written while WATCHING the competitor's video, not from a
// transcript of it. That is the whole point of the step: half of what makes a
// Short work is on screen and nowhere in the words - where the cut lands, what
// the overlay says, how the first frame is framed, how long the pause before
// the payoff is. Read blind, the model can only paraphrase the topic; watching,
// it can say "they hold on the reaction for a beat before cutting, do that".
export async function generateOutline(
  videoId: string,
  videoTitle: string,
  adaptedIdea: string,
  profileBlock: string,
  scanBlock: string,
  voice = '',
): Promise<Outline> {
  const prompt = `You are watching a competitor's YouTube Short that outperformed its channel. Write the outline for the version THIS creator should make.

The angle already worked out for them: ${adaptedIdea}
The video you are watching: "${videoTitle}"

${profileBlock}${scanBlock}${voice}

Watch it properly first. Note how the first frame is composed, what is on screen in the opening second, where the cuts land, what any text overlay says, and how long it sits before the payoff. Those are the parts that do not survive into a transcript, and they are what you are here to carry over.

Then write the outline for the creator's own version: same structural moves, their subject matter, their register. Say what to SHOW, not only what to say.

Follow this exact JSON format:

{
  "hook": "exact hook text spoken in first 3 seconds - make it punchy and attention-grabbing",
  "sections": [
    { "title": "Section name", "content": "what to say or show in this section", "duration": "10s" },
    { "title": "Section name", "content": "what to say or show in this section", "duration": "15s" },
    { "title": "Section name", "content": "what to say or show in this section", "duration": "20s" }
  ],
  "cta": "closing line that drives engagement or follow"
}

Rules:
- 3 to 4 sections total
- Hook must be the first thing said, not an intro
- Sections should build logically toward a payoff
- CTA should feel natural, not forced. If they do not usually end on a call to action, the CTA is just their usual last line
- Every section names something visual, not just a line to say
- The hook and every line to be said sound like THEM${voice ? ' (their register is described above)' : ''}: how a person talks to a camera, not how a copywriter writes. Short, plain, contractions. Sounding like them is not quoting them: no example lines, at most one of their usual words
- What you know about their channel is background. Use what fits this idea; do not drag in their recent topics or force their niche into a format that does not need it
- Never: "In this video", "Let's dive in", "Here's the thing", "game-changer", "unlock", "level up", "ever wondered", "you won't believe", rhetorical triplets, or any line that sounds like an ad
- No em-dash or en-dash, only regular hyphen (-)
- Respond with JSON only, no markdown${currentRule()}`;

  const content = await watchVideo(
    await videoSource(videoId),
    prompt,
    // Roomy: a truncated outline is a total loss, and the request is already
    // paid for by the time the model starts writing.
    { maxTokens: 8192 },
  );

  try {
    if (/\{[\s\S]*\}/.test(content)) {
      return stripDashes(parseModelJson(content, 'outline')) as Outline;
    }
    throw new Error('No JSON in response');
  } catch (e) {
    console.error('[generate-outline] unparseable model output:', content.slice(0, 800));
    throw new Error(`Could not read an outline back from the video: ${e instanceof Error ? e.message : 'no JSON found'}`);
  }
}
