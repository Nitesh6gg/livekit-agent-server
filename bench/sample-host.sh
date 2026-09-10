#!/usr/bin/env bash
# Samples CPU, memory, and load on this host for the duration of a benchmark run, plus
# per-container CPU/mem when Docker is present (.20). Run this in its own terminal on EACH
# host (.19 and .20) before starting bench/stage1-ramp.sh, pointed at the same results
# directory the ramp script prints - bench/parse-metrics.mjs correlates all of it by
# timestamp afterward.
#
# Usage:
#   bench/sample-host.sh <output-dir> [interval-seconds] [host-tag]
#
# Example:
#   bench/sample-host.sh results/20260910T090000Z 2 agent-19
#
# Uses `vmstat <interval> 2`, which blocks for <interval> seconds and reports the delta over
# that window - the same command and reading (us/sy/id/wa/st columns) used to diagnose CPU
# steal on this infrastructure earlier. No extra tools required beyond what's already on
# both boxes.

set -uo pipefail

OUT_DIR="${1:?usage: sample-host.sh <output-dir> [interval-seconds] [host-tag]}"
INTERVAL="${2:-2}"
HOST_TAG="${3:-$(hostname)}"

mkdir -p "$OUT_DIR"
HOST_CSV="$OUT_DIR/host-${HOST_TAG}.csv"
DOCKER_CSV="$OUT_DIR/docker-${HOST_TAG}.csv"

echo "epoch,host,us,sy,id,wa,st,mem_used_mb,mem_total_mb,load1" > "$HOST_CSV"
if command -v docker >/dev/null 2>&1; then
  echo "epoch,container,cpu_pct,mem_used_mb" > "$DOCKER_CSV"
fi

echo "Sampling '$HOST_TAG' every ${INTERVAL}s -> $HOST_CSV"
echo "Ctrl+C to stop."

MEM_TOTAL_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))

trap 'echo; echo "Stopped. Wrote $HOST_CSV"; exit 0' INT TERM

while true; do
  EPOCH="$(date +%s)"

  # `vmstat N 2` blocks for N seconds and emits two rows: the since-boot average, then the
  # N-second delta. We want the delta, hence `tail -1`. This doubles as our sleep.
  LINE="$(vmstat "$INTERVAL" 2 | tail -1)"
  read -r _r _b _swpd _free _buff _cache _si _so _bi _bo _in _cs us sy id wa st <<<"$LINE"

  MEM_AVAIL_KB="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  MEM_USED_MB=$(( (MEM_TOTAL_KB - MEM_AVAIL_KB) / 1024 ))
  LOAD1="$(awk '{print $1}' /proc/loadavg)"

  echo "${EPOCH},${HOST_TAG},${us},${sy},${id},${wa},${st},${MEM_USED_MB},${MEM_TOTAL_MB},${LOAD1}" >> "$HOST_CSV"

  if command -v docker >/dev/null 2>&1; then
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null | while IFS=',' read -r name cpu mem; do
      cpu_num="${cpu%\%}"
      mem_used="$(echo "$mem" | awk -F'/' '{print $1}' | tr -d ' ')"
      echo "${EPOCH},${name},${cpu_num},${mem_used}" >> "$DOCKER_CSV"
    done
  fi
done
