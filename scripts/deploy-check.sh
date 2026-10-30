#!/usr/bin/env bash
# Deploy with the checks the security review asks for, in the right order:
#   guard. the working tree is clean and HEAD is the tip of the local branch integration (the public line once it is
#      pushed to GitHub main, which this script says but does not check), so what ships is a commit,
#   packages. npm ci only when node_modules is missing or does not match package-lock.json,
#   checks. the typecheck, the build, then the test suite against that build (some tests load web/dist), the tree
#      read again after the build and after the tests, which stop when either changed it,
#   0. the SEND_ALERTS secret is set (only a Worker that has it posts alerts),
#   rollback. the Worker version live now and a D1 Time Travel bookmark, read before anything remote changes, with
#      the commands that go back to each, in the order they must run,
#   1. pending D1 migrations first (the worker's SELECTs may need new columns),
#   2. deploy the build the tests ran against,
#   3. smoke checks on the live site (docs/security-review.md "Before deploying").
# usage: scripts/deploy-check.sh [--dry-run] [--skip-tests] [--off-tip]   (asks nothing; stops at the first failure)
#   --dry-run     (or DRY_RUN=1) runs the local checks that write nothing (the guard, the packages check, and the
#                 typecheck when node_modules is in place) and the remote reads (secret names, the migration list and
#                 the schema checks, the bucket, the live version, the bookmark), and prints every step that would
#                 write instead of running it: npm ci, the build, the tests, the migrations, the deploy and the smoke
#                 checks. A check that would stop a real run is said and the dry run goes on (with a migration
#                 pending, the schema check of the object it adds fails, as it applied nothing); it then ends with 1.
#   --skip-tests  leaves the test suite out (the typecheck and the build still run), for an emergency fix or rollback
#                 deploy only: it says so loudly.
#   --off-tip     deploys a dirty tree or a commit other than integration's tip, saying so loudly. Never for routine use.
set -euo pipefail
cd "$(dirname "$0")/.."
H=https://namada.trade

DRY=0; SKIP_TESTS=0; OFF_TIP=0
case "${DRY_RUN:-0}" in 0|'') ;; *) DRY=1 ;; esac
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --off-tip) OFF_TIP=1 ;;
    *) echo "unknown option $a (usage: scripts/deploy-check.sh [--dry-run] [--skip-tests] [--off-tip])"; exit 2 ;;
  esac
done
dry() { [ "$DRY" = 1 ]; }
# A step that writes: a dry run prints it instead
would() { echo "   dry run, not run: $*"; }
# A failed check: a real run stops; a dry run says so, goes on and ends with 1
stopped=0
stop() { echo "FAIL $*"; if dry; then echo "     (dry run: a real run stops here)"; stopped=$((stopped + 1)); else exit 1; fi; }
loud() {
  echo
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  for line in "$@"; do echo "!!! $line"; done
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo
}
dry && echo "DRY RUN: nothing is installed, built, migrated or deployed; remote calls are reads only"

