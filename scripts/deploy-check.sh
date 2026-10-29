#!/usr/bin/env bash
# Deploy with the checks the security review asks for, in the right order:
#   0. the SEND_ALERTS secret is set (only a Worker that has it posts alerts),
#   1. pending D1 migrations first (the worker's SELECTs may need new columns),
#   2. build and deploy,
#   3. smoke checks on the live site (docs/security-review.md "Before deploying").
# usage: scripts/deploy-check.sh            (asks nothing; stops at the first failure)
set -euo pipefail
cd "$(dirname "$0")/.."
H=https://namada.trade

echo "== 0. alerts secret"
# Only a Worker whose SEND_ALERTS secret is yes posts alerts (worker/src/sources/discord.ts sendsAlerts), so a local
# run, even on a copy of the production database, posts none. Production must have it, or it would post none either;
# this is checked before anything remote changes. Names are listed, never values.
for i in 1 2 3 4 5; do out=$(npx wrangler secret list --format json 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json,re
t=sys.stdin.read(); m=re.search(r'^\[', t, re.M)
try: names={s['name'] for s in json.loads(t[m.start():])} if m else None
except Exception: names=None
if names is None: print('the secret list could not be read'); sys.exit(1)
print('SEND_ALERTS secret:', 'set' if 'SEND_ALERTS' in names else 'missing'); sys.exit(0 if 'SEND_ALERTS' in names else 1)" || { echo "FAIL SEND_ALERTS is not known to be set (npx wrangler secret put SEND_ALERTS, value yes): not deploying"; exit 1; }

echo "== 1. migrations"
for i in 1 2 3 4 5; do out=$(npx wrangler d1 migrations list namada-trade-db --remote 2>&1) && ! echo "$out" | grep -q 7403 && { echo "$out" | tail -4; break; }; echo "retrying (Cloudflare 7403)"; sleep 6; done
{ yes || true; } | npx wrangler d1 migrations apply namada-trade-db --remote
# 0008 (stored totals, wider indexes, the word table): its 8 triggers and 7 new objects must be there before the
# worker that reads them goes out (read-only check)
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger') triggers, (SELECT COUNT(*) FROM sqlite_master WHERE name IN ('holders_total','holders_stake','holders_tail','flows_hash','flows_hash_wrapper','flows_hash_inner','label_tokens')) objects" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0008 objects:', r)
sys.exit(0 if r['triggers'] >= 8 and r['objects'] == 7 else 1)" || { echo "FAIL migration 0008 is not in place: not deploying"; exit 1; }
# 0009 (the session rows' partial indexes): the Worker names them (auth.ts INDEXED BY), so they must be there first
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name IN ('kv_session_addr','kv_session_expiry','kv_session_legacy')" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0009 indexes:', n)
sys.exit(0 if n == 3 else 1)" || { echo "FAIL migration 0009 is not in place: not deploying"; exit 1; }
# 0010 (user tags' first-write time and their two partial indexes): the tag insert counts on them (db.ts userTag,
# INDEXED BY), so a tag cannot be saved until they are there
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM pragma_table_info('labels') WHERE name = 'created_at') col, (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('labels_user_author','labels_user_created')) n" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0010 column and indexes:', r)
sys.exit(0 if r['col'] == 1 and r['n'] == 2 else 1)" || { echo "FAIL migration 0010 is not in place: not deploying"; exit 1; }
# 0011 (the alert claims' time index): the cron's sweep names it (auth.ts INDEXED BY), so old claims are deleted
# only once it is there
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name = 'kv_alert_claim_time'" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0011 index:', n)
sys.exit(0 if n == 1 else 1)" || { echo "FAIL migration 0011 is not in place: not deploying"; exit 1; }
# 0012 (the settings rows with a Discord channel on): the channel cap's count and the dispatcher's read find those
# rows on it (settings.ts DELIVERABLE_ROWS); without it each save and each 15 s read goes through the whole user: range
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name = 'kv_user_deliverable'" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0012 index:', n)
sys.exit(0 if n == 1 else 1)" || { echo "FAIL migration 0012 is not in place: not deploying"; exit 1; }
# 0013 (the settings rows with Telegram on) and 0016 (the settings rows by Telegram chat): the Telegram dispatcher's read
# and the bot's /status, /stop and unlinks find those rows on them (settings.ts TELEGRAM_ROWS, rowsOfChat); without them
# each goes through the whole user: range
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name IN ('kv_user_telegram','kv_user_telegram_chat')" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0013 and 0016 indexes:', n)
sys.exit(0 if n == 2 else 1)" || { echo "FAIL migrations 0013 and 0016 are not in place: not deploying"; exit 1; }

