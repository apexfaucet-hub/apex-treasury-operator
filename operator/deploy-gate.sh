#!/usr/bin/env bash
# DEPLOY GATE (2026-09-29, CLAUDE.md §20). Gemini's review of CLAUDE.md found nothing checked a change before a live
# restart and nothing wrote down how to undo it. Three verbs:
#   tools/deploy-gate.sh save <file...>              copy each file to data/backups/<stamp>/ BEFORE editing; prints the undo line
#   tools/deploy-gate.sh check <file...>             syntax: node --check for .js, JSON.parse for .json; exit 1 on any failure
#   tools/deploy-gate.sh restart <unit> [--dry] <file...>
#                                                    check, then refuse if the accounting cycle runs now or starts within
#                                                    10 minutes (it fetches our site), then restart and wait until healthy
# Exit 0 = passed, 1 = a check failed (nothing restarted), 2 = refused on timing (nothing restarted), 3 = restarted but unhealthy.
set -u
APP=/root/apex-faucet
cmd=${1:-}; shift || true

save() {
  local stamp; stamp=$(date -u +%Y%m%d-%H%M%S)
  for f in "$@"; do
    local abs; abs=$(readlink -f "$f")
    [ -f "$abs" ] || { echo "SAVE FAILED: $f is not a file"; return 1; }
    local dst="$APP/data/backups/$stamp$abs"
    mkdir -p "$(dirname "$dst")" && cp -p "$abs" "$dst" || { echo "SAVE FAILED: $abs"; return 1; }
    echo "saved $abs"
    echo "  undo: cp -p '$dst' '$abs'"
  done
}

check() {
  local bad=0
  for f in "$@"; do
    case "$f" in
      *.js)   if node --check "$f" 2>/tmp/deploy-gate.$$; then echo "ok   syntax  $f"; else echo "FAIL syntax  $f"; sed -n 1,6p /tmp/deploy-gate.$$; bad=1; fi ;;
      *.json) if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null; then echo "ok   json    $f"; else echo "FAIL json    $f"; bad=1; fi ;;
      *)      echo "skip (no check for this type) $f" ;;
    esac
  done
  rm -f /tmp/deploy-gate.$$
  return $bad
}

cycle_guard() {
  # The accounting cycle (apex-account-cycle.timer) fetches documents from our site; a restart under it makes that run fail.
  if systemctl is-active --quiet apex-account-cycle.service; then echo "REFUSED: the accounting cycle is running right now"; return 1; fi
  local next; next=${GATE_TEST_NEXT:-$(systemctl show apex-account-cycle.timer -p NextElapseUSecRealtime --value 2>/dev/null)}   # GATE_TEST_NEXT: test the refusal
  [ -n "$next" ] || { echo "note: no accounting timer found, timing not checked"; return 0; }
  local t; t=$(date -d "$next" +%s 2>/dev/null) || { echo "REFUSED: could not read the accounting timer ($next)"; return 1; }
  local left=$(( t - $(date +%s) ))
  if [ "$left" -ge 0 ] && [ "$left" -lt 600 ]; then
    echo "REFUSED: the accounting cycle starts in $((left / 60)) min $((left % 60)) s ($(TZ=Atlantic/Canary date -d "@$t" +%H:%M) Canary); restart after it finishes (~7 min)"
    return 1
  fi
  echo "ok   timing  next accounting cycle in $((left / 60)) min"
}

restart() {
  local unit=$1; shift
  local dry=0; if [ "${1:-}" = "--dry" ]; then dry=1; shift; fi
  check "$@" || { echo "GATE: checks failed, $unit NOT restarted"; exit 1; }
  cycle_guard || exit 2
  if [ $dry = 1 ]; then echo "DRY: would restart $unit now"; exit 0; fi
  sudo systemctl restart "$unit" || { echo "GATE: systemctl restart $unit failed"; exit 3; }
  local url=""; [ "$unit" = "apex-faucet" ] && url="http://127.0.0.1:3000/api/xnt-price"
  for i in $(seq 1 30); do
    sleep 2
    if [ -n "$url" ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url")
      if [ "$code" = "200" ]; then echo "healthy: $unit answered 200 after $((i * 2)) s"; exit 0; fi
    elif systemctl is-active --quiet "$unit"; then echo "healthy: $unit active after $((i * 2)) s"; exit 0; fi
  done
  echo "UNHEALTHY: $unit did not come up in 60 s. Use the undo lines printed by 'save', then restart again."; exit 3
}

case "$cmd" in
  save)    save "$@" ;;
  check)   check "$@" ;;
  restart) [ $# -ge 1 ] || { echo "usage: deploy-gate.sh restart <unit> [--dry] <file...>"; exit 1; }; restart "$@" ;;
  *) sed -n 2,11p "$0"; exit 1 ;;
esac
