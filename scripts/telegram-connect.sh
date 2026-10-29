#!/usr/bin/env bash
# Connect the Telegram bot to namada.trade (worker/src/telegram-bot.ts), or reconnect it after its token is replaced.
# Run on the owner's machine from this repository, after revoking the old token in @BotFather (/revoke) and getting
# a new one:
#   bash scripts/telegram-connect.sh
# It asks for the bot token at a hidden prompt, makes a new webhook secret, stores both as the Worker's secrets
# (wrangler secret put) and points the bot at the Worker (scripts/telegram-setup.mjs). Neither value is printed,
# written to a file or kept in the shell's history.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -s -p "New bot token from @BotFather (typing is hidden): " TOKEN; echo
if [[ ! "$TOKEN" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]]; then echo "That does not look like a bot token (digits, a colon, then letters)."; exit 1; fi
SECRET=$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n')
printf '%s' "$TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
TELEGRAM_BOT_TOKEN="$TOKEN" TELEGRAM_WEBHOOK_SECRET="$SECRET" node scripts/telegram-setup.mjs
unset TOKEN SECRET
echo "Done. Open https://namada.trade/settings, press Connect Telegram, then press Start in the bot."
