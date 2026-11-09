import { useCallback, useEffect, useState } from 'react';
import { supabase, getSessionToken, getUserId } from '../lib/supabase';
import { callFunction, type CompetitorChannel, type PoolVideo } from '../lib/competitors';
import { CompetitorsChannels } from './CompetitorsChannels';
import { FindCompetitorsModal } from './FindCompetitorsModal';
import { Skeleton } from './Page';

// Competitor channels, in Settings since 2026-10-27. They used to sit behind a
// "Channels" chip on Ideas, back when tracked channels were where ideas came
// from. Now the drop finds its own channels and researches ideas besides, so
// the ones you pick are one source of several: something you set once, not
// something on the screen you open every morning (Ivan: simplify Ideas).
export function ChannelsSettings() {
  const [channels, setChannels] = useState<CompetitorChannel[] | null>(null);
  const [pool, setPool] = useState<PoolVideo[]>([]);
  const [plan, setPlan] = useState('free');
  const [addingChannel, setAddingChannel] = useState(false);
  const [addError, setAddError] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [syncingChannelId, setSyncingChannelId] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const channelLimit = plan === 'free' ? 3 : plan === 'agency' ? 10 : 5;

  const load = useCallback(async () => {
    const userId = await getUserId();
    if (!userId) return;
    const [{ data: planData }, { data: channelData }] = await Promise.all([
      supabase.from('user_tokens').select('plan').eq('user_id', userId).maybeSingle(),
      supabase.from('competitor_channels').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
    ]);
    setPlan(planData?.plan || 'free');
    // The table has carried both spellings of these two columns since the
    // competitor tables were reshaped, so a row can arrive under either one.
    type RawChannel = Omit<CompetitorChannel, 'channel_name' | 'channel_thumbnail'> & {
      channel_name?: string | null; channel_title?: string | null;
      channel_thumbnail?: string | null; thumbnail_url?: string | null;
    };
    const mapped: CompetitorChannel[] = ((channelData || []) as RawChannel[]).map(c => ({
      ...c,
      channel_name: c.channel_name ?? c.channel_title ?? null,
      channel_thumbnail: c.channel_thumbnail ?? c.thumbnail_url ?? null,
    }));
    setChannels(mapped);
    if (mapped.length) {
      const { data: poolData } = await supabase
        .from('competitor_videos').select('*')
        .in('channel_id', mapped.map(c => c.channel_id))
        .order('outlier_score', { ascending: false, nullsFirst: false });
      setPool(poolData || []);
    } else {
      setPool([]);
    }
  }, []);

  useEffect(() => { load().catch(e => console.error('[ChannelsSettings] load error:', e)); }, [load]);

  const addChannel = async (channelUrl: string) => {
    setAddingChannel(true);
    setAddError('');
    try {
      const token = await getSessionToken();
      if (!token) throw new Error('Not authenticated');
      const res = await callFunction('add-competitor-channel', token, { channelUrl });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add channel');
      await load();

      // The new channel gets its own pool built immediately: three YouTube
      // reads, so there is no reason to wait for the next drop.
      const newChannelId = data.channel?.channel_id;
      if (newChannelId) {
        setSyncingChannelId(data.channel.id);
        try {
          const syncRes = await callFunction('fetch-competitor-ideas', token, { channelId: newChannelId });
          const syncData = await syncRes.json();
          if (syncRes.ok && syncData.videos) setPool(syncData.videos);
        } catch (e) {
          console.error('[ChannelsSettings] first sync error:', e);
        } finally {
          setSyncingChannelId(null);
        }
      }
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setAddingChannel(false);
    }
  };

  // Sequential on purpose: the cap is checked server-side per call, and
  // firing five at once would race past it.
  const addFound = async (channelIds: string[]) => {
    for (const id of channelIds) await addChannel(`https://www.youtube.com/channel/${id}`);
  };

  const removeChannel = async (channel: CompetitorChannel) => {
    setRemovingId(channel.id);
    try {
      const userId = await getUserId();
      if (!userId) throw new Error('Not authenticated');
      await supabase.from('competitor_channels').delete().eq('id', channel.id).eq('user_id', userId);
      setChannels(prev => (prev ?? []).filter(c => c.id !== channel.id));
      // The pooled videos stay in the table - another user may track the same
      // channel - they just stop being visible here.
      setPool(prev => prev.filter(v => v.channel_id !== channel.channel_id));
    } catch (e) {
      console.error('[ChannelsSettings] remove error:', e);
    } finally {
      setRemovingId(null);
    }
  };

  if (channels === null) return <Skeleton className="h-40 w-full" style={{ borderRadius: 'var(--r-md)' }} />;

  return (
    <>
      <CompetitorsChannels
        channels={channels}
        pool={pool}
        addingChannel={addingChannel}
        addError={addError}
        removingId={removingId}
        syncingChannelId={syncingChannelId}
        onAddChannel={addChannel}
        onRemoveChannel={removeChannel}
        onAutoFind={() => setFindOpen(true)}
        channelLimit={channelLimit}
      />
      {findOpen && (
        <FindCompetitorsModal
          slotsLeft={Math.max(0, channelLimit - channels.length)}
          onAdd={addFound}
          onClose={() => setFindOpen(false)}
        />
      )}
    </>
  );
}
