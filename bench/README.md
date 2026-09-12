# Phase 1 capacity benchmark

Answers the question docs/PRD.md §6 exists to ask: how many concurrent calls does one CPU
core carry on `survey-agent`, at acceptable audio quality, compared to Dograh's 5-6/core?

Two stages. Run Stage 1 first - it's the number the whole project's go/no-go decision
depends on, and it tells you what concurrency to actually validate in Stage 2.

- **Stage 1** - WebRTC only, via `lk perf agent-load-test`. No SIP, no FreeSWITCH. Measures
  the agent pipeline itself (Sarvam STT/TTS + Gemini + local turn detection).
- **Stage 2** - real SIP calls through a test trunk on `.20`, validating `input_frames_dropped`
  and jitter-buffer behavior at whatever concurrency Stage 1 found. Not built yet - build it
  once Stage 1 has a number to validate.

## Before any run

**1. Rotate off dev credentials if you haven't (PRD blocker item 01).** These scripts read
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from the environment - whatever you
export is what gets used.

**2. Ask Sarvam and Google what your concurrency limits actually are.** Sarvam has already
returned WebSocket `403`s under load in this project. If your account is capped at, say, 10
concurrent streams, every step above 10 will fail for a reason that has nothing to do with
LiveKit or your CPU - and it will look exactly like a capacity ceiling in the results table
unless you already know to expect it. `parse-metrics.mjs` classifies `sarvam-limit` and
`gemini-timeout` errors separately from everything else for this reason, but knowing the real
limit in advance is what lets you read the table correctly instead of guessing.

**3. Start a benchmark instance of `survey-agent` on `.19`.**

The production process must **not** be used for this - it has the end-call tool, the
misuse-hangup guardrail, and a 15-minute hard timer active, and an echo track will trip the
misuse guardrail (repeating the agent's own question back to it looks exactly like the
"repeatedly goes off-topic" pattern that guardrail watches for). `src/agent.ts` and
`src/main.ts` strip all three when `BENCHMARK_MODE=1` is set - see the `BENCHMARK_MODE`
constant exported from `src/agent.ts` for exactly what changes.

This means stopping the production process for the duration of the run. Adjust to match
however `survey-agent` is actually started under pm2 today (there's no committed ecosystem
file yet - PRD item 06):

```bash
pm2 stop survey-agent
BENCHMARK_MODE=1 pm2 start src/main.ts --name survey-agent --interpreter node -- start
```

When the run is done, reverse it:

```bash
pm2 stop survey-agent
pm2 delete survey-agent
pm2 start src/main.ts --name survey-agent --interpreter node -- start
```

## Stage 1: WebRTC ramp

**1. Preflight both hosts.** On `.19` and separately on `.20`:

```bash
bash bench/preflight.sh
```

Must show `0 failure(s)` on both before proceeding. This is the check that catches the clock
fault (VMware Tools timesync fighting chrony - see
`memory/voice-agent-intermittent-network-fault.md`) and confirms the benchmark instance
actually has `BENCHMARK_MODE=1` set, not just that *a* process named `survey-agent` is running.