# 0014 and 0015 (the depth tables and the two indexes of depth_changes): the depth minute writes depth_minute every tick
# and reads kv rows beside it; without the three tables and the indexes the minute's batch fails on every tick and its
# health row says so, and /api/depth/changes?pool= names the 0015 index (INDEXED BY) and would fail without it
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('depth_minute','depth_hourly','depth_changes')) tables, (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('depth_changes_ts','depth_changes_pool_ts')) n" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0014/0015 tables and indexes:', r)
sys.exit(0 if r['tables'] == 3 and r['n'] == 2 else 1)" || { echo "FAIL migration 0014 or 0015 is not in place: not deploying"; exit 1; }
# the depth archive bucket (wrangler.jsonc r2_buckets DEPTH_R2): wrangler refuses to upload a Worker bound to a bucket
# that does not exist, so the bucket is created once by hand before the first deploy of the binding (the code tolerates
# the binding missing; the deploy does not)
for i in 1 2 3 4 5; do out=$(npx wrangler r2 bucket list 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | grep -q 'namada-trade-depth' && echo "depth bucket: namada-trade-depth" || { echo "FAIL the depth archive bucket is missing: create it first (npx wrangler r2 bucket create namada-trade-depth), then deploy"; exit 1; }

echo "== 2. deploy"
npm run deploy 2>&1 | grep -E "Current Version ID|Deployed|rror"

echo "== 3. smoke"
fail=0
check() { local name=$1 want=$2 got=$3; if [ "$got" = "$want" ]; then echo "ok   $name ($got)"; else echo "FAIL $name: want $want got $got"; fail=1; fi; }
check "encoded path is a 404"        404 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/%6fverview")"
# a HEAD answer may state the GET's length (cached answers do); what matters is that no body bytes are sent
check "HEAD /api/overview sends no body" 0 "$(python3 -c "import http.client as h; c=h.HTTPSConnection('namada.trade'); c.request('HEAD','/api/overview'); print(len(c.getresponse().read()))")"
check "GET /api/overview has a body"   1 "$( [ "$(curl -s "$H/api/overview" | wc -c)" -gt 1000 ] && echo 1 || echo 0)"
check "100 KB body is refused (413)"   413 "$(head -c 102400 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- "$H/api/auth/nonce")"
check "plain GET /ws is 426"           426 "$(curl -s -o /dev/null -w '%{http_code}' "$H/ws")"
# the zone's http-to-https redirect (Cloudflare, before the Worker runs): plain http goes to https on the same host
check "plain http www is a 301 to https" "301 https://www.namada.trade/api/overview" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://www.namada.trade/api/overview")"
check "/api/auth/me is no-store"       1 "$(curl -s -D - -o /dev/null "$H/api/auth/me" | grep -ci 'cache-control: .*no-store' || true)"
check "home is 200"                    200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/")"
check "unknown page is 404"            404 "$(curl -s -o /dev/null -w '%{http_code}' "$H/no-such-page")"
check "CSP is enforced"                1 "$(curl -s -I "$H/" | grep -ci '^content-security-policy: default-src' || true)"
# a day the Trade page asks for (30 days back): another day is limited on a miss (worker/src/http.ts seriesFromDays)
day=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)).strftime('%Y-%m-%d'))")
check "series answers by day"          200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/series?key=price.usd&from=$day&step=1h")"
check "an encoded parameter name is a 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/alerts/rules?%62igSwap=1&bigSwap=2")"
check "a caller alert size is a 400"     400 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/alerts/recent?bigSwap=1")"
check "a count the app never sends is a 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/flows?count=x")"
check "an unknown series key is 404"   404 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/series?key=no.such.key")"
check "the tape answers"               200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/series/trades?limit=60")"
check "search answers in groups"       1 "$(curl -s "$H/api/search?q=anoma" | python3 -c "import sys,json; d=json.load(sys.stdin); print(1 if 'groups' in d and all('group' in r for r in d['results']) else 0)")"
check "rows-only moves take no count"  1 "$(curl -s "$H/api/flows?limit=10&count=none" | python3 -c "import sys,json; d=json.load(sys.stdin); print(1 if d['total'] is None and len(d['flows']) > 0 else 0)")"
check "holders page 2 answers"         200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/holders?chain=namada&by=total&page=2&limit=50")"
echo "== checks and health"
curl -s "$H/api/integrity" | python3 -c "
import sys,json; d=json.load(sys.stdin)
# each check that is not ok with its status: 'idle' (nothing to compare, e.g. no trade in the window) is not a failure,
# but a 'warn' or 'fail' is read before calling the deploy done
bad=[c['key'] + ' (' + c['status'] + ')' for c in d['checks'] if c['status']!='ok']
print('cross-checks:', sum(1 for c in d['checks'] if c['status']=='ok'), 'of', len(d['checks']), 'pass; not ok:', bad)
for c in d['checks']:
    if c['status'] not in ('ok', 'idle'): print('   CHECK', c['key'], c['status'], '-', json.dumps(c.get('detail'))[:200])
for s in d['sources']:
    if 'listing' in s['name'] or not s.get('ok', True): print('  ', s['name'], 'ok' if s.get('ok') else 'NOT OK', '-', (s.get('note') or '')[:140])
"
exit $fail
