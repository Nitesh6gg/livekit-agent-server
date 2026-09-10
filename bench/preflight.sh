#!/usr/bin/env bash
# Preflight checks for the Phase 1 capacity benchmark (docs/PRD.md §6).
#
# Run this on EACH host involved in a benchmark session (.19 and .20) immediately before
# starting a run. It auto-detects what role the current host plays (agent worker vs.
# LiveKit/SIP) and only runs the checks that apply.
#
# Every check here exists because it has already produced a false benchmark result on this
# infrastructure once:
#   - VMware Tools timesync fighting chrony corrupted .20's clock to 107,258 ppm and silently
#     dropped ~7% of agent audio frames - see memory/voice-agent-intermittent-network-fault.md.
#   - Sarvam has already returned WebSocket 403s under load; a vendor-side ceiling looks
#     identical to a capacity ceiling unless it's checked for separately.
#
# Exit code 0 = safe to proceed. Non-zero = fix the failures first.

set -uo pipefail

APP_NAME="${APP_NAME:-survey-agent}"
HEALTH_PORT="${HEALTH_PORT:-8081}"
MAX_PPM="${MAX_PPM:-100}"
SIP_CONTAINER="${SIP_CONTAINER:-livekit-sip-1}"
LIVEKIT_CONTAINER="${LIVEKIT_CONTAINER:-livekit-livekit-1}"

FAILS=0
WARNS=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }
warn() { echo "  WARN  $1"; WARNS=$((WARNS + 1)); }

echo "=== Preflight: $(hostname) - $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

# --- Clock health (every host) -----------------------------------------------------------
echo "--- Clock ---"
if command -v chronyc >/dev/null 2>&1; then
  TRACKING="$(chronyc tracking 2>&1)"
  PPM="$(echo "$TRACKING" | awk -F': ' '/^Frequency/ {print $2}' | awk '{print $1}')"
  if [ -z "${PPM:-}" ]; then
    fail "could not parse 'chronyc tracking' output - is chrony running?"
  else
    ABS_PPM="${PPM#-}"
    # integer compare via awk since PPM can be fractional
    if awk -v p="$ABS_PPM" -v m="$MAX_PPM" 'BEGIN { exit !(p > m) }'; then
      fail "chrony frequency is ${PPM} ppm, exceeds ${MAX_PPM} ppm - clock is not trustworthy (see the VMware timesync incident in project memory)"
    else
      pass "chrony frequency ${PPM} ppm (within ${MAX_PPM} ppm)"
    fi
  fi
else
  warn "chronyc not found - cannot verify clock health on this host"
fi

if command -v systemd-detect-virt >/dev/null 2>&1; then
  VIRT="$(systemd-detect-virt 2>/dev/null || true)"
  if [ "$VIRT" = "vmware" ] && command -v vmware-toolbox-cmd >/dev/null 2>&1; then
    TS_STATUS="$(vmware-toolbox-cmd timesync status 2>/dev/null || true)"
    if [ "$TS_STATUS" = "Disabled" ]; then
      pass "VMware Tools timesync: Disabled"
    else
      fail "VMware Tools timesync is '$TS_STATUS', must be 'Disabled' - it will fight chrony and corrupt the clock again"
    fi
  fi
fi
echo

