// deno-lint-ignore-file no-explicit-any
import { corsHeaders } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { languageRule, loadLanguage } from '../_shared/language.ts';
import { callLLM } from '../_shared/llm.ts';
import { loadVoiceBlock } from '../_shared/voice.ts';
import { loadBrain, brainBlock } from '../_shared/brain.ts';
import { loadChannelScan, channelScanBlock } from '../_shared/channel-scan.ts';
import { fetchTranscript, extractConceptAndAdapt, generateOutline } from '../_shared/steal.ts';
import { currentRule } from '../_shared/current.ts';
import { loadCreditStatus, canAfford, spendCredits, CREDIT_COSTS } from '../_shared/credits.ts';

// From an idea to the words to say, in one press (2026-10-28).
//
// It used to be three steps with three prices: reveal the angle (1, reads the
// video), build the outline (4, watches it), write the script (1). Ivan: the
// angle step is odd, it mostly repeats the pitch already on the card, and
// nobody wants three buttons for one text. So this does all of it, for
// CREDIT_COSTS.script, and the result is the script with the hook on top; the
// angle and outline are still worked out and stored (the chat reads them),
// just never asked for.
//
// - An idea from a Short: read it if not read yet, watch it if there is no
//   outline yet, then write. Steps already paid for under the old ladder are
//   reused, not redone.
// - An idea Chumoku researched (source 'ai'): no video, written from its
//   premise and suggested first line.
// - A script that already exists is handed back free. Rewrites happen in Chat.
const CORS = corsHeaders({ methods: 'POST, OPTIONS' });
const ADMIN_EMAIL = 'reyzostyle@gmail.com';

const SYSTEM = `You write talking-head scripts for vertical Shorts: one creator, on camera, talking straight to the phone.

You get an outline (what each beat is about, sometimes written as what to show), or for an idea with no outline just its premise and suggested first line, and what we know about the creator. Write the exact words they will read off a teleprompter.

Rules:
- Spoken words only. No stage directions, no brackets, no "[cut to]", no visual notes, no headings, no emojis.
- If the outline says to show something, turn it into what the creator SAYS while it is on screen, or describe it in words if it must land without visuals.
- The first line is the hook, tightened so it lands in the first two seconds.
- Short sentences. One idea per line. A line break between lines so it reads well on a prompter.
- Length: follow the creator's usual length when it is given. Without one, about 130-170 words. Shorts reward cutting.
- Sound like this creator talks, not like an ad. Plain words, no hype words. Only words they would really say, at their level of English: if they talk simply, write simply.
- End with the call to action from the outline, said naturally, or a light ending (a follow or a question, never a sales line).

Return only the script text.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const isAdmin = user.email === ADMIN_EMAIL;

    const { ideaId } = await req.json();
    if (!ideaId) return json({ error: 'ideaId required' }, 400);

    const { data: idea } = await supabase.from('competitor_ideas').select('*').eq('id', ideaId).eq('user_id', user.id).maybeSingle();
    if (!idea) return json({ error: 'Idea not found' }, 404);
    if (idea.script) return json({ success: true, idea, charged: 0 });

    const cost = CREDIT_COSTS.script;
    const status = await loadCreditStatus(supabase, user.id);
    if (!canAfford(status, cost, isAdmin)) return json({ error: 'limit_reached', cost }, 402);

    const own = idea.source === 'ai';
    const [brain, voice, scan, language] = await Promise.all([
      loadBrain(supabase, user.id), loadVoiceBlock(supabase, user.id), loadChannelScan(supabase, user.id),
      loadLanguage(supabase, user.id),
    ]);
    const lang = languageRule(language);
    const scanBlock = channelScanBlock(scan);

    // Their real length, from their latest Shorts. A fixed word count made a
    // 60-second script for someone who posts 30-second ones.
    const { data: lengths } = await supabase.from('videos').select('duration')
      .eq('user_id', user.id).gt('duration', 0).lte('duration', 180)
      .order('published_at', { ascending: false, nullsFirst: false }).limit(12);
    const secs = (lengths ?? []).map((v: any) => v.duration as number).sort((a: number, b: number) => a - b);
    const usual = secs.length >= 5 ? secs[Math.floor(secs.length / 2)] : null;
    const lengthLine = usual ? `\n\nTheir Shorts usually run about ${usual} seconds. Fit that length: about ${Math.round(usual * 2.7)} words spoken.` : '';

    let concept: string | null = idea.concept;
    let adapted: string | null = idea.adapted_idea;
    let outline = idea.outline as { hook: string; sections: { title: string; content: string; duration?: string }[]; cta: string } | null;

    if (!own) {
      const { data: profile } = await supabase
        .from('user_tokens').select('channel_niche, channel_description, channel_context, target_audience')
        .eq('user_id', user.id).maybeSingle();
      const profileBlock = brain ? brainBlock(brain) : `## What they told us about their channel
