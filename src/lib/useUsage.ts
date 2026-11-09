import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from './supabase';

// Mirrors supabase/functions/_shared/credits.ts — kept in sync manually,
// same as the rest of this app's plan-limit constants (no shared package
// between edge functions and the client). Free's allowance is a ONE-TIME
// grant (see credits.ts's loadCreditStatus) — that's the entire free tier,
// no separate trial mechanism. See credits.ts for how these numbers were
// picked (worst-case $ budget, compressed real-cost ratios) — and for why the
// dollar figures written down there are stale by roughly 4.4x since the model
// moved off Claude Sonnet.
// 2026-10-28 (Ivan): free 0, Plus 100, Pro 300. Free keeps the daily drop and
// nothing else; credits are what you pay for. Sized on Gemini 3.8 Flash at its
// 2027 price ($1.50/$7.50 per MTok): worst case ~$0.03 a credit (a chat answer
// that writes a full script), so ~$3 (Plus) and ~$9 (Pro) at the ceiling,
// plus ~$1.50 a month of daily-drop research per active user. Measured usage
// over the 30 days before: 10-20 credits per active user.
export const CREDIT_LIMITS: Record<string, number> = { free: 0, pro: 100, agency: 300 };
// Two prices since 2026-10-28 (Ivan): 3 for anything that makes something
// (a script from an idea, a steal, a video review, five more ideas), 1 for a
// chat message. Plus 100 is ~30 scripts, Pro 300 ~100. The most expensive of
// them, a script that watches the source Short, is ~$0.05 at 2027 Gemini
// prices, ~$0.017 a credit: under the ~$0.03 worst case the limits are sized on.
// competitor_idea / competitor_outline are the old angle and outline steps,
// kept only for clients that still call enrich-competitor-video and
// generate-outline.
export const CREDIT_COSTS = {
  video_analysis: 3,
  // From an idea to a finished script in one press (write-script): reads
  // and watches the source when there is one, then writes.
  script: 3,
  // One credit each since scoring became a tool inside the chat's answer
  // rather than its own screen. Mirrors _shared/credits.ts.
  competitor_idea: 1,
  // Watches the competitor's video before writing, so it costs what watching
  // costs. Mirrors _shared/credits.ts.
  competitor_outline: 4,
  competitor_script: 1,
  // Ten more ideas once today's are used up (2026-10-11). Pitching is one
  // cheap call, but finding them reads YouTube, which is the scarce part.
  more_ideas: 3,
  // Analyze is the whole product now: a link, a hook, a script and every
  // follow-up all land in the one thread. A follow-up answers from the
  // analysis already in the thread rather than watching the video again, so
  // it is the cheapest action there is - but it is not free, because a chat
  // with no price on it is a thread someone can leave running all afternoon.
  chat_followup: 1,
} as const;

// DB value → display name
export const PLAN_DISPLAY: Record<string, string> = {
  free: 'No plan',
  pro: 'Plus',
  agency: 'Pro',
};

export interface UsageData {
  plan: string;
  creditsUsed: number;
  creditsLimit: number;
  canAnalyze: boolean;
}

// Shared between UpgradePage (needs current plan for the checkout grid) and
// the Credits card in Settings (needs the full numbers) so the quota math and query live in one
// place instead of drifting between two copies.
export function useUsage() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const { data: tokenRow, error: dbError } = await supabase
        .from('user_tokens')
        .select('plan, credits_used, bonus_credits')
        .eq('user_id', user.id)
        .maybeSingle();

      if (dbError) throw dbError;

      const plan = tokenRow?.plan || 'free';
      const creditsUsed = tokenRow?.credits_used || 0;
      const creditsLimit = (CREDIT_LIMITS[plan] ?? CREDIT_LIMITS.free) + (tokenRow?.bonus_credits || 0);
      const canAnalyze = creditsUsed < creditsLimit;

      setUsage({ plan, creditsUsed, creditsLimit, canAnalyze });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (user) reload();
  }, [user?.id, reload]);

  return { usage, loading, error, reload };
}
