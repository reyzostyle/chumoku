import { corsHeaders } from '../_shared/http.ts';
import { loadVoiceBlock } from '../_shared/voice.ts';
import { currentRule } from '../_shared/current.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { callLLMWithTools } from '../_shared/llm.ts';
import { parseImages } from '../_shared/images.ts';
import { loadCreditStatus, canAfford, spendCredits, CREDIT_COSTS } from '../_shared/credits.ts';
import { CREATOR_TOOLS, runCreatorTool } from '../_shared/creator-tools.ts';
import { SYSTEM } from '../_shared/chat-prompt.ts';
import { loadBrain, brainLine } from '../_shared/brain.ts';
import { chatLanguageRule, loadLanguage } from '../_shared/language.ts';
import { ownVideoRetention, retentionBlock, loadUsual } from '../_shared/retention.ts';

const CORS = corsHeaders({ methods: 'POST, OPTIONS' });

const ADMIN_EMAIL = 'reyzostyle@gmail.com';

// The chat endpoint. The slug still says "followup" because that is what it
// was when Analyze first became a conversation, and the deployed name is what
// the client, the dashboard and the logs all key on; renaming it to match what
// it grew into would buy a caption and cost a deployment.
//
// What it does now is two jobs:
//
//   1. Answer a follow-up about a review already in the thread. Unchanged.
//   2. Decide what an unprompted message even IS, and answer it if it is a
//      question.
//
// (2) is new because the client had no router at all: anything without a link
// went to analyze-hook-text or analyze-script-text on nothing more than "is it
// longer than 200 characters". Ask "why did my last short flop?" and it came
// back scored out of 100 as though the question were a hook. That is the one
// behaviour that makes the product feel broken rather than early.

// One prompt, one call, every message. There is no longer a branch that
// decides what a message is before asking - the model classifies and answers in
// the same call, whether or not a review is already on screen.
//
// What that replaced: three places where the code guessed. A message arriving
// after a review was assumed to be a question about it, so a hook typed at that
// point got chatted about instead of scored. Text riding along with a link was
// only treated as a question if it contained a question mark. And a link to a
// video already in the thread was assumed to be a reference rather than a
// request. Each guess was cheap and each one was wrong often enough to make the
// product feel unreliable, which costs more than the credit it saved.
//
// Classifying and answering together keeps a question at one round trip; a hook
// or a script pays this one cheap call before the real analysis, which is
// invisible next to the seconds that analysis takes.
//
// The hard case is not question-versus-script, it is question-versus-hook: both
// are one short line, and "how i made $10k in a month" is a hook while "how do
// i make $10k a month" is a question. The rule that separates them is who the
// line is aimed at - a hook is written AT an audience, a question is addressed
// TO you - so that is the rule the prompt is given, with the near misses spelled
// out rather than left to be inferred.

interface ProfileRow {
  channel_niche?: string | null;
  channel_description?: string | null;
  target_audience?: string | null;
  creator_level?: string | null;
}

const profileBlock = (p: ProfileRow | null) =>
  [
    p?.channel_niche && `Niche: ${p.channel_niche}`,
    p?.channel_description && `Channel: ${p.channel_description}`,
    p?.target_audience && `Audience: ${p.target_audience}`,
    p?.creator_level && `Level: ${p.creator_level}`,
  ].filter(Boolean).join('\n');

