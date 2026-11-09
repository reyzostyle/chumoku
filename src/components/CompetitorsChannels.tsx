import { useState } from 'react';
import { AddOutlineIcon as Plus, RefreshOutlineIcon as Loader2, CloseCircleOutlineIcon as X, CheckCircleOutlineIcon as CheckCircle2 } from '@solar-icons/react';
import { MagnifierOutlineIcon as Search } from '@solar-icons/react';
import { ErrorNotice } from './ErrorNotice';
import { formatDate, type CompetitorChannel, type PoolVideo } from '../lib/competitors';

// Competitor channels: adding and removing. Lives in Settings
// (ChannelsSettings) since 2026-10-27. The "Adapt for my profile" box went
// with the move: it was never saved anywhere, and every idea is adapted.
interface Props {
  channels: CompetitorChannel[];
  pool: PoolVideo[];
  addingChannel: boolean;
  addError: string;
  removingId: string | null;
  syncingChannelId: string | null;
  onAutoFind: () => void;
  channelLimit: number;
  onAddChannel: (url: string) => void;
  onRemoveChannel: (channel: CompetitorChannel) => void;
}

export function CompetitorsChannels({
  channels, pool, onAutoFind, channelLimit, addingChannel, addError, removingId, syncingChannelId,
  onAddChannel, onRemoveChannel,
}: Props) {
  const [channelUrl, setChannelUrl] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelUrl.trim()) return;
    onAddChannel(channelUrl.trim());
    setChannelUrl('');
  };

  return (
    <div>
      {/* Add channel */}
      <div className="rounded-[var(--r-md)] p-4 sm:p-5 space-y-3" style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)' }}>
        {/* Auto-find sits above the URL field, because pasting five channel
            URLs is the wall this tab used to open with, and it is a worse
            first move than letting it look. Costs nothing and adds nothing on
            its own - it proposes, you pick. */}
        <button
          type="button"
          onClick={onAutoFind}
          disabled={channels.length >= channelLimit}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--r-sm)] text-left transition-colors disabled:opacity-40"
          style={{ background: 'var(--bg-app)', border: '1px dashed var(--line-strong)' }}
        >
          <Search className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text)' }} />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium" style={{ color: 'var(--text)' }}>Find competitors for me</span>
            <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {channels.length >= channelLimit ? 'All your slots are taken' : 'Reads your uploads and looks for who is winning on the same subject'}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-3">
          <span className="flex-1 h-px" style={{ background: 'var(--line)' }} />
          <span className="label-mono">or paste a url</span>
          <span className="flex-1 h-px" style={{ background: 'var(--line)' }} />
        </div>

        <form onSubmit={submit} className="flex gap-2">
          <input
            type="text"
            value={channelUrl}
            onChange={e => setChannelUrl(e.target.value)}
            placeholder="YouTube, TikTok or Instagram link"
            disabled={addingChannel || channels.length >= channelLimit}
            className="flex-1 px-3 py-2.5 rounded-[var(--r-sm)] text-sm focus:outline-none disabled:opacity-50"
            style={{ background: 'var(--bg-app)', border: '1px solid var(--line)', color: 'var(--text)' }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--line-strong)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--line)'; }}
          />
          <button
            type="submit"
            disabled={addingChannel || !channelUrl.trim() || channels.length >= channelLimit}
            className="btn-primary flex items-center gap-1.5 px-4 py-2.5 rounded-[var(--r-sm)] text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {addingChannel ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </button>
        </form>

        {addError && <ErrorNotice message={addError} />}

        {/* Always shown now — the desktop page header that used to carry this
            line is gone along with the standalone Channels tab. */}
        {channels.length < channelLimit && (
          <p className="text-[11px] text-[var(--text-faint)]">
            Up to {channelLimit} channels{channelLimit === 3 ? ' on the free plan, 5 on Plus' : ''} · a new one syncs right away
          </p>
        )}

        {channels.length > 0 && (
          <div className="space-y-2">
            {channels.map(channel => {
              // Counted off the pool, not off what you have read. This line
              // says what the channel has produced, which is a fact about the
              // channel; how much of it you have paid to break down is a fact
              // about you and belongs on the cards.
              const pooled = pool.filter(v => v.channel_id === channel.channel_id);
              const scored = pooled.filter(v => v.outlier_score != null);
              const avgScore = scored.length > 0
                ? (scored.reduce((sum, v) => sum + (v.outlier_score || 0), 0) / scored.length).toFixed(1)
                : null;
              const lastFound = pooled
                .map(v => v.published_at)
                .filter(Boolean)
                .sort()
                .pop();
              const isSyncing = syncingChannelId === channel.id;

              return (
                <div
                  key={channel.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                  style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)' }}
                >
                  {channel.channel_thumbnail ? (
                    <img src={channel.channel_thumbnail} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }} />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-[var(--text)] text-sm font-medium truncate">{channel.channel_name || channel.channel_id}</p>
                    <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
                      {pooled.length} outlier{pooled.length === 1 ? '' : 's'}
                      {avgScore && ` · avg ${avgScore}x`}
                      {lastFound && ` · last ${formatDate(lastFound)}`}
                    </p>
                  </div>
                  <span
                    className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full flex-shrink-0"
                    style={isSyncing
                      ? { background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }
                      : { background: 'rgba(var(--process-rgb),0.12)', color: 'var(--process)' }
                    }
                  >
                    {isSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                    {isSyncing ? 'Syncing...' : 'Tracked'}
                  </span>
                  <button
                    onClick={() => onRemoveChannel(channel)}
                    disabled={removingId === channel.id}
                    className="text-[var(--text-muted)] hover:text-[rgb(var(--danger-rgb))] transition-colors flex-shrink-0"
                  >
                    {removingId === channel.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
