import { corsHeaders } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import Stripe from 'npm:stripe@14.21.0';
import { subscribed } from '../_shared/emails.ts';
import { sendEmail } from '../_shared/send-email.ts';

const CORS = corsHeaders({ methods: 'GET, POST, PUT, DELETE, OPTIONS' });

const PRICE_TO_PLAN: Record<string, string> = {
  [Deno.env.get('STRIPE_PRO_PRICE_ID') || '']: 'pro',
  [Deno.env.get('STRIPE_AGENCY_PRICE_ID') || '']: 'agency',
};

// By product, because checkout charges each product's default price: a new
// price or the yearly one is not in PRICE_TO_PLAN, and used to fall through to
// Plus even for someone who bought Pro.
// deno-lint-ignore no-explicit-any
function planOf(price: any): string {
  const product = typeof price?.product === 'string' ? price.product : price?.product?.id;
  const pro = ['STRIPE_AGENCY_MONTHLY_PRODUCT_ID', 'STRIPE_AGENCY_YEARLY_PRODUCT_ID', 'STRIPE_AGENCY_PRODUCT_ID'].map(k => Deno.env.get(k));
  if (product && pro.includes(product)) return 'agency';
  return PRICE_TO_PLAN[price?.id ?? ''] || 'pro';
}

// How long an affiliate keeps earning from one subscriber, and how long an
// earning sits before it can be paid out (a refund or chargeback lands first).
const COMMISSION_MONTHS = 12;
const HOLD_DAYS = 30;

