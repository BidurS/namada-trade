#!/usr/bin/env bash
# Deploy with the checks the security review asks for, in the right order:
#   1. pending D1 migrations first (the worker's SELECTs may need new columns),
#   2. build and deploy,
#   3. smoke checks on the live site (docs/security-review.md "Before deploying").
# usage: scripts/deploy-check.sh            (asks nothing; stops at the first failure)
set -euo pipefail
cd "$(dirname "$0")/.."
H=https://namada.trade

echo "== 1. migrations"
for i in 1 2 3 4 5; do out=$(npx wrangler d1 migrations list namada-trade-db --remote 2>&1) && ! echo "$out" | grep -q 7403 && { echo "$out" | tail -4; break; }; echo "retrying (Cloudflare 7403)"; sleep 6; done
{ yes || true; } | npx wrangler d1 migrations apply namada-trade-db --remote

echo "== 2. deploy"
npm run deploy 2>&1 | grep -E "Current Version ID|Deployed|rror"

echo "== 3. smoke"
fail=0
check() { local name=$1 want=$2 got=$3; if [ "$got" = "$want" ]; then echo "ok   $name ($got)"; else echo "FAIL $name: want $want got $got"; fail=1; fi; }
check "encoded path is a 404"        404 "$(curl -s -o /dev/null -w '%{http_code}' "$H/api/%6fverview")"
check "HEAD /api/overview has no body" 0 "$(curl -s -I "$H/api/overview" | grep -ci '^content-length: [1-9]' || true)"
check "100 KB body is refused (413)"   413 "$(head -c 102400 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- "$H/api/auth/nonce")"
check "plain GET /ws is 426"           426 "$(curl -s -o /dev/null -w '%{http_code}' "$H/ws")"
check "/api/auth/me is no-store"       1 "$(curl -s -D - -o /dev/null "$H/api/auth/me" | grep -ci 'cache-control: .*no-store' || true)"
check "home is 200"                    200 "$(curl -s -o /dev/null -w '%{http_code}' "$H/")"
check "unknown page is 404"            404 "$(curl -s -o /dev/null -w '%{http_code}' "$H/no-such-page")"
check "CSP is enforced"                1 "$(curl -s -I "$H/" | grep -ci '^content-security-policy: default-src' || true)"
echo "== checks and health"
curl -s "$H/api/integrity" | python3 -c "
import sys,json; d=json.load(sys.stdin)
bad=[c['key'] for c in d['checks'] if c['status']!='ok']
print('cross-checks:', sum(1 for c in d['checks'] if c['status']=='ok'), 'of', len(d['checks']), 'pass; not ok:', bad)
for s in d['sources']:
    if 'listing' in s['name'] or not s.get('ok', True): print('  ', s['name'], 'ok' if s.get('ok') else 'NOT OK', '-', (s.get('note') or '')[:140])
"
exit $fail