// Scoring hooks and scripts out of 100 was removed on 2026-09-29, with the
// score on video reviews: a number made Chumoku read as a grader. A hook
// handed over now gets an answer in words and a better line.

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
    }

    // threadId is optional now: the first message of a conversation can be a
    // question, and there is no thread until something is worth keeping.
    const { threadId, question, image, images: rawImages, ideaId, videoId: askedVideo } = await req.json();

    // `image` is still read so a client from before the array shipped keeps
    // working across the gap between the two deploys.
    const { images, error: imageError } = parseImages(rawImages ?? image);
    if (imageError) {
      return new Response(
        JSON.stringify({ error: imageError }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // A screenshot is a message on its own: "why did this happen" is often just
    // the picture. Text stays required when there is nothing else to look at.
    const hasImage = images.length > 0;
    if (!question?.trim() && !hasImage) {
      return new Response(JSON.stringify({ error: 'question required' }), { status: 400, headers: CORS });
    }

    const isAdmin = user.email === ADMIN_EMAIL;
    const creditStatus = await loadCreditStatus(supabase, user.id);
    // Checked before the routing call, not only before the answer: routing
    // costs a model call, and an account at zero should not get those for free
    // just because its message might turn out to be a hook.
    if (!canAfford(creditStatus, CREDIT_COSTS.chat_followup, isAdmin)) {
      return new Response(
        JSON.stringify({ error: 'Your credits are used up. Upgrade to keep going.' }),
        { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const { data: profile } = await supabase
      .from('user_tokens')
      .select('channel_niche, channel_description, target_audience, creator_level')
      .eq('user_id', user.id)
      .maybeSingle();
    // The brain in its short form - four lines, not the whole block. A
    // follow-up runs on under a thousand tokens of input by design.
    const [brain, language] = await Promise.all([loadBrain(supabase, user.id), loadLanguage(supabase, user.id)]);

    // ── Load the thread, if there is one ─────────────────────────────────────
    // Scoped to its owner here rather than trusted from the body.
    let analysis: Record<string, unknown> | null = null;
    let earlierReviews = 0;
    let history = '';
    let analysisId: string | null = null;
    if (threadId) {
      const { data: thread } = await supabase
        .from('chat_threads').select('id, analysis_id').eq('id', threadId).eq('user_id', user.id).maybeSingle();
      analysisId = thread?.analysis_id ?? null;
      if (!thread) {
        return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: CORS });
      }
      const { data: messages } = await supabase
        .from('chat_messages')
        .select('role, content, analysis')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true });

      const rows = messages ?? [];
      // The LAST review, not the first. A thread can hold more than one now -
      // paste a second link and it gets scored in place - and grounding the
      // answer in the oldest one would have it confidently describing a video
      // that scrolled off the screen two reviews ago.
      const reviewed = rows.filter(m => m.analysis);
      analysis = reviewed.length ? reviewed[reviewed.length - 1].analysis : null;
      earlierReviews = Math.max(0, reviewed.length - 1);
      // Only the tail: on a thread with a review, that review is the context
      // that matters and a long history would push it out of the window.
      history = rows
        .filter(m => !m.analysis)
        .slice(-8)
        .map(m => `${m.role === 'user' ? 'Creator' : 'You'}: ${m.content}`)
        .join('\n');
    }

    // The screenshot itself is not stored anywhere - there is no bucket for it
    // yet - so the transcript keeps the fact that there was one. Reopening the
    // thread later shows the question and the answer without the image.
    const shotTag = images.length > 1 ? `[${images.length} screenshots]` : '[screenshot]';
    const storedQuestion = question?.trim()
      ? (hasImage ? `${shotTag} ${question.trim()}` : question.trim())
      : shotTag;

    const persist = async (answer: string) => {
      if (!threadId) return;
      await supabase.from('chat_messages').insert([
        { thread_id: threadId, user_id: user.id, role: 'user', content: storedQuestion },
        { thread_id: threadId, user_id: user.id, role: 'assistant', content: answer },
      ]);
      await supabase.from('chat_threads').update({ updated_at: new Date().toISOString() }).eq('id', threadId);
    };

    // One path. The review, when there is one, is context in the same prompt
    // rather than a branch that skips the classification.
    const a = (analysis ?? {}) as {
      overall_assessment?: string;
      strong_spots?: string[]; weak_spots?: string[];
      ownership?: 'mine' | 'theirs' | 'unknown';
    };

    // Whose video the review is about, stated as a fact.
    //
    // The prompt used to carry a caution - "not necessarily theirs, do not
    // assume they made it" - with nothing behind it, so the model guessed, and
    // it guesses "yours". Asked how to adapt someone else's Short, it
    // congratulated the creator on a 91 they had not earned, for a video they
    // had never made. The signal to settle it has been computed and written to
    // the analyses row since the ownership check was built; nothing ever read
    // it back.
    //
    // Reviews written before this shipped have no ownership field, and that is
    // honestly 'unknown' rather than a reason to guess.
    const OWNERSHIP_LINE: Record<string, string> = {
      mine: `This video IS theirs - it is on the channel connected to this account. Talk about it as their own work: their numbers, their footage, their next upload.`,
      theirs: `This video is NOT theirs. It is on someone else's channel and they are studying it. Never congratulate them on its score or call it their video. What they want from it is what to take and what will not transfer to their channel.`,
      unknown: `WHOSE VIDEO THIS IS IS UNKNOWN - the check could not run, usually because no YouTube account is connected. Do not state or imply either way. Write the answer so it holds whoever made it, and if the answer genuinely turns on it, say in one line that connecting their YouTube in Settings is what settles it.`,
    };
    const ownershipLine = OWNERSHIP_LINE[a.ownership ?? 'unknown'];
    const level = profile?.creator_level ? `Level: ${profile.creator_level}` : '';
    const block = brain
      ? [brainLine(brain), level].filter(Boolean).join('\n')
      : profileBlock(profile);
    const reviewBlock = analysis
      ? `${earlierReviews ? `(${earlierReviews} earlier ${earlierReviews === 1 ? 'video was' : 'videos were'} reviewed in this thread. The one below is the latest.)\n\n` : ''}## Whose video this is
${ownershipLine}

## What you told them after watching
${a.overall_assessment ?? ''}

What works:
${(a.strong_spots ?? []).map(s => `- ${s}`).join('\n') || '- none noted'}

What to fix:
${(a.weak_spots ?? []).map(s => `- ${s}`).join('\n') || '- none noted'}

`
      : '';

    // The reviewed video's real retention, when the video is theirs.
    //
    // "How do I improve this video's script?" after a review was answered from
    // the review alone, and the review's drops were the model's own reading
    // of a curve summarised badly: "a 25% drop at 0:05-0:07" on a Short whose
    // curve falls from 142% to 63% between 0:04 and 0:12. The measured curve,
    // with what is said at each second, now sits beside the review and wins
    // over it.
    let retention = '';
    if (analysis && analysisId) {
      const { data: an } = await supabase
        .from('analyses').select('video_ids, is_my_video, hook_analysis')
        .eq('id', analysisId).eq('user_id', user.id).maybeSingle();
      const videoId = an?.video_ids?.[0];
      const mine = an?.hook_analysis?.ownership === 'mine' || an?.is_my_video === true;
      if (videoId && mine) {
        const { row } = await ownVideoRetention(supabase, user.id, videoId, { beats: true });
        if (row) retention = `${retentionBlock(row, await loadUsual(supabase, user.id, videoId), { script: true })}\nWhere this and the review above disagree about when or how many people left, this is right and the review is wrong.\n\n`;
      }
    }

    // A conversation opened from the retention screen ("Fix this drop",
    // "Improve the script") names its Short. Theirs or nothing: the stored
    // row is read under their own id, and a live read only answers for the
    // channel connected to this account.
    if (!retention && typeof askedVideo === 'string' && /^[\w-]{11}$/.test(askedVideo)) {
      const { row } = await ownVideoRetention(supabase, user.id, askedVideo, { beats: true });
      if (row) retention = `## The Short they are asking about\nOne of their own, opened from its retention curve. "This Short", "this video" and "the drop" mean this one.\n\n${retentionBlock(row, await loadUsual(supabase, user.id, askedVideo), { script: true })}\n\n`;
    }

    // The saved idea the message is about, when it was sent from an idea's
    // "Write the script" step. Read here, scoped to its owner, so the script
    // follows the outline that was actually built rather than whatever a
    // lookup by name turned up.
    let ideaBlock = '';
    if (typeof ideaId === 'string' && ideaId) {
      const { data: idea } = await supabase
        .from('competitor_ideas')
        .select('pitch, adapted_idea, outline, script, video_title, channel_name, source, basis')
        .eq('id', ideaId).eq('user_id', user.id).maybeSingle();
      if (idea) {
        const o = idea.outline as { hook?: string; sections?: Array<{ title: string; content: string; duration: string }>; cta?: string } | null;
        ideaBlock = `## The idea they mean
Their version: ${idea.pitch || idea.adapted_idea || ''}
${idea.adapted_idea ? `${idea.source === 'ai' ? 'Premise' : 'Angle'}: ${idea.adapted_idea}\n` : ''}${idea.source === 'ai'
  ? `Not taken from anyone's video: Chumoku ${idea.basis?.kind === 'remix' || idea.basis?.title
      ? `suggested it as a remix of their own Short "${idea.basis?.title}" (${idea.basis?.multiple}x their usual views)`
      : `researched it for their channel${idea.basis?.source ? `, based on: ${idea.basis.source}` : ''}`}.${idea.basis?.hook ? ` Suggested first line: "${idea.basis.hook}".` : ''}${idea.basis?.why ? ` Why it fits: ${idea.basis.why}.` : ''} Untested, so say so if they ask how sure it is.`
  : `Stolen from: "${idea.video_title ?? ''}" (${idea.channel_name ?? 'another channel'})`}
${o ? `Outline already agreed - the script follows it beat for beat:
Hook: ${o.hook ?? ''}
${(o.sections ?? []).map(sec => `- ${sec.duration} ${sec.title}: ${sec.content}`).join('\n')}
End: ${o.cta ?? ''}` : ''}
${idea.script ? `\nThe script already written for it (they will want changes to THIS text; when you rewrite it, give the whole new version):\n\"\"\"\n${idea.script}\n\"\"\"` : ''}

`;
      }
    }

    const messageBlock = question?.trim()
      ? `## Their message\n"""\n${question.trim()}\n"""`
      : '## Their message\nThey sent the screenshot with no text.';

    const voice = await loadVoiceBlock(supabase, user.id);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const prompt = `${chatLanguageRule(language)}## Today\n${today}${currentRule()}\n\n${block ? `## Who you are talking to\n${block}\n\n` : ''}${voice}${ideaBlock}${reviewBlock}${retention}${history ? `## The conversation so far\n${history}\n\n` : ''}${hasImage ? `## Attached\n${images.length === 1 ? 'A screenshot is' : `${images.length} screenshots are`} attached above. They are the evidence for whatever they are asking.\n\n` : ''}${messageBlock}`;

    // One call, tools on it. A lookup pays for a second round trip only when
    // the answer depends on something only this account knows.
    const toolsUsed: string[] = [];

    const answer = await callLLMWithTools(prompt, {
      system: SYSTEM,
      tier: 'writer',
      // Roomier than a follow-up needs, because the same call has to be able
      // to return a finished script. 900 was sized for "a few sentences" and
      // would have truncated one mid-line.
      maxTokens: 2000,
      images,
      tools: CREATOR_TOOLS,
      onToolUsed: c => toolsUsed.push(c.name),
      run: c => runCreatorTool(supabase, user.id, c),
    });
    if (toolsUsed.length) console.log(`[chat-followup] tools: ${toolsUsed.join(', ')}`);

    // The model wrote nothing, which it does on a bare "hey". An error notice
    // for saying hello is worse than a plain opening line.
    const clean = answer.replace(/[\u2014\u2013]/g, '-').trim()
      || (hasImage
        ? 'I can see the screenshot but did not get a clear read on it. Tell me what you want to know about it.'
        : 'What are you working on?');

    await persist(clean);
    await spendCredits(supabase, user.id, creditStatus, CREDIT_COSTS.chat_followup);
    return new Response(JSON.stringify({
      // Kept for clients from before this shipped: they branch on it, and
      // "question" is the only branch that renders an answer.
      intent: 'question',
      answer: clean,
    }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[chat-followup]', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
