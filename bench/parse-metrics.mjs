#!/usr/bin/env node
// Post-processes a benchmark run: correlates .19's pm2 log (the LLM/TTS/EOU/VAD metrics
// wired in src/main.ts via metrics.logMetrics()) against the step windows recorded in
// markers.csv by bench/stage1-ramp.sh, and optionally folds in host CPU/mem samples from
// bench/sample-host.sh and (Stage 2 only) SIP call statistics from the SIP container logs.
//
// This script makes the pass/fail call per docs/PRD.md §6.5 - stage1-ramp.sh only executes
// steps and records their time windows, it does not judge them.
//
// Usage:
//   node bench/parse-metrics.mjs --markers results/<run-id>/markers.csv \
//     --pm2-log /path/to/survey-agent-out.log \
//     [--host-csv results/<run-id>/host-agent-19.csv] \
//     [--host-csv results/<run-id>/host-agent-20.csv] \
//     [--sip-container livekit-sip-1] \
//     [--out results/<run-id>]
//
// Omit --sip-container for a Stage 1 (WebRTC-only) run - agent-load-test rooms never touch
// the SIP service, so there is no input_frames_dropped signal to correlate for those steps.

import { parseArgs } from 'node:util';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const { values: args } = parseArgs({
  options: {
    markers: { type: 'string' },
    'pm2-log': { type: 'string' },
    'host-csv': { type: 'string', multiple: true, default: [] },
    'sip-container': { type: 'string' },
    out: { type: 'string' },
  },
});

if (!args.markers || !args['pm2-log']) {
  console.error(
    'Usage: node bench/parse-metrics.mjs --markers <path> --pm2-log <path> ' +
      '[--host-csv <path> ...] [--sip-container <name>] [--out <dir>]',
  );
  process.exit(1);
}

const outDir = args.out ?? dirname(args.markers);
mkdirSync(outDir, { recursive: true });

// --- Load step windows -------------------------------------------------------------------
function loadMarkers(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').slice(1);
  return lines
    .filter(Boolean)
    .map((line) => {
      const [step, rooms, startEpoch, endEpoch, durationS] = line.split(',');
      return {
        step: Number(step),
        rooms: Number(rooms),
        startMs: Number(startEpoch) * 1000,
        endMs: Number(endEpoch) * 1000,
        durationS: Number(durationS),
      };
    });
}