echo "== guard: the tree and the commit"
# What ships is the commit at integration's tip with nothing beside it. A file left in the tree, tracked or not, could
# be built into the Worker without being in any commit. integration is the public line once it is pushed (it
# fast-forwards GitHub main); this checks the local branch only and fetches nothing, so whether the commit is on
# origin/main is said from the last fetch, not required. The refs are shared by every worktree of the repository, so
# a clean checkout of the tip (a worktree on a detached HEAD) passes as the main checkout on integration does.
head=$(git rev-parse HEAD)
tip=$(git rev-parse --verify --quiet refs/heads/integration || true)
dirty=$(git status --porcelain --untracked-files=normal)
why=()
if [ -n "$dirty" ]; then why+=("the working tree has $(echo "$dirty" | wc -l | tr -d ' ') changed or untracked path(s):"); while IFS= read -r l; do why+=("    $l"); done < <(echo "$dirty" | head -10); fi
if [ -z "$tip" ]; then why+=("there is no branch integration in this repository")
elif [ "$head" != "$tip" ]; then why+=("HEAD is ${head:0:9} ($(git log -1 --format=%cs "$head")), not the tip of integration, ${tip:0:9} ($(git log -1 --format=%cs "$tip"))"); fi
if [ ${#why[@]} -eq 0 ]; then echo "ok   clean tree at integration's tip ${head:0:9}"
elif [ "$OFF_TIP" = 1 ]; then loud "WARNING --off-tip: going on anyway, although" "${why[@]}" "The live Worker will not be a commit of the public line."
else for l in "${why[@]}"; do echo "FAIL $l"; done; echo "FAIL not deploying (commit the change to integration and deploy its tip; --off-tip overrides, loudly)"; exit 1; fi
if git merge-base --is-ancestor HEAD refs/remotes/origin/main 2>/dev/null; then echo "ok   ${head:0:9} is on origin/main as last fetched (the public repository)"
else echo "note ${head:0:9} is not on origin/main as last fetched: until integration is pushed there, the live Worker is a commit only this machine has"; fi
# The tree as the guard saw it, read again after the build and after the tests: the paths and their state, and the
# content of every change to a tracked file (on an --off-tip run the tree may already differ from the commit)
tree_state() { git status --porcelain --untracked-files=normal; git diff HEAD --binary | git hash-object --stdin; }
guard_state=$(tree_state)
# a step that changed the tree: what would ship is in no commit (a test that rewrites a tracked file each run, as the
# replay report's did, is fixed to write only when its content changes)
unchanged() {
  [ "$(tree_state)" = "$guard_state" ] && return 0
  echo "FAIL $1 changed the working tree, so what would ship is in no commit:"
  git status --porcelain --untracked-files=normal | head -10 | sed 's/^/FAIL     /'
  echo "FAIL not deploying (commit the change to integration and deploy its tip, or undo it)"; exit 1
}

echo "== packages"
# npm ci only when needed (it takes minutes): the installed tree is read from node_modules/.package-lock.json, which
# npm writes on every install, against package-lock.json. A package may be absent only when the lock marks it optional
# and bound to another platform (os, cpu or libc: esbuild's and workerd's builds for other machines); every other
# entry must be there with the lock's version and integrity, and nothing may be installed that the lock lacks. A
# change made inside node_modules by hand is not seen (npm's own check has the same limit).
lock_matches() {
  python3 -c "
import json,sys
try:
    lock=json.load(open('package-lock.json'))['packages']; got=json.load(open('node_modules/.package-lock.json'))['packages']
except Exception as e: print('   the installed tree could not be read:', e); sys.exit(1)
bad=[]
for k,v in lock.items():
    if not k: continue
    g=got.get(k)
    if g is None:
        if not ((v.get('optional') or v.get('devOptional')) and any(f in v for f in ('os','cpu','libc'))): bad.append(k + ' missing')
    elif g.get('version')!=v.get('version') or (v.get('integrity') and g.get('integrity') and g['integrity']!=v['integrity']): bad.append(k + ' ' + str(g.get('version')) + ' installed, the lock has ' + str(v.get('version')))
bad+=[k + ' installed, not in the lock' for k in got if k not in lock]
if bad: print('   node_modules does not match package-lock.json:', '; '.join(bad[:5]), '(and %d more)' % (len(bad)-5) if len(bad)>5 else ''); sys.exit(1)
print('ok   node_modules matches package-lock.json (%d packages)' % len(got))"
}
installed=1
if [ -L node_modules ]; then
  # a worktree's link to another checkout's packages: npm ci empties the folder it points at, which would break that
  # checkout, so it is never run through a link
  if lock_matches; then echo "     node_modules is a link to $(readlink node_modules); no npm ci"
  else installed=0; stop "node_modules is a link to another checkout and does not match the lock: deploy from a checkout with its own (npm ci there)"; fi
elif [ ! -d node_modules ]; then echo "   node_modules is missing"; if dry; then installed=0; would npm ci; else npm ci; fi
elif ! lock_matches; then if dry; then installed=0; would npm ci; else npm ci; fi
fi

echo "== checks: typecheck, build, tests"
# a dry run that installed nothing over a missing or stale tree has no typecheck to run either
if dry && [ "$installed" = 0 ]; then would npm run typecheck; else npm run typecheck; fi
if dry; then would npm run build; else npm run build; unchanged "the install, the typecheck or the build"; fi
# the suite has wall-clock tests (5 s timeouts, a 15 s alarm walk) that fail on a loaded machine with more workers
if [ "$SKIP_TESTS" = 1 ]; then loud "WARNING --skip-tests: the test suite was NOT run." "Only for an emergency fix or rollback deploy; run it on this commit as soon as the site is safe."
elif dry; then would npx vitest run --maxWorkers=4 --minWorkers=1
else npx vitest run --maxWorkers=4 --minWorkers=1; unchanged "the test suite"; fi

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

echo "== rollback: what is live now"
# Read before the migrations and the deploy change anything, so each is one command away from how it was. Only the
# version, its share and its time are printed (the answer also names who deployed it).
for i in 1 2 3 4 5; do out=$(npx wrangler deployments status --json 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
live=$(echo "$out" | python3 -c "
import sys,json,re
t=sys.stdin.read(); m=re.search(r'^\{', t, re.M)
try: d=json.loads(t[m.start():]) if m else None
except Exception: d=None
vs=[v for v in (d or {}).get('versions', []) if re.fullmatch(r'[0-9a-f-]{36}', str(v.get('version_id', '')))]
if not vs: sys.exit(1)
# a split deployment (two versions) goes back to the one with the larger share
vs.sort(key=lambda v: -float(v.get('percentage') or 0))
print('\t'.join([vs[0]['version_id'], ' + '.join('%s at %s%%' % (v['version_id'], v.get('percentage')) for v in vs), str(d.get('created_on') or '?')]))") || { echo "FAIL the live Worker version could not be read (npx wrangler deployments status): not deploying, as a rollback would have no version to go back to"; exit 1; }
IFS=$'\t' read -r live_id live_split live_at <<<"$live"
echo "live Worker version: $live_split, deployed $live_at"
for i in 1 2 3 4 5; do out=$(npx wrangler d1 time-travel info namada-trade-db --json 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
bookmark=$(echo "$out" | python3 -c "
import sys,json,re
t=sys.stdin.read(); m=re.search(r'^\{', t, re.M)
try: b=json.loads(t[m.start():]).get('bookmark') if m else None
except Exception: b=None
if not (isinstance(b, str) and re.fullmatch(r'[0-9a-f-]{8,}', b)): sys.exit(1)
print(b)") || { echo "FAIL the D1 Time Travel bookmark could not be read (npx wrangler d1 time-travel info namada-trade-db): not deploying"; exit 1; }
bookmark_s=$(date -u +%s)
bookmark_at=$(date -u -r "$bookmark_s" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$bookmark_s" +%Y-%m-%dT%H:%M:%SZ)
echo "D1 bookmark at $bookmark_at: $bookmark"
# The order matters. A Worker rollback brings back the secrets of the version it goes back to (wrangler 4.151's
# rollback lists the secrets changed since that version and asks, and goes on without asking where it cannot ask), so
# it comes before SEND_ALERTS is deleted. The cursor-driven alerts a restore replays are claimed and not posted while
# SEND_ALERTS is off (sources/discord.ts postAll), but the day's digest, the week's and the X recap are claimed per
# period and only by a Worker that sends (digest/deliver.ts prepareDigests, sources/x.ts postRecapOnX): one that went
# out after the bookmark is due again, unclaimed, until its period ends, so step 2 counts them, read-only.
rollback_words() {
  echo "   the Worker, first when it goes back too (it brings back that version's secrets, SEND_ALERTS among them;"
  echo "   wrangler lists the secrets changed since and asks):"
  echo "     npx wrangler rollback $live_id --message \"back from the deploy of ${head:0:9}\""
  echo "   the database, only when a migration or a write of this deploy must be undone (it overwrites every row"
  echo "   written since, and the restore prints a bookmark of its own that undoes it):"
  echo "     1. npx wrangler secret delete SEND_ALERTS   (restored claims and cursors would post old alerts again)"
  echo "     2. the day's and the week's digest and the X recap claimed today since the bookmark (a read):"
  echo "        npx wrangler d1 execute namada-trade-db --remote --command \"SELECT COUNT(*) n FROM kv WHERE key >= 'alert:' AND key < 'alert;' AND (key LIKE 'alert:digest:%' OR key LIKE 'alert:x:recap:%') AND updated_at >= MAX(${bookmark_s}000, CAST(strftime('%s', 'now', 'start of day') AS INTEGER) * 1000)\""
  echo "     3. npx wrangler d1 time-travel restore namada-trade-db --bookmark=$bookmark"
  echo "     4. put SEND_ALERTS back (npx wrangler secret put SEND_ALERTS, value yes) once the ticks have caught up, and"
  echo "        when step 2 counted more than 0, not before 00:00 UTC: until then those posts would go out a second time"
}
echo "to go back:"
rollback_words

echo "== 1. migrations"
for i in 1 2 3 4 5; do out=$(npx wrangler d1 migrations list namada-trade-db --remote 2>&1) && ! echo "$out" | grep -q 7403 && { echo "$out" | tail -4; break; }; echo "retrying (Cloudflare 7403)"; sleep 6; done
if dry; then would npx wrangler d1 migrations apply namada-trade-db --remote; else { yes || true; } | npx wrangler d1 migrations apply namada-trade-db --remote; fi
# 0008 (stored totals, wider indexes, the word table): its 8 triggers and 7 new objects must be there before the
# worker that reads them goes out (read-only check)
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger') triggers, (SELECT COUNT(*) FROM sqlite_master WHERE name IN ('holders_total','holders_stake','holders_tail','flows_hash','flows_hash_wrapper','flows_hash_inner','label_tokens')) objects" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0008 objects:', r)
sys.exit(0 if r['triggers'] >= 8 and r['objects'] == 7 else 1)" || stop "migration 0008 is not in place: not deploying"
# 0009 (the session rows' partial indexes): the Worker names them (auth.ts INDEXED BY), so they must be there first
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name IN ('kv_session_addr','kv_session_expiry','kv_session_legacy')" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0009 indexes:', n)
sys.exit(0 if n == 3 else 1)" || stop "migration 0009 is not in place: not deploying"
# 0010 (user tags' first-write time and their two partial indexes): the tag insert counts on them (db.ts userTag,
# INDEXED BY), so a tag cannot be saved until they are there
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM pragma_table_info('labels') WHERE name = 'created_at') col, (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('labels_user_author','labels_user_created')) n" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0010 column and indexes:', r)
sys.exit(0 if r['col'] == 1 and r['n'] == 2 else 1)" || stop "migration 0010 is not in place: not deploying"
# 0011 (the alert claims' time index): the cron's sweep names it (auth.ts INDEXED BY), so old claims are deleted
# only once it is there
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name = 'kv_alert_claim_time'" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0011 index:', n)
sys.exit(0 if n == 1 else 1)" || stop "migration 0011 is not in place: not deploying"
# 0012 (the settings rows with a Discord channel on): the channel cap's count and the dispatcher's read find those
# rows on it (settings.ts DELIVERABLE_ROWS); without it each save and each 15 s read goes through the whole user: range
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name = 'kv_user_deliverable'" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0012 index:', n)
sys.exit(0 if n == 1 else 1)" || stop "migration 0012 is not in place: not deploying"
# 0013 (the settings rows with Telegram on) and 0016 (the settings rows by Telegram chat): the Telegram dispatcher's read
# and the bot's /status, /stop and unlinks find those rows on them (settings.ts TELEGRAM_ROWS, rowsOfChat); without them
# each goes through the whole user: range
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name IN ('kv_user_telegram','kv_user_telegram_chat')" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; n=json.load(sys.stdin)[0]['results'][0]['n']; print('0013 and 0016 indexes:', n)
sys.exit(0 if n == 2 else 1)" || stop "migrations 0013 and 0016 are not in place: not deploying"

# 0014 and 0015 (the depth tables and the two indexes of depth_changes): the depth minute writes depth_minute every tick
# and reads kv rows beside it; without the three tables and the indexes the minute's batch fails on every tick and its
# health row says so, and /api/depth/changes?pool= names the 0015 index (INDEXED BY) and would fail without it
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('depth_minute','depth_hourly','depth_changes')) tables, (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('depth_changes_ts','depth_changes_pool_ts')) n" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0014/0015 tables and indexes:', r)
sys.exit(0 if r['tables'] == 3 and r['n'] == 2 else 1)" || stop "migration 0014 or 0015 is not in place: not deploying"
# 0017 (the moves list's stored counts, worker/src/flow-counts.ts): without the two tables the list counts the moves
# itself on every miss, as before; without the three triggers the stored counts would go wrong after an old move is
# written, so the Worker that reads them goes out only with all five in place
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('flow_counts','flow_count_mark')) tables, (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('flow_counts_bi','flow_counts_ad','flow_counts_au')) n" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0017 tables and triggers:', r)
sys.exit(0 if r['tables'] == 2 and r['n'] == 3 else 1)" || stop "migration 0017 is not in place: not deploying"
# 0018 (pool_legs, a NAM pool's legs in its other coins): the live hub writes them beside each Osmosis transaction's NAM
# rows, in a batch of its own that only logs a refusal, so without the table the NAM rows are still written and every
# pool leg is lost until it is there
for i in 1 2 3 4 5; do out=$(npx wrangler d1 execute namada-trade-db --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = 'pool_legs') tables, (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name = 'pool_legs_pool_ts') n" 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
echo "$out" | python3 -c "
import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print('0018 table and index:', r)
sys.exit(0 if r['tables'] == 1 and r['n'] == 1 else 1)" || stop "migration 0018 is not in place: not deploying"
# the depth archive bucket (wrangler.jsonc r2_buckets DEPTH_R2): wrangler refuses to upload a Worker bound to a bucket
# that does not exist, so the bucket is created once by hand before the first deploy of the binding (the code tolerates
# the binding missing; the deploy does not)
for i in 1 2 3 4 5; do out=$(npx wrangler r2 bucket list 2>&1) && ! echo "$out" | grep -q 7403 && break; echo "retrying (Cloudflare 7403)"; sleep 6; done
if echo "$out" | grep -q 'namada-trade-depth'; then echo "depth bucket: namada-trade-depth"; else stop "the depth archive bucket is missing: create it first (npx wrangler r2 bucket create namada-trade-depth), then deploy"; fi

echo "== 2. deploy"
# the build the tests ran against (package.json's deploy script would build again)
if dry; then
  would npx wrangler deploy
  echo "   dry run, not run: the smoke checks and the cross-checks, which read the site after a deploy"
  echo "== dry run done: the steps above marked 'not run' are what a real run would do next"
  if [ "$stopped" -gt 0 ]; then echo "== $stopped check(s) above would have stopped a real run"; exit 1; fi
  exit 0
fi
# wrangler's own failure line is "✘ [ERROR] …", so the error words are matched in any case; a failed deploy stops here
npx wrangler deploy 2>&1 | grep -iE "Current Version ID|Deployed|error"
echo "if this deploy must be undone (the Worker was $live_id before it):"
rollback_words

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
