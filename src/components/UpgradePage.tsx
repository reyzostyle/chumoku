import { useState } from 'react';
import { FUNCTIONS_URL, getSessionToken, fetchWithRetry } from '../lib/supabase';
import { BoltOutlineIcon as Zap, RefreshOutlineIcon as Loader2 } from '@solar-icons/react';
import { Check } from './BrandIcons';
import { ErrorNotice } from './ErrorNotice';
import { useUsage } from '../lib/useUsage';
import { Page, PageHead, Button } from './Page';
import { startTopup, CREDIT_PACK } from './CreditsPanel';
import { BillingSeg } from './BillingSeg';

type Interval = 'month' | 'year';

interface Plan {
  id: string;
  name: string;
  monthlyPrice: number | null;       // billed monthly
  yearlyTotal: number | null;        // total charged once/year (not a monthly rate)
  yearlyMonthlyPrice: number | null; // the "$X/month" figure to show when yearly is selected — an
                                      // authored number, not yearlyTotal/12 (which rounds to $5.00
                                      // and reads as inconsistent next to Plus's $4.99 monthly price)
  quotas: string[];
  features: string[];
  cta: string;
}

// Actual Stripe prices (2026-08-17 repricing). Plus's yearly total ($119.99)
// is exactly 12x its monthly rate rounded up 11c to end in .99 — no yearly
// discount, since Plus is already the cheap option. Pro's yearly total
// ($155.99) gets the SAME +11c rounding move applied to its $12.99/mo
// effective rate, which is a real ~35% discount off Pro's $19.99 monthly —
// pushes commitment toward the higher tier, which is where it matters most.
// Free isn't shown here on purpose — it's a real plan (new signups start on
// it), but listing it as a third card made this a long scroll on mobile
// before reaching an actual paid option. New users land on Free without
// needing to pick it off a pricing grid.
const plans: Plan[] = [
  {
    id: 'pro',
    name: 'Plus',
    monthlyPrice: 9.99,
    yearlyTotal: 119.99,
    yearlyMonthlyPrice: 9.99,
    // Rewritten 2026-09-30 with the product: no scores and no Analytics any
    // more, so nothing here promises either.
    quotas: ['About 30 scripts / month', '100 credits: 3 a script, 1 a message', 'Ideas pitched for your channel'],
    features: [
      'Your version of every idea',
      'A script from any idea in one press',
      'A chat that knows your channel',
      'Retention read on your own videos',
      'Track up to 5 channels',
    ],
    cta: 'Upgrade to Plus',
  },
  {
    id: 'agency',
    name: 'Pro',
    monthlyPrice: 19.99,
    yearlyTotal: 155.99,
    yearlyMonthlyPrice: 12.99,
    quotas: ['About 100 scripts / month', '300 credits', 'For posting every day'],
    features: [
      'Everything in Plus',
      'Highest monthly limits',
    ],
    cta: 'Upgrade to Pro',
  },
];

