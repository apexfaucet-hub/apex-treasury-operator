#!/bin/bash
# ACCOUNT LAYER cycle (installed copy; source tools/account-cycle.src.sh), every 2 h (apex-account-cycle.timer):
#   sweep -> site fetch -> extract -> snapshot -> (price fetch) verify -> ingest -> reconcile -> export -> publish
# REPORT-ONLY: nothing here sends a message, moves money or reads a key. Every node step runs inside the sandbox as a
# named unit (apex-account-step-<name>) so account-cycle-post.sh can stop a leftover. Root runs only root-owned files.
# Root's own history (data/protected/account-cycles-root.ndjson, outside every sandbox mount) decides readiness: the cycle
# records 'started' first, and validate-summary.js records 'finished' (or 'failed') - a killed cycle stays 'started' =
# unclean (Fable review 3 H2, M1). Consumers read ONLY data/account-summary.json, written by validate-summary.js.
set -u
HERE=/usr/local/sbin/apex-account
RUN=$HERE/account-run.sh
V="/usr/bin/node $HERE/validate-summary.js"
APP=/root/apex-faucet
ACC=$APP/data/protected/account
LOG=$ACC/cycle.log
PUB=$APP/data/account-summary.json
RH=$APP/data/protected/account-cycles-root.ndjson
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# scheduled = systemd says the timer started this run (review 3 L4: no timing heuristic)
trig=manual; [ "${TRIGGER_UNIT:-}" = apex-account-cycle.timer ] && trig=timer
printf '%s\n%s\n' "$START" "$trig" > /run/apex-account-cycle.state
$V record --history "$RH" --cycle-start "$START" --trigger "$trig" --stage started
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | runuser -u apex-account -- tee -a "$LOG" >/dev/null; echo "$*"; }
fail_cycle() { $V record --history "$RH" --cycle-start "$START" --trigger "$trig" --stage failed --reason "$1"; $V failed "$PUB" --history "$RH" --reason "$1"; }
step() { local name=$1; shift; APEX_ACCOUNT_STEP=$name $RUN /usr/bin/node "$@" >/dev/null 2>&1; }
out=$(/usr/bin/node "$HERE/sweep-account-safety.js" 2>&1); rc=$?
if [ $rc -ne 0 ]; then say "SAFETY SWEEP FAILED - cycle not run: $(printf '%s\n' "$out" | grep -m3 FAIL | cut -c1-200 | tr '\n' ' ')"; fail_cycle "safety sweep failed"; exit 1; fi
"$HERE/account-site-fetch.sh" discovery >/dev/null 2>&1; f=$?
"$HERE/account-extract.sh" >/dev/null 2>&1; e=$?
step snapshot $APP/tools/account-snapshot.js; s=$?
v=99
if [ $s -eq 0 ]; then
  "$HERE/account-site-fetch.sh" xnt-price >/dev/null 2>&1 || f=$?
  r=$(runuser -u apex-account -- sqlite3 -readonly $ACC/account.db "SELECT MAX(run_id) FROM runs WHERE kind='snapshot' AND complete=1")
  step verify $APP/tools/account-verify.js "$r"; v=$?
fi
step ingest $APP/tools/account-ingest.js; i=$?
step reconcile $APP/tools/account-reconcile.js; c=$?
steps="{\"site\":$f,\"extract\":$e,\"snapshot\":$s,\"verify\":$v,\"ingest\":$i,\"reconcile\":$c}"
step export $APP/tools/account-export.js --steps "$steps" --trigger "$trig" --cycle-start "$START"; x=$?
if [ $x -eq 0 ] && pub=$($V publish "$ACC/summary.json" "$PUB" --history "$RH" --cycle-start "$START" --trigger "$trig" --steps "$steps"); then :
else fail_cycle "export exit $x or summary rejected: ${pub:-}"; pub="NOT published (export $x): ${pub:-}"; fi
say "cycle trigger=$trig steps=$steps export=$x $pub"
exit 0
