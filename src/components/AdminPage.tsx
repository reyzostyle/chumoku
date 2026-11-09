import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { FUNCTIONS_URL, getSessionToken, fetchWithRetry } from '../lib/supabase';
import { Page, PageHead, BackLink, Tile, Loading, Panel } from './Page';

const ADMIN_EMAIL = 'reyzostyle@gmail.com';

interface Stats {
  total_users: number;
  new_users_today: number;
  new_users_28d: number;
  active_users_28d: number;
  active_users_today: number;
  active_users_7d: number;
  daily_active: number[];
  daily_signups: number[];
  plan_free: number;
  plan_plus: number;
  plan_pro: number;
  new_subs_today: number;
  new_subs_28d: number;
  cancels_28d: number;
  revenue_28d_cents: number;
  daily_subs: number[];
}

// 28 days as bars, oldest on the left, today on the right. Bars rather than a
// line: a day with nobody on it should look like nothing, not like a dip.
function Bars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-[3px] h-24 mt-4">
      {values.map((v, i) => (
        <div
          key={i}
          title={`${v}`}
          className="flex-1 rounded-[2px]"
          style={{
            height: `${Math.max(2, (v / max) * 100)}%`,
            background: i === values.length - 1 ? 'var(--text)' : 'rgba(255,255,255,0.22)',
          }}
        />
      ))}
    </div>
  );
}

function Chart({ label, total, sub, values }: { label: string; total: string; sub: string; values: number[] }) {
  return (
    <Panel className="min-w-0">
      <p className="label-mono mb-2">{label}</p>
      <p className="text-[26px] leading-none font-semibold tracking-tight tabular-nums" style={{ color: 'var(--text)' }}>{total}</p>
      <p className="text-[12px] mt-1.5" style={{ color: 'var(--text-faint)' }}>{sub}</p>
      <Bars values={values} />
      <div className="flex justify-between mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        <span>28 days ago</span><span>Today</span>
      </div>
    </Panel>
  );
}

// The owner's overview of the product: money first, then people, then the
// plan mix. Same numbers as the iOS app's Admin screen (AdminView.swift),
// from admin-stats, which refuses anyone but the owner.
export function AdminPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  const isAdmin = user?.email === ADMIN_EMAIL;

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const token = await getSessionToken();
        const res = await fetchWithRetry(`${FUNCTIONS_URL}/admin-stats`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load');
        setStats(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load stats');
      }
    })();
  }, [isAdmin]);

  // Not the admin: render nothing identifying, just a quiet dead end.
  if (!isAdmin) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-gray-600">Nothing here.</p>
      </div>
    );
  }

  const back = <BackLink label="Settings" onClick={() => window.dispatchEvent(new CustomEvent('chumoku:navigate', { detail: 'settings' }))} />;

  if (error || !stats) {
    return (
      <Page className="animate-tab-in">
        {back}
        <PageHead title="Admin" />
        {error
          ? <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">{error}</p>
          : <Loading rows={6} />}
      </Page>
    );
  }

  const paying = stats.plan_plus + stats.plan_pro;
  // Approximation: assumes every subscriber is on monthly billing. Yearly
  // subscribers pay $149 on Plus and $299 on Pro, which works out to
  // $10.00 and $13.00 a month, so a yearly Pro is counted here as $7 a month
  // more than it brings in. plan_events doesn't record the billing interval,
  // so this cannot be split without storing it first.
  const mrr = stats.plan_plus * 29 + stats.plan_pro * 49;
  const revenue28d = stats.revenue_28d_cents / 100;
  const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const share = (n: number) => `${Math.round((n / Math.max(1, stats.total_users)) * 100)}%`;

  return (
    <Page className="animate-tab-in">
      {back}
      <PageHead title="Admin" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Tile label="MRR" value={money(mrr)} sub={`${paying} paying`} />
        <Tile label="Revenue 28d" value={money(revenue28d)} sub={`${stats.new_subs_28d} new · ${stats.cancels_28d} cancelled`} />
        <Tile label="Active today" value={String(stats.active_users_today)} sub={`${stats.active_users_7d} this week`} />
        <Tile label="Users" value={stats.total_users.toLocaleString()} sub={`+${stats.new_users_today} today`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 mt-2.5">
        <Chart label="Signups" total={String(sum(stats.daily_signups))} sub="last 28 days" values={stats.daily_signups} />
        <Chart label="Active users" total={String(stats.active_users_28d)} sub="opened it in the last 28 days" values={stats.daily_active} />
        <Chart label="New subscriptions" total={String(sum(stats.daily_subs))} sub={`${stats.new_subs_today} today`} values={stats.daily_subs} />
      </div>

      <Panel className="mt-2.5">
        <p className="label-mono mb-4">Plans</p>
        <div className="flex h-2 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
          <div style={{ width: share(stats.plan_pro), background: 'var(--text)' }} />
          <div style={{ width: share(stats.plan_plus), background: 'rgba(255,255,255,0.45)' }} />
        </div>
        <div className="grid grid-cols-3 gap-4 mt-4">
          {[
            ['Pro', stats.plan_pro, '$49'],
            ['Plus', stats.plan_plus, '$29'],
            ['Trial', stats.plan_free, 'free'],
          ].map(([name, n, price]) => (
            <div key={name as string}>
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{name}</p>
              <p className="text-[20px] font-semibold tabular-nums mt-0.5" style={{ color: 'var(--text)' }}>{(n as number).toLocaleString()}</p>
              <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>{share(n as number)} · {price}</p>
            </div>
          ))}
        </div>
      </Panel>
    </Page>
  );
}
