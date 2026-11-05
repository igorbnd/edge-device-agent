#!/usr/bin/env node
/**
 * Per-hop latency of the BikeAgent pipeline, measured against the lab worker.
 *
 *   node evals/latency.mjs [--base URL] [--warm 8] [--ai 3] [--hints weur,enam,...] [--wake-after 180]
 *
 * For each Durable Object location hint, a fresh LAB-* bike is created there,
 * then measured:
 *   cold    first request: creates the Durable Object
 *   rules   warm requests without alerts → no LLM call (validation, SQLite, history)
 *   ai      warm requests with an EPAC alert → one LLM call
 *   wake    with --wake-after N: one request per bike after N idle seconds
 *           (the Durable Object has been evicted from memory; its SQLite persists)
 *
 * --mode fast: AI requests get the rules answer immediately; the script then polls
 * /bike/:id/reviews until the LLM review of that reading is done (time to refined decision).
 *
 * Fixed agent: `--bike LAB-HOME --hints weur` creates or reuses one agent. Run it
 * again from another network location: the Worker moves, the agent does not.
 *
 * Client time is measured from this machine. Worker/DO/AI times come from the
 * worker's own `timings` (Workers clocks only advance on I/O, so synchronous
 * SQLite work shows as ~0 ms).
 *
 * Each AI request uses Workers AI quota (~5 neurons with the 8B model).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

// Point this at your own deployment (a workers.dev lab copy, or `wrangler dev`), not the public demo.
const BASE = arg('base', process.env.EBIKE_API_BASE);
if (!BASE) {
  console.error('Set --base <url> or EBIKE_API_BASE, e.g. https://e-bike-api-lab.<you>.workers.dev');
  process.exit(1);
}
const WARM = Number(arg('warm', 8));
const AI = Number(arg('ai', 3));
const HINTS = arg('hints', 'weur,eeur,enam,wnam,sam,apac,oc').split(',');
const RUN = Date.now().toString(36);
const WAKE_AFTER = Number(arg('wake-after', 0));
const FIXED_BIKE = arg('bike');
const MODE = arg('mode', 'sync');

const reading = alert => ({
  latitude: 51.5, longitude: -0.12,
  battery_level: 60 + Math.round(Math.random() * 30),
  motor_temp_celsius: 40 + Math.round(Math.random() * 10),
  speed_kmh: alert ? 28 : 12 + Math.round(Math.random() * 8),   // > 25 km/h raises an EPAC alert → LLM call
});

async function post(bikeId, hint, alert) {
  const started = performance.now();
  const res = await fetch(`${BASE}/telemetry?hint=${hint}&trace=1&mode=${MODE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bike_id: bikeId, ...reading(alert) }),
  });
  const body = await res.json();
  const client_ms = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const result = { client_ms, ...body.timings, action: body.agent?.agent_action?.command_to_bike ?? null, telemetry_id: body.agent?.telemetry_id };
  if (MODE === 'fast' && alert) Object.assign(result, await awaitReview(bikeId, result.telemetry_id, started));
  return result;
}

/** Polls the bike's reviews until the LLM review of this reading is done. */
async function awaitReview(bikeId, telemetryId, started) {
  for (let i = 0; i < 100; i++) {
    const { reviews = [] } = await (await fetch(`${BASE}/bike/${bikeId}/reviews`)).json();
    const r = reviews.find(x => x.telemetry_id === telemetryId);
    if (r && (r.status === 'done' || r.status === 'superseded')) {
      return {
        refined_client_ms: Math.round(performance.now() - started),
        review_ms: r.review_ms, alarm_delay_ms: r.alarm_delay_ms, review_ai_ms: r.ai_ms,
        llm_action: r.llm_action, changed: r.changed,
      };
    }
    await new Promise(res => setTimeout(res, 50));
  }
  return { refined_client_ms: null };
}

const median = xs => {
  const s = xs.filter(x => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function main() {
  // Baseline: this machine → nearest edge, no Durable Object, no AI
  const health = [];
  for (let i = 0; i < 6; i++) {
    const started = performance.now();
    await (await fetch(`${BASE}/health`)).json();
    health.push(Math.round(performance.now() - started));
  }
  const edgeRtt = median(health.slice(1));   // first includes TLS setup

  const rows = [];
  for (const hint of HINTS) {
    const bike = FIXED_BIKE ?? `LAB-${hint.toUpperCase()}-${RUN}`;
    const cold = await post(bike, hint, false);
    const rules = [];
    for (let i = 0; i < WARM; i++) rules.push(await post(bike, hint, false));
    const ai = [];
    for (let i = 0; i < AI; i++) ai.push(await post(bike, hint, true));

    rows.push({
      hint, bike,
      worker_colo: cold.worker_colo,
      do_colo: cold.do_colo,
      cold_client_ms: cold.client_ms,
      cold_do_ms: cold.worker_to_do_network_ms,
      rules_client_ms: median(rules.map(r => r.client_ms)),
      rules_do_net_ms: median(rules.map(r => r.worker_to_do_network_ms)),
      ai_client_ms: median(ai.map(r => r.client_ms)),
      ai_ms: median(ai.map(r => r.ai_ms)),
      ai_do_net_ms: median(ai.map(r => r.worker_to_do_network_ms)),
      refined_client_ms: median(ai.map(r => r.refined_client_ms)),
      review_ms: median(ai.map(r => r.review_ms)),
      alarm_delay_ms: median(ai.map(r => r.alarm_delay_ms)),
      changed: ai.filter(r => r.changed).length,
      raw: { cold, rules, ai },
    });
    process.stdout.write(`${hint} `);
  }
  console.log('\n');

  if (WAKE_AFTER > 0) {
    console.log(`Idle for ${WAKE_AFTER}s so the agents get evicted…`);
    await new Promise(r => setTimeout(r, WAKE_AFTER * 1000));
    for (const row of rows) {
      const wake = await post(row.bike, row.hint, false);
      Object.assign(row, { wake_cold: wake.do_cold, wake_do_ms: wake.worker_to_do_network_ms, wake_client_ms: wake.client_ms });
      row.raw.wake = wake;
    }
  }

  console.log(`Client → nearest edge (/health, warm median): ${edgeRtt} ms\n`);
  console.log(`Decision mode: ${MODE}`);
  const cols = ['hint', 'worker_colo', 'do_colo', 'cold_do_ms', 'rules_do_net_ms', 'rules_client_ms', 'ai_ms', 'ai_client_ms',
    ...(MODE === 'fast' ? ['alarm_delay_ms', 'review_ms', 'refined_client_ms', 'changed'] : []),
    ...(WAKE_AFTER > 0 ? ['wake_cold', 'wake_do_ms'] : [])];
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = r => cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  ');
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  rows.forEach(r => console.log(line(r)));

  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `latency-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ mode: MODE, base: BASE, edge_rtt_ms: edgeRtt, health_ms: health, warm: WARM, ai: AI, wake_after_s: WAKE_AFTER, rows }, null, 2));
  console.log(`\n→ ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
