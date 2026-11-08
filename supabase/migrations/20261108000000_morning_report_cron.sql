-- Morning Telegram report to Ivan: 06:00 UTC = 07:00 Vienna in winter (08:00 in summer).
-- Reuses the sync-retention call (URL + x-cron-secret) with the function name swapped.
SELECT cron.schedule('morning-report', '0 6 * * *',
  (SELECT replace(command, 'sync-retention', 'morning-report') FROM cron.job WHERE command LIKE '%sync-retention%' LIMIT 1))
WHERE EXISTS (SELECT 1 FROM cron.job WHERE command LIKE '%sync-retention%');
