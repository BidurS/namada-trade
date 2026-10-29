#!/usr/bin/env bash
# Connect namada.trade's automatic X posts (worker/src/sources/x.ts) to the owner's X account, or reconnect after the
# keys are regenerated. Run in the macOS Terminal app (a hidden prompt in the Claude app's Terminal panel may not take
# a paste) from this repository:
#   bash scripts/x-connect.sh
# It takes the four keys of the X app from the clipboard, one at a time (developer console → the app → OAuth 1.0 Keys:
# Consumer Key → Regenerate, then Access Token → Generate, in that order: a new consumer key ends older access
# tokens), so nothing is pasted into a hidden prompt; it trims stray spaces, shows only each key's last 4 characters,
# checks them against X (GET /2/users/me, a read, so nothing is posted), stores them as the Worker's secrets and
# clears the clipboard. Nothing is printed in full, written to a file or kept in the shell's history.
set -euo pipefail
cd "$(dirname "$0")/.."
PREV=""
ask() {
  local v
  # silent: anything pasted here by mistake is neither shown nor used (the key is read from the clipboard)
  read -r -s -p "Copy the $1 in the X console, then press Enter here (do not paste): " _ </dev/tty; echo >&2
  v=$(pbpaste | tr -d ' \t\r\n')
  if [[ -z "$v" ]]; then pbcopy </dev/null; echo "The clipboard is empty. Copy the $1 and run this again." >&2; exit 1; fi
  if [[ "$v" == "$PREV" ]]; then echo "That is the same as the last key: copy the $1 and run this again." >&2; exit 1; fi
  echo "  got the $1 ending …${v: -4} (${#v} characters)" >&2
  PREV="$v"
  printf '%s' "$v"
}
KEY=$(ask "Consumer Key"); PREV="$KEY"
KEY_SECRET=$(ask "Consumer Secret"); PREV="$KEY_SECRET"
TOKEN=$(ask "Access Token"); PREV="$TOKEN"
# The OAuth 1.0 access token starts with the account's number and a dash; the console's OAuth 2.0 access token (about
# 90 characters, no dash) is another kind and does not sign these posts.
if [[ ! "$TOKEN" =~ ^[0-9]+- ]]; then pbcopy </dev/null; echo "That is not the OAuth 1.0 Access Token: it should start with your account number and a dash (2115675561741951125-…). Use the Access Token under OAuth 1.0 Keys, and run this again." >&2; exit 1; fi
TOKEN_SECRET=$(ask "Access Token Secret")
pbcopy </dev/null
X_API_KEY="$KEY" X_API_SECRET="$KEY_SECRET" X_ACCESS_TOKEN="$TOKEN" X_ACCESS_SECRET="$TOKEN_SECRET" npx tsx scripts/x-check.ts
printf '%s' "$KEY" | npx wrangler secret put X_API_KEY
printf '%s' "$KEY_SECRET" | npx wrangler secret put X_API_SECRET
printf '%s' "$TOKEN" | npx wrangler secret put X_ACCESS_TOKEN
printf '%s' "$TOKEN_SECRET" | npx wrangler secret put X_ACCESS_SECRET
unset KEY KEY_SECRET TOKEN TOKEN_SECRET
echo "Done. Big moves, votes, forum news and the 13:00 UTC recap now post to X (at most 15 posts a day)."
