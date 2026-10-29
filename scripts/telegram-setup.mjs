// Points the Telegram bot at the Worker and sets its commands and descriptions (worker/src/telegram-bot.ts).
// Run once after the Worker with the Telegram routes is deployed, and again after the token is replaced:
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/telegram-setup.mjs
// The two values are the Worker's secrets of the same names (wrangler.jsonc); neither is printed or written anywhere.
// Pending updates are dropped: a Start pressed before the webhook existed carried a code that has expired anyway.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL ?? 'https://namada.trade/api/telegram/webhook';
if (!token || !secret) { console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set'); process.exit(1); }
if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) { console.error('TELEGRAM_WEBHOOK_SECRET: 32 to 256 of A-Z a-z 0-9 _ - (Telegram\'s rule)'); process.exit(1); }

const call = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  console.log(`${method}: ${j.ok ? 'ok' : `failed (${r.status} ${j.description ?? ''})`}`);
  if (!j.ok) process.exitCode = 1;
  return j.result;
};

await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'my_chat_member'], drop_pending_updates: true, max_connections: 10 });
await call('setMyCommands', { commands: [
  { command: 'status', description: 'Which wallets\' alerts arrive here' },
  { command: 'stop', description: 'Stop all alerts here' },
  { command: 'help', description: 'What this bot does' },
] });
await call('setMyShortDescription', { short_description: 'NAM alerts from namada.trade: big moves, bridging, unstaking, the shielded pool and governance, by your own rules.' });
await call('setMyDescription', { description: 'NamadaTrade sends alerts on NAM, the coin of the Namada network: big moves, bridging to Osmosis, unstaking, the shielded pool, governance and the addresses you watch, by the rules you choose at namada.trade/settings. Every figure has its source. Independent of the Namada team. Not investment advice.' });
const info = await call('getWebhookInfo', {});
if (info) console.log(`webhook: ${info.url} · pending ${info.pending_update_count}${info.last_error_message ? ` · last error: ${info.last_error_message}` : ''}`);
