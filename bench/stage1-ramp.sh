#!/usr/bin/env bash
# Stage 1 capacity ramp (docs/PRD.md §6.3). Drives `lk perf agent-load-test` through
# increasing concurrency, dispatching real jobs to the running survey-agent worker with an
# echo track standing in for the caller. No SIP, no FreeSWITCH - this measures the agent
# pipeline itself (Sarvam STT/TTS + Gemini + local turn detection), which is the number
# Dograh's 5-6 calls/core figure needs to be compared against.
#
# Run this ON .20, so the generator's own CPU/network cost never lands on .19 (the host
# being measured). It wraps each step in a CPUQuota-limited systemd scope so the generator
# doesn't compete unboundedly with the SIP/SFU containers also running here.
#
# Before running:
#   1. bench/preflight.sh on BOTH .19 and .20 - must show 0 FAILs.
#   2. .19's survey-agent pm2 process must be running with BENCHMARK_MODE=1 (see bench/README.md).
#   3. Start bench/sample-host.sh on BOTH .19 and .20, pointed at the results dir this script
#      prints on startup.
#   4. LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be exported in this shell,
#      matching whatever credentials .19's benchmark instance is registered with.
#
# This script only executes steps and records their time windows (markers.csv). All
# judgment - pass/fail per step, latency percentiles, provider error counts - happens
# afterward in bench/parse-metrics.mjs, once .19's pm2 log has been copied alongside this
# run's results directory.

set -euo pipefail

: "${LIVEKIT_URL:?export LIVEKIT_URL first, matching the benchmark instance registration}"
: "${LIVEKIT_API_KEY:?export LIVEKIT_API_KEY first}"
: "${LIVEKIT_API_SECRET:?export LIVEKIT_API_SECRET first}"

LK="${LK:-lk}"
AGENT_NAME="${AGENT_NAME:-survey-agent}"
ECHO_DELAY="${ECHO_DELAY:-5s}"
STEP_DURATION="${STEP_DURATION:-5m}"
COOLDOWN_S="${COOLDOWN_S:-30}"
CPU_QUOTA="${CPU_QUOTA:-100%}"
SIP_CONTAINER="${SIP_CONTAINER:-livekit-sip-1}"
# Matches the step sequence in docs/PRD.md §6.3. Override with a shorter/longer list via
# ROOMS_STEPS="1 2 5" if you want a quick smoke run first.
read -ra ROOMS_STEPS <<<"${ROOMS_STEPS:-1 2 5 8 12 16 20}"

command -v "$LK" >/dev/null 2>&1 || { echo "lk not found on PATH (set LK=/path/to/lk)"; exit 1; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/results/$RUN_ID"
mkdir -p "$OUT_DIR"
MARKERS="$OUT_DIR/markers.csv"
echo "step,rooms,start_epoch,end_epoch,duration_s" > "$MARKERS"

echo "=== Stage 1 ramp - run $RUN_ID ==="
echo "Results dir: $OUT_DIR"
echo "Steps: ${ROOMS_STEPS[*]} room(s), ${STEP_DURATION} each, ${COOLDOWN_S}s cooldown between"
echo
echo "Now, in separate terminals:"
echo "  On .19: bash bench/sample-host.sh $OUT_DIR 2 agent-19"
echo "  On .20: bash bench/sample-host.sh $OUT_DIR 2 agent-20   (this host)"
echo
read -rp "Press Enter once both samplers are running... " _

USE_CPU_LIMIT=0
if command -v systemd-run >/dev/null 2>&1; then
  USE_CPU_LIMIT=1
else
  echo "WARNING: systemd-run not found - steps will run without a CPU cap on the generator."
fi

step_num=0
for rooms in "${ROOMS_STEPS[@]}"; do
  step_num=$((step_num + 1))
  echo
  echo "=== Step $step_num: $rooms room(s) for $STEP_DURATION ==="
  start_epoch="$(date +%s)"

  LOG_FILE="$OUT_DIR/step-${step_num}-rooms-${rooms}.log"
  if [ "$USE_CPU_LIMIT" -eq 1 ]; then
    systemd-run --scope --quiet -p CPUQuota="$CPU_QUOTA" \
      --unit="bench-lk-${RUN_ID}-${step_num}" \
      "$LK" perf agent-load-test \
        --rooms "$rooms" \
        --agent-name "$AGENT_NAME" \
        --echo-speech-delay "$ECHO_DELAY" \
        --duration "$STEP_DURATION" \
        --yes \
      2>&1 | tee "$LOG_FILE"
  else
    "$LK" perf agent-load-test \
      --rooms "$rooms" \
      --agent-name "$AGENT_NAME" \
      --echo-speech-delay "$ECHO_DELAY" \
      --duration "$STEP_DURATION" \
      --yes \
      2>&1 | tee "$LOG_FILE"
  fi

  end_epoch="$(date +%s)"
  echo "${step_num},${rooms},${start_epoch},${end_epoch},$((end_epoch - start_epoch))" >> "$MARKERS"

  # Quick local signal only (from .20's own SIP-service logs are irrelevant here since this
  # is WebRTC, not SIP - this just confirms the SIP/SFU containers stayed healthy while the
  # generator ran alongside them). Real pass/fail judgment happens in parse-metrics.mjs.
  if command -v docker >/dev/null 2>&1; then
    UP="$(docker inspect -f '{{.State.Status}}' "$SIP_CONTAINER" 2>/dev/null || echo missing)"
    echo "  ($SIP_CONTAINER status: $UP)"
  fi

  if [ "$step_num" -lt "${#ROOMS_STEPS[@]}" ]; then
    echo "  Cooling down ${COOLDOWN_S}s before next step..."
    sleep "$COOLDOWN_S"
  fi
done

echo
echo "=== Ramp complete ==="
echo "Markers: $MARKERS"
echo "Stop both sample-host.sh instances now (Ctrl+C in their terminals)."
echo
echo "Next:"
echo "  1. Copy .19's pm2 log for survey-agent into $OUT_DIR (e.g. scp it over)."
echo "  2. node bench/parse-metrics.mjs --markers $MARKERS --pm2-log <path-to-copied-log>"