// Records one affiliate earning for a paid invoice, if the payer signed up
// through someone's link and is still inside the 12-month window.
async function recordReferralConversion(
  supabase: any,
  userId: string,
  amountCents: number,
  plan: string,
  subscriptionId: string | null,
  kind: 'initial' | 'renewal',
) {
  if (amountCents <= 0) return;

  const { data: refSignup } = await supabase
    .from('referral_signups')
    .select('referral_code')
    .eq('user_id', userId)
    .maybeSingle();
  if (!refSignup?.referral_code) return;

  const { data: refCode } = await supabase
    .from('referral_codes')
    .select('commission_percent, active')
    .eq('code', refSignup.referral_code)
    .maybeSingle();
  if (!refCode || refCode.active === false) return;

  // The window opens at the subscriber's first paid conversion, so a renewal
  // 13 months later earns nothing even though the link is still attributed.
  if (kind === 'renewal') {
    const { data: first } = await supabase
      .from('referral_conversions')
      .select('created_at')
      .eq('referred_user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!first) return; // no initial payment on record, nothing to extend
    const windowEnds = new Date(first.created_at);
    windowEnds.setMonth(windowEnds.getMonth() + COMMISSION_MONTHS);
    if (new Date() > windowEnds) {
      console.log(`[stripe-webhook] Referral window closed for user ${userId}`);
      return;
    }
  }

  const holdUntil = new Date();
  holdUntil.setDate(holdUntil.getDate() + HOLD_DAYS);

  const commissionCents = Math.round(amountCents * refCode.commission_percent / 100);
  await supabase.from('referral_conversions').insert({
    referral_code: refSignup.referral_code,
    referred_user_id: userId,
    plan,
    amount_cents: amountCents,
    commission_cents: commissionCents,
    stripe_subscription_id: subscriptionId,
    kind,
    hold_until: holdUntil.toISOString(),
  });
  console.log(`[stripe-webhook] Referral ${kind}: code=${refSignup.referral_code} commission=$${commissionCents / 100}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS });
  }

  try {
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    if (!stripeSecretKey) throw new Error('Stripe secret key not configured');
    // Always require a webhook secret. Without it we'd be trusting an unsigned
    // body, letting anyone POST a fake "checkout.session.completed" to upgrade
    // their plan for free. Refuse rather than parse blindly.
    if (!webhookSecret) throw new Error('Stripe webhook secret not configured');

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-06-20' });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const body = await req.text();
    let event: Stripe.Event;

    const signature = req.headers.get('stripe-signature');
    if (!signature) throw new Error('Missing stripe-signature header');
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);

    console.log(`[stripe-webhook] event=${event.type}`);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      if (!userId) {
        console.error('[stripe-webhook] No userId in session metadata');
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      // One-time credit top-up (create-credit-topup-session) — a separate
      // purchase from the subscription flow below, credited on top of
      // whatever the plan already grants, never expires on its own.
      if (session.metadata?.type === 'credit_topup') {
        const credits = parseInt(session.metadata?.credits || '0', 10);
        if (credits > 0) {
          const { data: existing } = await supabase.from('user_tokens').select('bonus_credits').eq('user_id', userId).maybeSingle();
          await supabase.from('user_tokens').update({ bonus_credits: (existing?.bonus_credits || 0) + credits }).eq('user_id', userId);
          console.log(`[stripe-webhook] Credited ${credits} top-up credits to user ${userId}`);
        }
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      const subscriptionId = session.subscription as string;
      const customerId = session.customer as string;
      let plan = 'pro';

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        plan = planOf(subscription.items.data[0]?.price);
      }

      const resetAt = new Date();
      resetAt.setDate(resetAt.getDate() + 30);

      const { error: upsertError } = await supabase
        .from('user_tokens')
        .upsert({
          user_id: userId,
          access_token: '',
          token_expiry: resetAt.toISOString(),
          plan,
          credits_used: 0,
          credits_reset_at: resetAt.toISOString(),
          stripe_subscription_id: subscriptionId || null,
          stripe_customer_id: customerId || null,
        }, { onConflict: 'user_id' });

      if (upsertError) {
        console.error('[stripe-webhook] Upsert error:', JSON.stringify(upsertError));
      }

      console.log(`[stripe-webhook] Updated user ${userId} to plan=${plan}, customer=${customerId}`);

      const amountCents = session.amount_total ?? 0;
      await supabase.from('plan_events').insert({
        user_id: userId,
        plan,
        event_type: 'subscribed',
        amount_cents: amountCents,
      });

      // Record the affiliate earning if this user came via someone's link
      await recordReferralConversion(supabase, userId, amountCents, plan, subscriptionId || null, 'initial');

      await sendEmail(supabase, userId, subscribed({ appUrl: 'https://chumoku.co', plan: plan === 'agency' ? 'agency' : 'pro', store: 'stripe' }));
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      const { data: tokenRow } = await supabase
        .from('user_tokens')
        .select('user_id, plan')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();

      if (tokenRow) {
        await supabase
          .from('user_tokens')
          .update({
            plan: 'free',
            stripe_subscription_id: null,
          })
          .eq('user_id', tokenRow.user_id);

        await supabase.from('plan_events').insert({
          user_id: tokenRow.user_id,
          plan: tokenRow.plan,
          event_type: 'cancelled',
        });

        console.log(`[stripe-webhook] Downgraded user ${tokenRow.user_id} to free`);
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = invoice.subscription as string;
      if (!subscriptionId) return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const plan = planOf(subscription.items.data[0]?.price);
      const customerId = subscription.customer as string;

      const { data: tokenRow } = await supabase
        .from('user_tokens')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();

      if (tokenRow) {
        const resetAt = new Date();
        resetAt.setDate(resetAt.getDate() + 30);

        await supabase
          .from('user_tokens')
          .update({
            plan,
            credits_used: 0,
            credits_reset_at: resetAt.toISOString(),
          })
          .eq('user_id', tokenRow.user_id);

        console.log(`[stripe-webhook] Reset usage for user ${tokenRow.user_id}, plan=${plan}`);

        // Every renewal earns too, for 12 months. Stripe also fires this event
        // for the invoice that creates a subscription, which the checkout
        // handler has already recorded - billing_reason separates the two.
        if (invoice.billing_reason === 'subscription_cycle') {
          await recordReferralConversion(
            supabase, tokenRow.user_id, invoice.amount_paid ?? 0, plan, subscriptionId, 'renewal',
          );
        }
      }
    }

    return new Response(
      JSON.stringify({ received: true }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[stripe-webhook] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
