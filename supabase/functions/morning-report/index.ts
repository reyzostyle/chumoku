import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// Morning report to Ivan's Telegram: signups and paying users against the
// "0 -> 10 paying" goal. Called by pg_cron once a day with x-cron-secret.
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET.
// Optional: GOAL_PAYING (default 10), GOAL_DEADLINE (YYYY-MM-DD).

const DAY = 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return new Response('Telegram is not configured', { status: 500 });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  try {
    const since = new Date(Date.now() - DAY).toISOString();
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();

    const [total, day, week, paying] = await Promise.all([
      supabase.from('user_tokens').select('user_id', { count: 'exact', head: true }),
      supabase.from('user_tokens').select('user_id', { count: 'exact', head: true }).gte('created_at', since),
      supabase.from('user_tokens').select('user_id', { count: 'exact', head: true }).gte('created_at', weekAgo),
      // Paying = a paid plan backed by a real Stripe or Apple subscription.
      // Plan rows set by hand (old test "agency" accounts) do not count.
      supabase
        .from('user_tokens')
        .select('plan')
        .neq('plan', 'free')
        .or('stripe_subscription_id.not.is.null,apple_original_transaction_id.not.is.null'),
    ]);
    for (const r of [total, day, week, paying]) if (r.error) throw r.error;

    const goal = Number(Deno.env.get('GOAL_PAYING') ?? 10);
    const payingCount = paying.data?.length ?? 0;
    const byPlan: Record<string, number> = {};
    for (const row of paying.data ?? []) byPlan[row.plan] = (byPlan[row.plan] ?? 0) + 1;
    const planText = Object.entries(byPlan).map(([p, n]) => `${p} ${n}`).join(', ');

    const lines = [
      '☀️ Chumoku, утро',
      '',
      `Платящие: ${payingCount}/${goal}${planText ? ` (${planText})` : ''}`,
      `Регистрации: +${day.count ?? 0} за сутки, +${week.count ?? 0} за неделю, всего ${total.count ?? 0}`,
    ];

    const deadline = Deno.env.get('GOAL_DEADLINE');
    if (deadline) {
      const left = Math.ceil((Date.parse(`${deadline}T23:59:59+01:00`) - Date.now()) / DAY);
      lines.push(left >= 0 ? `До дедлайна: ${left} дн.` : `Дедлайн прошёл ${-left} дн. назад`);
    }

    lines.push('', 'Сегодня: 20 сообщений креаторам.');

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);

    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[morning-report]', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