Niche: ${profile?.channel_niche || 'not set'}
Description: ${profile?.channel_description || 'not set'}
Audience: ${profile?.target_audience || 'not set'}
Extra context: ${profile?.channel_context || 'not set'}`;
      // Read: what the video is, and this creator's version of it.
      if (!adapted) {
        const transcript = await fetchTranscript(idea.video_id);
        const read = await extractConceptAndAdapt(
          idea.video_id, idea.video_title || '', idea.video_views || 0, idea.outlier_score ?? null,
          transcript, profileBlock + lang, scanBlock, brain?.niche || profile?.channel_niche || '', idea.pitch || '',
        );
        concept = read.concept || concept;
        adapted = read.adapted_idea || idea.pitch || null;
      }
      // Watch: the beats, the cuts, the first frame.
      if (!outline) {
        outline = await generateOutline(idea.video_id, idea.video_title || '', adapted || idea.pitch || '', profileBlock + lengthLine + lang, scanBlock, voice);
      }
    }

    const prompt = [
      brainBlock(brain) + lengthLine,
      voice,
      outline
        ? [
          adapted ? `THEIR ANGLE\n${adapted}` : '',
          `OUTLINE\nHook: ${outline.hook}\n${outline.sections.map(s => `${s.title}${s.duration ? ` (${s.duration})` : ''}: ${s.content}`).join('\n')}\nEnd: ${outline.cta}`,
        ].filter(Boolean).join('\n\n')
        : [
          `THE IDEA\n${idea.pitch ?? ''}`,
          adapted ? `PREMISE\n${adapted}` : '',
          idea.basis?.hook ? `SUGGESTED FIRST LINE\n${idea.basis.hook}` : '',
          idea.basis?.source ? `BASED ON\n${idea.basis.source}. Use only facts you are sure of; never invent numbers or quotes.` : '',
          'No outline: give it a hook, two or three beats and a light ending.',
        ].filter(Boolean).join('\n\n'),
      lang.trim(),
      currentRule().trim(),
    ].filter(Boolean).join('\n\n');

    const script = (await callLLM(prompt, { system: SYSTEM, maxTokens: 1200, tier: 'writer' }))
      .replace(/^```[a-z]*\n?|```$/g, '').replace(/[—–]/g, '-').trim();
    if (!script) throw new Error('Empty script');

    // Writing a script keeps the idea: it lands in Saved, as a steal does.
    const { data: updated, error } = await supabase.from('competitor_ideas')
      .update({ concept, adapted_idea: adapted, outline, script, liked: true })
      .eq('id', ideaId).select('*').single();
    if (error) throw error;
    await spendCredits(supabase, user.id, status, cost);
    return json({ success: true, idea: updated, charged: cost });
  } catch (e) {
    console.error('[write-script]', e);
    return json({ error: 'Could not write the script. Nothing was charged. Try again.' }, 500);
  }
});