// --- Stream the pm2 pino log, bucket lines by step window --------------------------------
async function loadMetricsByStep(pm2LogPath, steps) {
  const buckets = new Map(
    steps.map((s) => [s.step, { llm: [], tts: [], eou: [], vad: [], errors: [], benchmarkModeSeen: null }]),
  );

  const rl = createInterface({ input: createReadStream(pm2LogPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // non-JSON banner line (e.g. "◇ injected env ...") - skip
    }
    if (typeof rec.time !== 'number') continue;

    if (rec.msg === 'survey-agent starting' && typeof rec.benchmarkMode === 'boolean') {
      // A restart log line applies to this step and every later one in the run, since the
      // worker doesn't restart again mid-ramp.
      for (const s of steps) {
        if (rec.time <= s.endMs) {
          const b = buckets.get(s.step);
          if (b.benchmarkModeSeen === null) b.benchmarkModeSeen = rec.benchmarkMode;
        }
      }
      continue;
    }

    const step = steps.find((s) => rec.time >= s.startMs && rec.time <= s.endMs);
    if (!step) continue;
    const bucket = buckets.get(step.step);

    if (rec.msg === 'LLM metrics') bucket.llm.push(rec);
    else if (rec.msg === 'TTS metrics') bucket.tts.push(rec);
    else if (rec.msg === 'EOU metrics') bucket.eou.push(rec);
    else if (rec.msg === 'VAD metrics') bucket.vad.push(rec);
    else if (typeof rec.level === 'number' && rec.level >= 50) bucket.errors.push(rec);
  }
  return buckets;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

function classifyError(rec) {
  const text = JSON.stringify(rec).toLowerCase();
  if (text.includes('sarvam') && (text.includes('403') || text.includes('429'))) return 'sarvam-limit';
  if ((text.includes('google') || text.includes('gemini')) && (text.includes('timeout') || text.includes('deadline')))
    return 'gemini-timeout';
  return 'other';
}

// --- Optional: host CPU/mem within each window --------------------------------------------
function loadHostCsv(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').slice(1);
  return lines
    .filter(Boolean)
    .map((line) => {
      const [epoch, host, us, sy, id, wa, st, memUsedMb] = line.split(',');
      return {
        epoch: Number(epoch),
        host,
        us: Number(us),
        sy: Number(sy),
        id: Number(id),
        wa: Number(wa),
        st: Number(st),
        memUsedMb: Number(memUsedMb),
      };
    });
}

function summarizeHost(samples, step) {
  const inWindow = samples.filter((s) => s.epoch * 1000 >= step.startMs && s.epoch * 1000 <= step.endMs);
  if (inWindow.length === 0) return null;
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const busy = inWindow.map((s) => 100 - s.id);
  return {
    host: inWindow[0].host,
    avgCpuBusyPct: Math.round(avg(busy) * 10) / 10,
    maxCpuBusyPct: Math.round(Math.max(...busy) * 10) / 10,
    avgSteal: Math.round(avg(inWindow.map((s) => s.st)) * 100) / 100,
    peakMemMb: Math.max(...inWindow.map((s) => s.memUsedMb)),
  };
}

// --- Optional: Stage 2 SIP call statistics -------------------------------------------------
function summarizeSip(container, step) {
  const since = new Date(step.startMs).toISOString();
  const until = new Date(step.endMs).toISOString();
  let logs;
  try {
    logs = execFileSync('docker', ['logs', container, '--since', since, '--until', until], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return { callCount: 0, callsWithDroppedFrames: 0, error: `docker logs failed: ${err.message}` };
  }

  const calls = [];
  for (const line of logs.split('\n')) {
    if (!line.includes('"call statistics"')) continue;
    const dropped = line.match(/"input_frames_dropped":(\d+)/);
    if (!dropped) continue;
    calls.push({ droppedFrames: Number(dropped[1]) });
  }
  return {
    callCount: calls.length,
    callsWithDroppedFrames: calls.filter((c) => c.droppedFrames > 0).length,
  };
}

// --- Main ----------------------------------------------------------------------------------
const steps = loadMarkers(args.markers);
const metricsByStep = await loadMetricsByStep(args['pm2-log'], steps);
const hostSamples = args['host-csv'].map(loadHostCsv);

const rows = steps.map((step) => {
  const bucket = metricsByStep.get(step.step);

  const ttft = bucket.llm.map((r) => r.ttftMs).filter((v) => typeof v === 'number');
  const ttfb = bucket.tts.map((r) => r.ttfbMs).filter((v) => typeof v === 'number');
  const eouDelay = bucket.eou.map((r) => r.endOfUtteranceDelayMs).filter((v) => typeof v === 'number');
  const vadInference = bucket.vad.map((r) => r.inferenceDurationTotalMs).filter((v) => typeof v === 'number');

  const errorCounts = {};
  for (const err of bucket.errors) {
    const kind = classifyError(err);
    errorCounts[kind] = (errorCounts[kind] ?? 0) + 1;
  }

  return {
    step: step.step,
    rooms: step.rooms,
    durationS: step.durationS,
    benchmarkModeConfirmed: bucket.benchmarkModeSeen,
    turnCount: bucket.llm.length,
    ttftMs: { p50: percentile(ttft, 50), p95: percentile(ttft, 95) },
    ttfbMs: { p50: percentile(ttfb, 50), p95: percentile(ttfb, 95) },
    eouDelayMs: { p50: percentile(eouDelay, 50), p95: percentile(eouDelay, 95) },
    vadInferenceMs: { p50: percentile(vadInference, 50), p95: percentile(vadInference, 95) },
    errorCounts,
    hosts: hostSamples.map((samples) => summarizeHost(samples, step)).filter(Boolean),
    sip: args['sip-container'] ? summarizeSip(args['sip-container'], step) : null,
  };
});

// --- Render ----------------------------------------------------------------------------------
const fmtMs = (v) => (v === null || v === undefined ? '-' : `${v}ms`);

let md = `# Benchmark summary\n\nGenerated ${new Date().toISOString()}\n\n`;
md += `| Step | Rooms | Bench mode | Turns | e2e-ish p95 | LLM TTFT p50/p95 | TTS TTFB p50/p95 | EOU delay p50/p95 | VAD infer p50/p95 | Errors | Host CPU busy % (avg/max) |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;

for (const r of rows) {
  const e2eP95 =
    r.eouDelayMs.p95 !== null && r.ttftMs.p95 !== null && r.ttfbMs.p95 !== null
      ? Math.round((r.eouDelayMs.p95 + r.ttftMs.p95 + r.ttfbMs.p95) * 100) / 100
      : null;
  const errTotal = Object.values(r.errorCounts).reduce((a, b) => a + b, 0);
  const errStr =
    errTotal === 0
      ? '0'
      : `${errTotal} (${Object.entries(r.errorCounts)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ')})`;
  const hostStr = r.hosts.map((h) => `${h.host}: ${h.avgCpuBusyPct}/${h.maxCpuBusyPct}`).join('; ') || '-';
  const benchStr =
    r.benchmarkModeConfirmed === true ? 'yes' : r.benchmarkModeConfirmed === false ? '**NO - production build!**' : 'not seen in log';

  md += `| ${r.step} | ${r.rooms} | ${benchStr} | ${r.turnCount} | ${fmtMs(e2eP95)} | ${fmtMs(r.ttftMs.p50)}/${fmtMs(r.ttftMs.p95)} | ${fmtMs(r.ttfbMs.p50)}/${fmtMs(r.ttfbMs.p95)} | ${fmtMs(r.eouDelayMs.p50)}/${fmtMs(r.eouDelayMs.p95)} | ${fmtMs(r.vadInferenceMs.p50)}/${fmtMs(r.vadInferenceMs.p95)} | ${errStr} | ${hostStr} |\n`;

  if (r.sip) {
    md += `\n  Step ${r.step} SIP: ${r.sip.callCount} call(s), ${r.sip.callsWithDroppedFrames} with dropped frames${r.sip.error ? ` (${r.sip.error})` : ''}\n\n`;
  }
}

md += `\n---\n\n**Reading this table:**\n`;
md += `- "Bench mode" must read "yes" for every step. "NO - production build!" means this run hit the production build (end-call tool, misuse guardrail, 15-min timer all active) and its results are not valid for capacity comparison.\n`;
md += `- "e2e-ish p95" sums EOU delay + LLM TTFT + TTS TTFB, each at its own p95 - a trend indicator across steps, not a true joint end-to-end p95.\n`;
md += `- If "VAD infer" rises with room count alongside CPU busy%, local turn-detection inference is the binding constraint, not provider I/O - see docs/PRD.md §6.2's competing hypothesis.\n`;
md += `- Per docs/PRD.md §6.5, a step passes only if: dropped-frame calls are 0 (Stage 2 only - Stage 1 has no SIP leg, "sip" will be absent), errors are 0 or clearly attributable to a provider limit, and e2e-ish p95 stays within your chosen threshold (PRD §9 decision 3).\n`;

writeFileSync(join(outDir, 'summary.md'), md);
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));

console.log(md);
console.log(`\nWritten to ${join(outDir, 'summary.md')} and summary.json`);
