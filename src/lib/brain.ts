import { FUNCTIONS_URL, getSessionToken, fetchWithRetry } from './supabase';


// The model's own read of a channel, built from the level and the sentence the
// creator wrote plus their last twenty uploads. It is what every prompt that
// adapts something "for your channel" is written against - see
// supabase/functions/_shared/brain.ts for the half that does the work.
export interface ChannelBrain {
  summary: string;
  niche: string;
  format: string;
  audience: string;
  voice: string;
  strengths: string[];
  watch_outs: string[];
  adapt_rules: string[];
  source: 'uploads' | 'stated';
}

// What the creator corrected by hand in Settings (user_tokens.brain_overrides).
// The server merges these over the read whenever it loads the brain.
export type BrainOverrides = Partial<Pick<ChannelBrain,
  'summary' | 'niche' | 'format' | 'audience' | 'voice' | 'strengths' | 'watch_outs' | 'adapt_rules'>>;

// What a creator wants from their videos (user_tokens.channel_goal).
export const CHANNEL_GOALS = [
  { value: 'sell', label: 'Sell something' },
  { value: 'followers', label: 'Get followers' },
  { value: 'viral', label: 'Go viral' },
  { value: 'other', label: 'Something else' },
];

export interface BrainResult {
  brain: ChannelBrain | null;
  // The server refused to rebuild because the last build was under a minute
  // ago, and handed back the stored one instead. Not an error - the screen
  // says so rather than pretending a rebuild happened.
  cached?: boolean;
  // 'nothing_to_read' means the account has told us nothing and connected
  // nothing. Not an error - a state the screen has a sentence for.
  reason?: string;
  error?: string;
}

export async function requestBrain(force = false): Promise<BrainResult> {
  const token = await getSessionToken();
  if (!token) return { brain: null, error: 'Not signed in' };
  const res = await fetchWithRetry(`${FUNCTIONS_URL}/build-brain`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { brain: null, error: data.error || 'Could not read your channel' };
  return data as BrainResult;
}
