import { callLLM } from './llm.ts';

// One YouTube search phrase for a creator's subject. Shared by auto-find
// (find-competitor-channels) and the daily drop (daily-ideas), which both go
// looking for other people winning on the same topic.

// deno-lint-ignore no-explicit-any
export async function buildQuery(scan: any, niche: string, description: string): Promise<string> {
  const titles = (scan?.videos ?? []).slice(0, 20).map((v: any) => `- ${v.title}`).join('\n');

  // Raw titles make terrible queries: they are full of hashtags, emoji and
  // in-jokes. One cheap call turns them into the phrase a viewer would type.
  const prompt = `A creator wants to find other YouTube channels making short-form videos on their subject.

What they say their channel is about:
Niche: ${niche || 'not set'}
Description: ${description || 'not set'}

The titles of their own recent uploads:
${titles || 'none available'}

Write ONE YouTube search phrase in ENGLISH that would surface popular Shorts on the same subject, made by other people. Two to five words, the words an English-speaking viewer would actually type, no hashtags, no emoji, no channel names, no quotes. Reply with the phrase and nothing else.`;

  const raw = await callLLM(prompt, { maxTokens: 40 });
  return raw.replace(/["'\n#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Several phrases, each a different way into the same subject. The daily drop
// searches all of them, because one phrase keeps returning the same dozen
// channels and the drop runs dry within a week.
// deno-lint-ignore no-explicit-any
export async function buildQueries(scan: any, niche: string, description: string, count = 3): Promise<string[]> {
  const titles = (scan?.videos ?? []).slice(0, 20).map((v: any) => `- ${v.title}`).join('\n');

  const prompt = `A creator wants to find popular Shorts by OTHER people on their subject, to borrow formats from.

What they say their channel is about:
Niche: ${niche || 'not set'}
Description: ${description || 'not set'}

The titles of their own recent uploads:
${titles || 'none available'}

If what they say differs from those titles, search for what they say.

Write ${count} different YouTube search phrases in ENGLISH. Each one should come at the subject from a different angle (the game or topic itself, the format, the audience's in-jokes), so together they surface different channels. Two to five words each, the words an English-speaking viewer would actually type, no hashtags, no emoji, no channel names, no quotes.

Reply with the phrases only, one per line.`;

  const raw = await callLLM(prompt, { maxTokens: 80 });
  const phrases = raw.split('\n')
    .map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').replace(/["'#]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60))
    .filter(l => l.length >= 3);
  return [...new Set(phrases)].slice(0, count);
}