# --- Agent worker checks (only if this looks like .19) -----------------------------------
if command -v pm2 >/dev/null 2>&1; then
  echo "--- Agent worker ($APP_NAME) ---"

  PM2_JSON="$(pm2 jlist 2>/dev/null || echo '[]')"
  # pm2 allows multiple process-table entries with the same name (e.g. a stale one left behind
  # by an earlier `pm2 start` that was never `pm2 delete`d, plus a fresh one started the normal
  # way). Picking the first match is wrong and has already produced a false FAIL here - prefer
  # whichever entry is actually online, and surface the duplication itself as something to clean
  # up rather than silently picking one.
  LOOKUP="$(node -e "
    const apps = JSON.parse(process.argv[1]).filter(a => a.name === process.argv[2]);
    const online = apps.find(a => a.pm2_env.status === 'online');
    const chosen = online || apps[0] || null;
    console.log(JSON.stringify({ count: apps.length, chosen }));
  " "$PM2_JSON" "$APP_NAME" 2>/dev/null || echo '{"count":0,"chosen":null}')"

  DUP_COUNT="$(node -e "console.log(JSON.parse(process.argv[1]).count)" "$LOOKUP" 2>/dev/null || echo 0)"
  APP_JSON="$(node -e "const c=JSON.parse(process.argv[1]).chosen; console.log(c?JSON.stringify(c):'')" "$LOOKUP" 2>/dev/null || true)"

  if [ "$DUP_COUNT" -gt 1 ]; then
    warn "$DUP_COUNT pm2 entries named '$APP_NAME' exist (ids visible via 'pm2 list') - using the online one for these checks, but the stale entries should be 'pm2 delete'd so this can't pick the wrong one silently."
  fi

  if [ -z "$APP_JSON" ]; then
    warn "no pm2 process named '$APP_NAME' found on this host - skipping agent checks"
  else
    STATUS="$(node -e "console.log(JSON.parse(process.argv[1]).pm2_env.status)" "$APP_JSON" 2>/dev/null || echo "unknown")"
    BENCH_ENV="$(node -e "console.log(JSON.parse(process.argv[1]).pm2_env.env.BENCHMARK_MODE || '')" "$APP_JSON" 2>/dev/null || echo "")"

    if [ "$STATUS" = "online" ]; then
      pass "pm2 process '$APP_NAME' is online"
    else
      fail "pm2 process '$APP_NAME' status is '$STATUS', expected 'online'"
    fi

    if [ "$BENCH_ENV" = "1" ]; then
      pass "BENCHMARK_MODE=1 is set in the pm2 process environment"
    else
      fail "BENCHMARK_MODE is not '1' in the pm2 process environment (got '${BENCH_ENV:-<unset>}') - this run would hit the production build: end-call tool active, misuse guardrail active, 15-min hard timer active. See bench/README.md for how to start a benchmark instance."
    fi
  fi

  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 3 "http://127.0.0.1:${HEALTH_PORT}/" >/dev/null 2>&1; then
      pass "health endpoint responding on :${HEALTH_PORT}"
    else
      fail "health endpoint on :${HEALTH_PORT} did not respond - worker may not be in production mode (health check only listens in production mode) or is not up"
    fi
  fi
  echo
fi

# --- LiveKit / SIP checks (only if this host actually runs these containers) -------------
# Gating on `command -v docker` alone isn't enough: a host can have the Docker client
# installed without running the SFU/SIP stack (e.g. .19, the agent worker). Only enter this
# section if at least one target container is found here at all - otherwise this genuinely
# isn't the SIP/SFU host and failing over containers it was never meant to run is wrong.
DOCKER_HOST_MATCH=0
if command -v docker >/dev/null 2>&1; then
  for c in "$SIP_CONTAINER" "$LIVEKIT_CONTAINER"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      DOCKER_HOST_MATCH=1
    fi
  done
fi

if [ "$DOCKER_HOST_MATCH" -eq 1 ]; then
  echo "--- LiveKit / SIP ---"

  for c in "$SIP_CONTAINER" "$LIVEKIT_CONTAINER"; do
    if ! docker inspect "$c" >/dev/null 2>&1; then
      fail "container '$c' not found on this host"
      continue
    fi
    STATE="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)"
    if [ "$STATE" = "running" ]; then
      pass "container '$c' is running"
    else
      fail "container '$c' state is '$STATE', expected 'running'"
    fi
  done

  # Soft check only: confirms lk is configured, does not fail the whole preflight if it isn't,
  # since credentials may be provided a different way for the actual benchmark run.
  if command -v lk >/dev/null 2>&1; then
    ROOM_COUNT="$(lk room list 2>/dev/null | grep -c 'SID:' || true)"
    if [ "${ROOM_COUNT:-0}" -gt 0 ]; then
      warn "$ROOM_COUNT room(s) currently active - if any are real calls, a benchmark run will compete with them for CPU on this host and skew both. Confirm before proceeding."
    else
      pass "no active rooms detected"
    fi
  else
    warn "lk CLI not found on PATH - cannot check for active rooms"
  fi
  echo
fi

# --- Summary -------------------------------------------------------------------------------
echo "=== Summary: $FAILS failure(s), $WARNS warning(s) ==="
if [ "$FAILS" -gt 0 ]; then
  echo "Do not start the benchmark. Fix the FAIL items above first."
  exit 1
fi
if [ "$WARNS" -gt 0 ]; then
  echo "No hard failures, but review the WARN items above before proceeding."
fi
exit 0
