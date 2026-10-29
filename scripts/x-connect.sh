#!/usr/bin/env bash
# Connect namada.trade's automatic X posts (worker/src/sources/x.ts) to the owner's X account, or reconnect after the
# keys are regenerated. Run in the macOS Terminal app (a hidden prompt in the Claude app's Terminal panel may not take
# a paste) from this repository:
#   bash scripts/x-connect.sh
# It asks for the four keys of the X app (developer.x.com → your app → Keys and tokens; the app's permissions must be
# Read and Write, and the access token made after that) at hidden prompts, checks them against X (GET /2/users/me, a
# read, so nothing is posted), and stores them as the Worker's secrets. Nothing is printed, written to a file or kept
# in the shell's history.
set -euo pipefail
cd "$(dirname "$0")/.."
ask() { local v; read -r -s -p "$1 (typing is hidden): " v; echo >&2; [[ -n "$v" ]] || { echo "Nothing was entered." >&2; exit 1; }; printf '%s' "$v"; }
KEY=$(ask "API Key (consumer key)")
KEY_SECRET=$(ask "API Key Secret")
TOKEN=$(ask "Access Token")
TOKEN_SECRET=$(ask "Access Token Secret")
X_API_KEY="$KEY" X_API_SECRET="$KEY_SECRET" X_ACCESS_TOKEN="$TOKEN" X_ACCESS_SECRET="$TOKEN_SECRET" npx tsx scripts/x-check.ts
printf '%s' "$KEY" | npx wrangler secret put X_API_KEY
printf '%s' "$KEY_SECRET" | npx wrangler secret put X_API_SECRET
printf '%s' "$TOKEN" | npx wrangler secret put X_ACCESS_TOKEN
printf '%s' "$TOKEN_SECRET" | npx wrangler secret put X_ACCESS_SECRET
unset KEY KEY_SECRET TOKEN TOKEN_SECRET
echo "Done. Big moves, votes, forum news and the 13:00 UTC recap now post to X (at most 15 posts a day)."