export function UpgradePage() {
  const { usage } = useUsage();
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [topupBusy, setTopupBusy] = useState(false);
  const [error, setError] = useState('');
  const [interval, setBillingInterval] = useState<Interval>('year');

  const handleUpgrade = async (planId: string) => {
    setCheckingOut(planId);
    setError('');
    try {
      const token = await getSessionToken();
      if (!token) { setError('Not authenticated'); setCheckingOut(null); return; }
      const res = await fetchWithRetry(
        `${FUNCTIONS_URL}/create-checkout-session`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ plan: planId, interval }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create checkout session');
      if (data.url) window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      setCheckingOut(null);
    }
  };

  const currentPlan = usage?.plan || 'free';
  const proPlan = plans.find(p => p.id === 'agency')!;
  const proYearlySavings = proPlan.monthlyPrice != null && proPlan.yearlyTotal != null
    ? Math.round((proPlan.monthlyPrice * 12 - proPlan.yearlyTotal) * 100) / 100
    : 0;
  // Computed, not hardcoded — this drifted silently out of sync with the
  // actual discount once during the 2026-08-17 repricing (stayed "50% off"
  // after the real number had moved to ~35%).
  const proYearlyPercentOff = proPlan.monthlyPrice != null && proPlan.monthlyPrice > 0
    ? Math.round((proYearlySavings / (proPlan.monthlyPrice * 12)) * 100)
    : 0;

  return (
    <Page className="animate-tab-in">
        {/* The billing toggle lives in the header's action slot rather than in a
            centred block of its own. That block plus its margins pushed the
            plans 306px down the page, so on a laptop the cards ran past the
            fold and you had to scroll to see the price you came for. The slot
            already exists for exactly this and costs no vertical space. Shown
            on every width now, like every other tab's header. */}
        <PageHead
          title="Plans"
          action={<BillingSeg interval={interval} onChange={setBillingInterval} percentOff={proYearlyPercentOff} />}
        />
      <div>
        {error && <ErrorNotice message={error} className="mb-6" />}

        {/* Plans grid */}
        {/* Full width, so the cards start where the heading above them starts.
            They were capped at 672 inside an 896 container, which left the
            plans floating in the middle of a page whose text began further
            left - the single most visible spacing fault in the app. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {plans.map(plan => {
            const isCurrent = currentPlan === plan.id;
            const isHigher = (
              (plan.id === 'pro' && currentPlan === 'free') ||
              (plan.id === 'agency' && (currentPlan === 'free' || currentPlan === 'pro'))
            );
            const isPopular = plan.id === 'agency';

            return (
              <div
                key={plan.id}
                className={`relative flex flex-col p-5 rounded-xl motion-card ${((isPopular && isHigher) || isCurrent) ? 'glass-panel-accent' : 'glass-panel'}`}
                style={{ animationDelay: `${plans.indexOf(plan) * 80}ms` }}
              >
                {isPopular && !isCurrent && isHigher && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-3 py-1 bg-[var(--accent)] text-[var(--on-accent)] text-xs font-semibold rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}

                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className={`w-4 h-4 ${isPopular ? 'text-[var(--accent)]' : 'text-[var(--accent)]/70'}`} />
                    <span className="text-white font-semibold">{plan.name}</span>
                  </div>
                  {(() => {
                    const isYearly = interval === 'year';
                    const displayPrice = (isYearly ? plan.yearlyMonthlyPrice : plan.monthlyPrice) ?? null;
                    const billedYearly = isYearly && plan.yearlyTotal != null
                      ? `$${plan.yearlyTotal.toFixed(2)} billed yearly`
                      : null;
                    // Only show a struck-through "was" price when yearly billing
                    // actually undercuts the monthly rate (Plus doesn't).
                    const showWasPrice = isYearly && plan.monthlyPrice != null && displayPrice != null && plan.monthlyPrice > displayPrice;
                    return (
                      <>
                        <div className="flex items-baseline gap-1.5 select-none">
                          {showWasPrice && (
                            <span className="text-lg text-gray-600 line-through">${plan.monthlyPrice!.toFixed(2)}</span>
                          )}
                          <span className="text-3xl font-bold text-white">{displayPrice != null ? `$${displayPrice.toFixed(2)}` : '—'}</span>
                          <span className="text-sm text-gray-500">/month</span>
                        </div>
                        <p className="text-xs text-gray-600 mt-0.5">
                          {billedYearly ?? 'billed monthly'}
                        </p>
                        {/* What yearly is worth, on the card it is worth it on.
                            Plus's yearly is twelve months at the monthly rate,
                            so it gets nothing to show. */}
                        {plan.id === 'agency' && proYearlySavings > 0 && (
                          <p className="mt-2 inline-flex items-center px-2 py-0.5 rounded-full text-[12px] font-medium tabular-nums transition-opacity duration-200"
                             style={{ background: 'rgba(245,196,81,0.12)', color: 'var(--upgrade)', opacity: isYearly ? 1 : 0.55 }}>
                            {isYearly ? `You save $${proYearlySavings.toFixed(2)} a year` : `Save $${proYearlySavings.toFixed(2)} with yearly`}
                          </p>
                        )}
                      </>
                    );
                  })()}
                  {/* Monthly quotas — the numbers people actually compare */}
                  <div className="mt-2.5 space-y-1.5">
                    {plan.quotas.map(q => (
                      <p key={q} className="flex items-center gap-2 text-[13px] font-semibold text-white">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} />
                        {q}
                      </p>
                    ))}
                  </div>
                </div>

                <ul className="flex-1 space-y-2 mb-5">
                  {plan.features.map(feature => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-gray-400">
                      <Check className="w-4 h-4 text-[var(--accent)] flex-shrink-0 mt-0.5" />
                      {feature}
                    </li>
                  ))}
                </ul>

                {/* The three button levels, not hand-rolled rectangles. Plus's
                    button was `bg-[var(--accent)]/60`: Tailwind cannot put an
                    opacity on a CSS variable, so it rendered as black text on
                    the dark card - an upgrade button you could barely see. */}
                {isCurrent ? (
                  <Button variant="ghost" disabled className="w-full !opacity-60">Current plan</Button>
                ) : isHigher ? (
                  <Button
                    variant={isPopular ? 'primary' : 'secondary'}
                    onClick={() => handleUpgrade(plan.id)}
                    disabled={checkingOut === plan.id}
                    className="w-full"
                  >
                    {checkingOut === plan.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {checkingOut === plan.id ? 'Redirecting' : plan.cta}
                  </Button>
                ) : (
                  <Button variant="ghost" disabled className="w-full">Included in your plan</Button>
                )}
              </div>
            );
          })}
        </div>

        {/* Extra credits, on the page people reach from "Change plan". A
            one-time pack on top of a plan, for subscribers: at the same price
            per credit, selling it on free would undercut Plus. */}
        <div className="row-group mt-4 flex flex-wrap items-center justify-between gap-4" style={{ padding: 20, opacity: currentPlan === 'free' ? 0.55 : 1 }}>
          <div className="min-w-0">
            <p className="text-[15px] font-medium" style={{ color: 'var(--text)' }}>{CREDIT_PACK.credits} extra credits</p>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {currentPlan === 'free' ? 'Comes with Plus or Pro. On top of the plan, they never expire.' : 'On top of your plan. They never expire.'}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={currentPlan === 'free' || topupBusy}
            onClick={async () => {
              setTopupBusy(true); setError('');
              try { await startTopup(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed to start checkout'); setTopupBusy(false); }
            }}
          >
            {topupBusy && <Loader2 className="w-4 h-4 animate-spin" />}
            Buy for {CREDIT_PACK.price}
          </Button>
        </div>

        <p className="mt-6 text-xs text-gray-600 text-center">
          Payments are processed securely by Stripe. Cancel anytime in Settings.
        </p>
      </div>
    </Page>
  );
}

