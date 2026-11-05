import { useState } from 'react';
import { watchUrl } from '../lib/videoLinks';
import { AltArrowLeftOutlineIcon as ArrowLeft, SquareArrowRightUpOutlineIcon as ExternalLink } from '@solar-icons/react';
import { ShortThumb } from './ShortThumb';
import { formatViews, isOwnIdea, isOwnRemix, ownIdeaLabel, type FeedItem, type CompetitorIdea } from '../lib/competitors';
import { AiIdeaCover } from './AiIdeaCover';
import { useIdeaGeneration } from '../lib/useIdeaGeneration';
import { CREDIT_COSTS } from '../lib/useUsage';
import { PENDING_CHAT_KEY } from '../lib/intents';
import { resetAnalysisSession } from './AnalysisChat';
import { Page, Button, Skeleton } from './Page';
import { ErrorNotice } from './ErrorNotice';

// One idea, and one button to the script (2026-10-28).
//
// It was three locked steps: the angle (1 credit), the outline (4), the script
// (in Chat). Ivan: opening the angle is odd, it mostly repeats the pitch on
// the card, and three presses for one text is two too many. Now "Write my
// script" does the reading, watching and writing in one call (write-script),
// the script comes back with the hook on top, and "Continue in Chat" is where
// it gets argued with. The angle and outline are still made and kept, for the
// chat; nobody has to ask for them.
export function CompetitorVideoView({
  item, onBack, onSave, onDismiss, onUpdated, backLabel = 'Feed',
}: {
  backLabel?: string;
  item: FeedItem;
  onBack: () => void;
  onSave: () => void;
  onDismiss: () => void;
  onUpdated: (idea: CompetitorIdea) => void;
}) {
  const idea = item.idea;
  const isSaved = idea?.liked === true;
  const isDismissed = idea?.liked === false;

  const { generatingScript, generateScript, error, errorIsPlanLimit } =
    useIdeaGeneration(idea ?? ({ id: '' } as CompetitorIdea), onUpdated);

  // The chat, opened on this idea with its script, a first line waiting in
  // the composer. Kept, so it lands in Saved with the conversation.
  const continueInChat = () => {
    if (!idea) return;
    if (!isSaved) onSave();
    try {
      localStorage.setItem(PENDING_CHAT_KEY, JSON.stringify({ text: 'Make the hook of this script hit harder.', ideaId: idea.id, draft: true }));
    } catch { /* ignore */ }
    resetAnalysisSession();
    window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: 'analyze' }));
  };

  const errorBlock = error && (
    <div className="mb-6">
      {errorIsPlanLimit
        ? <p className="t-small" style={{ color: 'var(--text-muted)' }}>{error}</p>
        : <ErrorNotice message={error} />}
    </div>
  );
  const script = <ScriptCard idea={idea ?? null} writing={generatingScript} onWrite={generateScript} onChat={continueInChat} />;

  if (idea && isOwnIdea(idea)) {
    return (
      <OwnIdeaView idea={idea} backLabel={backLabel} onBack={onBack} onSave={onSave} onDismiss={onDismiss} error={errorBlock} script={script} />
    );
  }

  return (
    <Page className="animate-tab-in">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 mb-8 t-small transition-colors hover:text-[var(--text)]"
        style={{ color: 'var(--text-muted)' }}
      >
        <ArrowLeft className="w-4 h-4" /> {backLabel}
      </button>

      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 mb-12">
        <div className="idea-hero__media">
          <ShortThumb videoId={item.video_id} eager />
          {item.outlier_score != null && item.outlier_score < 1000 && (
            <span className="idea-card__mult">{item.outlier_score}×</span>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <p className="t-label mb-3" style={{ color: 'var(--text-muted)' }}>
            {[item.channel_name, item.video_views != null ? `${formatViews(item.video_views)} views` : null].filter(Boolean).join(' · ')}
            {' · '}
            <a href={watchUrl(item.video_id)} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1 transition-colors hover:text-[var(--text)]">
              watch <ExternalLink className="w-3 h-3" />
            </a>
          </p>
          <h1 className="t-title" style={{ color: 'var(--text)' }}>{idea?.pitch || item.video_title || 'Untitled video'}</h1>
          {idea?.pitch && item.video_title && (
            <p className="t-small mt-3" style={{ color: 'var(--text-faint)' }}>From “{item.video_title}”</p>
          )}
          <div className="flex items-center gap-2 mt-6">
            <Button variant={isSaved ? 'primary' : 'secondary'} size="sm" onClick={onSave}>{isSaved ? 'Saved' : 'Save'}</Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>{isDismissed ? 'Restore' : 'Dismiss'}</Button>
          </div>
        </div>
      </div>

      {errorBlock}
      {script}
    </Page>
  );
}

// An idea Chumoku found for the creator. No video to read or watch, so no
// angle or outline to unlock: the premise is already the angle, and the next
// step is the script.
function OwnIdeaView({ idea, backLabel, onBack, onSave, onDismiss, error, script }: {
  idea: CompetitorIdea;
  backLabel: string;
  onBack: () => void;
  onSave: () => void;
  onDismiss: () => void;
  error: React.ReactNode;
  script: React.ReactNode;
}) {
  const basis = idea.basis;
  return (
    <Page className="animate-tab-in">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 mb-8 t-small transition-colors hover:text-[var(--text)]"
        style={{ color: 'var(--text-muted)' }}
      >
        <ArrowLeft className="w-4 h-4" /> {backLabel}
      </button>

      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 mb-12">
        <div className="idea-hero__media"><AiIdeaCover idea={idea} /></div>

        <div className="flex-1 min-w-0 flex flex-col">
          <p className="t-label mb-3" style={{ color: 'var(--text-muted)' }}>{ownIdeaLabel(idea)}</p>
          <h1 className="t-title" style={{ color: 'var(--text)' }}>{idea.pitch}</h1>
          <div className="flex items-center gap-2 mt-6">
            <Button variant={idea.liked === true ? 'primary' : 'secondary'} size="sm" onClick={onSave}>{idea.liked === true ? 'Saved' : 'Save'}</Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>{idea.liked === false ? 'Restore' : 'Dismiss'}</Button>
          </div>
        </div>
      </div>

      {error}
      <ol className="flex flex-col gap-3 mb-3">
        <Step n={1} title="The idea" done>
          <p className="t-body" style={{ color: 'var(--text)' }}>{idea.adapted_idea}</p>
          {basis && (
            <p className="t-small mt-4" style={{ color: 'var(--text-muted)' }}>
              {isOwnRemix(basis)
                ? <>Built on your “{basis.title}”{basis.multiple >= 1.2 ? `, ${basis.multiple}× your usual views` : ''}.</>
                : 'source' in basis && basis.source ? <>Based on {basis.source}.</> : null}
              {basis.why ? ` ${basis.why.replace(/\.?$/, '.')}` : ''}
            </p>
          )}
        </Step>
      </ol>
      {script}
    </Page>
  );
}

// The one step: write the script, then take it to the chat.
function ScriptCard({ idea, writing, onWrite, onChat }: {
  idea: CompetitorIdea | null;
  writing: boolean;
  onWrite: () => void;
  onChat: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const own = isOwnIdea(idea);
  const text = idea?.script ?? null;
  const [hook, ...rest] = (text ?? '').split(/\n+/);
  return (
    <section className="idea-step">
      <div className="flex items-center gap-3 mb-4">
        <span className="idea-step__n" data-done={text ? 'true' : undefined}>{own ? 2 : 1}</span>
        <p className="t-heading" style={{ color: 'var(--text)' }}>Script</p>
      </div>
      {text ? (
        <div className="animate-msg-in">
          <p className="t-label mb-1.5" style={{ color: 'var(--text-muted)' }}>Hook</p>
          <p className="t-heading mb-4" style={{ color: 'var(--text)' }}>{hook}</p>
          <p className="t-body whitespace-pre-line" style={{ color: 'var(--text)' }}>{rest.join('\n')}</p>
          {idea?.concept && !own && (
            <details className="mt-4">
              <summary className="t-small cursor-pointer select-none" style={{ color: 'var(--text-faint)' }}>Why the original worked</summary>
              <p className="t-small mt-2" style={{ color: 'var(--text-muted)' }}>{idea.concept}</p>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-6">
            <Button variant="primary" onClick={onChat}>Continue in Chat</Button>
            <Button variant="ghost" onClick={() => {
              navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => {});
            }}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </div>
      ) : writing ? (
        <Working label={own ? 'Writing it in your voice' : 'Watching the video and writing it in your voice'} lines={5} />
      ) : (
        <Locked lines={5}>
          <Button variant="primary" onClick={onWrite} disabled={!idea || idea.id.startsWith('pending-')}>
            Write my script · {CREDIT_COSTS.script} credits
          </Button>
        </Locked>
      )}
    </section>
  );
}

function Step({ n, title, done, dim, children }: { n: number; title: string; done?: boolean; dim?: boolean; children: React.ReactNode }) {
  return (
    <li className="idea-step" data-dim={dim ? 'true' : undefined}>
      <div className="flex items-center gap-3 mb-4">
        <span className="idea-step__n" data-done={done ? 'true' : undefined}>{n}</span>
        <p className="t-heading" style={{ color: 'var(--text)' }}>{title}</p>
      </div>
      {children}
    </li>
  );
}

// A step not opened yet: its shape, blurred, with the button that opens it on
// top. Something to unlock rather than an empty box.
function Locked({ lines, children }: { lines: number; children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="flex flex-col gap-2.5 blur-[3px] opacity-60 select-none" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="block h-3.5 rounded" style={{ width: `${92 - i * 14}%`, background: 'rgba(255,255,255,0.1)' }} />
        ))}
      </div>
      <div className="absolute inset-0 flex items-center">{children}</div>
    </div>
  );
}

function Working({ label, lines }: { label: string; lines: number }) {
  return (
    <div aria-live="polite">
      <p className="t-small text-working mb-3">{label}</p>
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className="h-3.5" style={{ width: `${92 - i * 14}%` }} />)}
      </div>
    </div>
  );
}