**2. From `.20`** (the chosen generator host, kept off `.19` so generator CPU never
contaminates the measurement you're taking):

```bash
export LIVEKIT_URL=...
export LIVEKIT_API_KEY=...
export LIVEKIT_API_SECRET=...
bash bench/stage1-ramp.sh
```

It prints a results directory, then waits for you to start the samplers (step 3) before it
begins. Steps default to `1 2 5 8 12 16 20` rooms (docs/PRD.md §6.3), 5 minutes each, 30s
cooldown between. Override with env vars:

```bash
ROOMS_STEPS="1 2 5" STEP_DURATION=2m bash bench/stage1-ramp.sh   # quick smoke run first
```

It wraps each step in a `systemd-run --scope -p CPUQuota=... -p LimitNOFILE=...` unit so the
generator itself doesn't compete unboundedly with the SIP/SFU containers also running on
`.20`, and can't silently cap itself below the room count you asked for. Defaults: one core
(`CPU_QUOTA=100%`) and 65536 open files (`NOFILE_LIMIT=65536`). At high room counts, raise the
CPU quota - a single generator process encoding/negotiating 60-100+ simultaneous WebRTC
streams on ~1 core became the actual bottleneck in earlier testing, producing failures that
looked like an agent-capacity ceiling but weren't:

```bash
CPU_QUOTA=400% ROOMS_STEPS="100" STEP_DURATION=6m bash bench/stage1-ramp.sh
```

The longer step duration matters too: rooms are created sequentially at roughly 1s/room, so
reaching 100 concurrent rooms alone can take most of a 2-minute step, leaving little steady-state
time to actually measure. `STEP_DURATION=6m` leaves room for both.

**3. In two more terminals, one per host**, started before you press Enter in step 2:

```bash
# on .19
bash bench/sample-host.sh <results-dir-from-step-2> 2 agent-19

# on .20
bash bench/sample-host.sh <results-dir-from-step-2> 2 agent-20
```

Stop both (Ctrl+C) once the ramp script prints "Ramp complete".

**4. Copy everything `.19` wrote into the results directory on `.20`.** Two files live only
on `.19`'s own filesystem and both need to cross over - it's easy to copy just the pm2 log and
forget the sampler's CSV, since `bench/sample-host.sh` on `.19` writes to `.19`'s local copy of
the results directory, not `.20`'s:

```bash
# the metrics.logMetrics() output (the MetricsCollected handler wired in src/main.ts) - by
# default pm2 writes it to ~/.pm2/logs/survey-agent-out.log; confirm with
# `pm2 logs survey-agent --lines 0` if unsure of the exact path
scp root@192.168.36.19:~/.pm2/logs/survey-agent-out.log <results-dir>/survey-agent-19.log

# .19's own host-resource sampler output - without this, parse-metrics.mjs can't report .19's
# CPU/mem at all, only .20's
scp root@192.168.36.19:<results-dir>/host-agent-19.csv <results-dir>/host-agent-19.csv
```

`host-agent-20.csv` needs no copy - that sampler already ran locally on `.20`.

**5. Analyze.** Requires Node on `.20` (only Docker and the `lk` binary have been needed here
until now) - `apt-get install -y nodejs` is enough, the script has no dependencies beyond
Node's built-ins so any reasonably recent version works:

```bash
node bench/parse-metrics.mjs \
  --markers <results-dir>/markers.csv \
  --pm2-log <results-dir>/survey-agent-19.log \
  --host-csv <results-dir>/host-agent-19.csv \
  --host-csv <results-dir>/host-agent-20.csv
```

Writes `summary.md` and `summary.json` into the results directory and prints the table.
**Check the "Bench mode" column first** - every row must say "yes"; if any row says
"NO - production build!", that step's results are void, not just suspect - it means the
production instance answered those load-test rooms instead of the benchmark one.

## Reading the result against docs/PRD.md §6.5

| Outcome | Decision |
|---|---|
| ≥ 12 calls/core, all steps pass | Clear win. Proceed to Phase 2. |
| 8-11 calls/core | Meaningful gain, but re-cost the project against the smaller margin. |
| ≤ 7 calls/core | No advantage over Dograh. Stop, write up findings, keep Dograh. |

A step "passes" when: no `sarvam-limit` or `gemini-timeout` errors dominate the error count
(those mean you hit a vendor ceiling, not a LiveKit one - see step 2 above), and your chosen
e2e-ish p95 threshold (PRD §9 decision 3, not yet set) holds.

Also watch **VAD infer** (`inferenceDurationTotalMs`) against host CPU busy% across steps. If
both climb together as rooms increase, the binding constraint is local turn-detection
inference, not provider I/O - the competing hypothesis in PRD §6.2, and the reason LiveKit's
own published sizing (10-25 jobs per 4 cores, i.e. 2.5-6.25/core) might not actually beat
Dograh's 5-6/core.

## What this doesn't cover yet

- **Stage 2 (SIP path validation)** - not built. Build it once Stage 1 gives you a target
  concurrency to validate at the SIP layer specifically.
- **Recording (Egress)** - deliberately excluded from both stages (PRD §8). It transcodes and
  would distort the CPU measurement this benchmark exists to produce.
- **Per-call memory attribution** - `sample-host.sh` reports host-wide memory, not
  per-job-process RSS. The agent forks a process per job, so memory-per-call is only visible
  as "total used memory divided by concurrent rooms" at each step - an approximation, not a
  precise per-process number.
