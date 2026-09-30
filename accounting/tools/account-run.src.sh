#!/bin/bash
# ACCOUNT LAYER sandbox (installed copy; source: /root/apex-faucet/tools/account-run.src.sh; install: tools/account-install.sh).
# v1 (2026-09-29 morning) was UNSAFE (Fable review 1): same uid as the bots, /proc/<pid>/root reached every key, unix sockets
# reached x1-rpc-bus (sendTransaction). v2 fixed that; Fable review 2 found the host's own IP, /dev/shm and root-run
# claudeuser files open. This v3:
#   - own uid apex-account; /proc shows no other process (ProtectProc=invisible, ProcSubset=pid)
#   - /root and /home EMPTY (ProtectHome=tmpfs) except the read-only allowlist beside this file; symlinked entries refused
#   - writable: data/protected/account and data/protected/policy only; /dev/shm hidden
#   - network (v4, review A1): its OWN empty network namespace (PrivateNetwork=yes) - no route to the internet, the host
#     or any local service. The only way out is the egress proxy's unix socket (apex-account-egress.service), bound into
#     an otherwise empty /run; lib/account/launch.js bridges fetch() to it. The proxy allows CONNECT :443 to the hosts in
#     egress-allow.txt only. All IP traffic is also denied by cgroup filter except the private namespace's own loopback.
#   - it reads no live database: only the column-limited extract rebuilt each cycle (account-extract.sh)
#   - no capabilities; node runs with --disallow-code-generation-from-strings, which stops eval and new Function only
#     (vm and WebAssembly still compile code: the sweep bans the vm module; review 3 L3)
#   - bounded: 1 GiB memory, no swap, 64 tasks, 2 CPUs, 600 s per step (review 3 M5, H2)
#   - this file, the allowlist and the sweep are root-owned in /usr/local/sbin/apex-account (root never runs a file the
#     bots' uid can edit)
# Usage: sudo /usr/local/sbin/apex-account/account-run.sh /usr/bin/node <script> [args]
set -euo pipefail
HERE=/usr/local/sbin/apex-account
ALLOW=$HERE/sandbox-allow.txt
DENY=$HERE/sandbox-paths.txt
ARGS=(--wait --pipe --collect --quiet
  -p User=apex-account -p Group=apex-account -p SupplementaryGroups=claudeuser
  -p ProtectProc=invisible -p ProcSubset=pid
  -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes -p PrivateDevices=yes -p InaccessiblePaths=/dev/shm
  -p NoNewPrivileges=yes -p CapabilityBoundingSet= -p AmbientCapabilities= -p RestrictSUIDSGID=yes
  -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes -p ProtectControlGroups=yes
  -p RestrictNamespaces=yes -p LockPersonality=yes -p ProtectClock=yes -p ProtectHostname=yes
  -p PrivateNetwork=yes -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"
  -p IPAddressDeny=any -p IPAddressAllow=localhost
  -p TemporaryFileSystem=/run -p BindReadOnlyPaths=/run/apex-account-egress
  -p Environment=NODE_USE_ENV_PROXY=1
  -p BindPaths=/root/apex-faucet/data/protected/account -p BindPaths=/root/apex-faucet/data/protected/policy
  -p WorkingDirectory=/root/apex-faucet/lib/account -p Nice=10
  -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=64 -p CPUQuota=200%
  -p Environment=HOME=/nonexistent)
# the host's own addresses: packets to them travel over lo and would reach nginx and every local service
# per-step time limit: 600 s (the cycle's hour holds five steps); a long manual test run may raise it, never past an hour
T=${APEX_ACCOUNT_TIMEOUT:-600}; [[ "$T" =~ ^[0-9]+$ ]] && [ "$T" -le 3600 ] || T=600
ARGS+=(-p "TimeoutStartSec=$T")
# steps of the cycle run under fixed names, so account-cycle-post.sh can stop one that outlives a killed cycle
if [[ "${APEX_ACCOUNT_STEP:-}" =~ ^[a-z]+$ ]]; then ARGS+=(--unit="apex-account-step-$APEX_ACCOUNT_STEP"); fi
refuse() { echo "account-run: REFUSED: $*" >&2; exit 1; }
[[ -S /run/apex-account-egress/proxy.sock ]] || refuse "egress proxy is not running (systemctl start apex-account-egress)"
shopt -s nullglob
while IFS= read -r p; do
  [[ -z "$p" || "$p" == \#* ]] && continue
  if [[ "$p" == *'*' ]]; then
    for f in $p; do [[ -L "$f" ]] && refuse "allowlisted file is a symlink: $f"; [[ -f "$f" ]] && ARGS+=(-p "BindReadOnlyPaths=$f"); done
  else
    if [[ -e "$p" ]]; then [[ -L "$p" || "$(readlink -e "$p")" != "$p" ]] && refuse "allowlisted path is or passes through a symlink: $p"; fi
    ARGS+=(-p "BindReadOnlyPaths=-$p")
  fi
done < "$ALLOW"
while IFS= read -r p; do [[ -z "$p" || "$p" == \#* ]] && continue; ARGS+=(-p "InaccessiblePaths=-$p"); done < "$DENY"
CMD=("$@")
# every node tool starts through the launcher (bridge to the egress socket), without eval / new Function
if [[ "${CMD[0]:-}" == */node ]]; then CMD=("${CMD[0]}" --disallow-code-generation-from-strings --disable-warning=UNDICI-EHPA /root/apex-faucet/lib/account/launch.js "${CMD[@]:1}"); fi
exec systemd-run "${ARGS[@]}" "${CMD[@]}"
