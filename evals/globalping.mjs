#!/usr/bin/env node
/**
 * "Where was your agent born?" — device location × agent placement, measured
 * from real Globalping probes (https://globalping.io) acting as bikes.
 *
 *   node evals/globalping.mjs [--warm 5] [--ai 3] [--devices GB,DE,...] [--mode sync|fast]
 *   node evals/globalping.mjs --summary evals/results/globalping-….json   # re-print a past run
 *
 * For each device location, one Globalping probe plays the bike and talks to two agents:
 *   near  created by the probe's own first request → the agent is born near the device
 *         (Durable Objects are placed near their first request and never move)
 *   hq    created beforehand from this machine (HQ, e.g. London provisioning) → the agent
 *         is born at HQ, wherever the bike later operates
 * The same probe is reused for every request (Globalping measurement-id locations).
 *
 * Per request we get the probe's HTTP timings (dns/tcp/tls/firstByte/total) and the
 * worker's own timings (worker/agent colo, worker→agent round trip, AI).
 * firstByte ≈ what a bike on a kept-alive connection waits for a reply.
 *
 * Budget: devices × (1 + 2·warm + 2·ai) Globalping tests (free: 250/hour unauthenticated),
 * and devices × 2·ai Workers AI calls (~5 neurons each with the 8B model).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const HOST = new URL(BASE).host;
const WARM = Number(arg('warm', 5));
const AI = Number(arg('ai', 3));
const MODE = arg('mode', 'sync');
const RUN = Date.now().toString(36);
const GP = 'https://api.globalping.io/v1';
const HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'edge-device-agent-latency-eval/1.0 (+https://github.com/igorbnd/edge-device-agent)' };

// Globalping "magic" location strings
const ALL_DEVICES = {
  GB: 'GB', DE: 'DE', 'US-East': 'New York', 'US-West': 'California', BR: 'BR', SG: 'SG', AU: 'AU',
};
const DEVICES = arg('devices', Object.keys(ALL_DEVICES).join(',')).split(',');

// ---------- Globalping client ----------

// 100 measurement POSTs/minute per IP: space them out globally
let nextPost = 0;
async function throttle() {
  const wait = nextPost - Date.now();
  nextPost = Math.max(Date.now(), nextPost) + 700;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/** One HTTP GET from one probe. `locations` is a location array or a previous measurement id. */
async function measure(locations, query) {
  await throttle();
  const res = await fetch(`${GP}/measurements`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      type: 'http',
      target: HOST,
      locations,
      ...(typeof locations === 'string' ? {} : { limit: 1 }),
      measurementOptions: { protocol: 'HTTPS', request: { method: 'GET', path: '/lab/probe', query } },
    }),
  });
  const created = await res.json();
  if (!res.ok) throw new Error(`Globalping ${res.status}: ${JSON.stringify(created.error ?? created).slice(0, 200)}`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 600));
    const m = await (await fetch(`${GP}/measurements/${created.id}`, { headers: HEADERS })).json();
    if (m.status !== 'in-progress') {
      const r = m.results?.[0];
      let body = null;
      try { body = JSON.parse(r?.result?.rawBody ?? 'null'); } catch { /* non-JSON body */ }
      return { id: created.id, probe: r?.probe, http: r?.result, body };
    }
  }
  throw new Error(`Globalping measurement ${created.id} did not finish`);
}

// ---------- experiment ----------

const median = xs => {
  const s = xs.filter(x => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function sample(m, kind, placement) {
  const t = m.body?.timings ?? {};
  return {
    kind, placement,
    ok: m.http?.statusCode === 200,
    tcp: m.http?.timings?.tcp ?? null,
    first_byte: m.http?.timings?.firstByte ?? null,
    total: m.http?.timings?.total ?? null,
    worker_colo: t.worker_colo ?? null,
    do_colo: t.do_colo ?? null,
    do_cold: t.do_cold ?? null,
    worker_total_ms: t.worker_total_ms ?? null,
    do_network_ms: t.worker_to_do_network_ms ?? null,
    ai_ms: t.ai_ms ?? null,
    command: m.body?.command ?? null,
    error: m.http?.statusCode === 200 ? null : (m.http?.rawOutput ?? m.body?.error ?? m.http?.status ?? 'failed'),
  };
}

const q = (bike, alert) => `bike=${bike}&trace=1&mode=${MODE}${alert ? '&alert=1' : ''}`;

async function runDevice(device) {
  const near = `LAB-NEAR-${device.replace(/[^A-Z]/gi, '')}-${RUN}`.toUpperCase();
  const hq = `LAB-HQ-${device.replace(/[^A-Z]/gi, '')}-${RUN}`.toUpperCase();
  const samples = [];

  // The probe's first request creates the near agent (and pins the probe for reuse)
  const first = await measure([{ magic: ALL_DEVICES[device] }], q(near, false));
  if (!first.probe) throw new Error(`no probe available for ${device}`);
  samples.push(sample(first, 'cold', 'near'));
  const probes = first.id;

  for (let i = 0; i < WARM; i++) {
    samples.push(sample(await measure(probes, q(near, false)), 'rules', 'near'));
    samples.push(sample(await measure(probes, q(hq, false)), 'rules', 'hq'));
  }
  for (let i = 0; i < AI; i++) {
    samples.push(sample(await measure(probes, q(near, true)), 'ai', 'near'));
    samples.push(sample(await measure(probes, q(hq, true)), 'ai', 'hq'));
  }

  const probe = first.probe;
  return { device, probe: { city: probe.city, country: probe.country, asn: probe.asn, network: probe.network }, near, hq, samples };
}

/**
 * Medians use warm samples only: a request that had to start the agent
 * (do_cold) measures a restart, not placement. Restarts are counted separately.
 */
function summarise(d) {
  const ok = d.samples.filter(s => s.ok);
  const pick = (kind, placement) => ok.filter(s => s.kind === kind && s.placement === placement && !s.do_cold);
  const out = { device: d.device, probe: `${d.probe.city}, ${d.probe.country}` };
  for (const placement of ['near', 'hq']) {
    const rules = pick('rules', placement), ai = pick('ai', placement);
    const any = [...rules, ...ai][0] ?? {};
    Object.assign(out, {
      [`${placement}_agent`]: any.do_colo,
      [`${placement}_rules_fb`]: median(rules.map(s => s.first_byte)),
      [`${placement}_do_net`]: median(rules.map(s => s.do_network_ms)),
      [`${placement}_ai_fb`]: median(ai.map(s => s.first_byte)),
    });
  }
  out.edge = ok[0]?.worker_colo ?? null;
  out.rtt = median(ok.map(s => s.tcp));
  out.penalty = out.hq_rules_fb != null && out.near_rules_fb != null ? out.hq_rules_fb - out.near_rules_fb : null;
  out.restarts = ok.filter(s => s.kind !== 'cold' && s.do_cold).length;
  out.errors = d.samples.length - ok.length;
  return out;
}

const COLS = ['device', 'probe', 'edge', 'rtt', 'near_agent', 'near_rules_fb', 'hq_agent', 'hq_rules_fb', 'penalty',
  'near_ai_fb', 'hq_ai_fb', 'near_do_net', 'hq_do_net', 'restarts', 'errors'];

function printTable(rows, mode) {
  const w = COLS.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = r => COLS.map((c, i) => String(r[c]).padEnd(w[i])).join('  ');
  console.log(`\nMode ${mode}. Warm-sample medians (ms). fb = time to first byte at the probe; rtt = TCP connect to the edge;`);
  console.log(`penalty = hq_rules_fb − near_rules_fb; restarts = requests that found the agent cold (excluded from medians).\n`);
  console.log(line(Object.fromEntries(COLS.map(c => [c, c]))));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  rows.forEach(r => console.log(line(r)));
}

async function main() {
  const summaryFile = arg('summary');
  if (summaryFile) {
    const saved = JSON.parse(readFileSync(summaryFile, 'utf8'));
    printTable(saved.devices.map(summarise), saved.mode);
    return;
  }

  // HQ provisioning: create every "hq" agent from this machine first
  const hqColos = {};
  for (const device of DEVICES) {
    const hq = `LAB-HQ-${device.replace(/[^A-Z]/gi, '')}-${RUN}`.toUpperCase();
    const r = await (await fetch(`${BASE}/lab/probe?bike=${hq}&trace=1&mode=${MODE}`)).json();
    hqColos[device] = r.timings?.do_colo;
  }
  console.log(`HQ agents created from this machine in: ${[...new Set(Object.values(hqColos))].join(', ')}`);
  console.log(`Running ${DEVICES.length} devices × ${1 + 2 * WARM + 2 * AI} Globalping tests…`);

  const results = await Promise.allSettled(DEVICES.map(runDevice));
  const devices = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') devices.push(r.value);
    else console.log(`  ${DEVICES[i]}: ${r.reason?.message ?? r.reason}`);
  });

  const rows = devices.map(summarise);
  printTable(rows, MODE);

  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `globalping-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ base: BASE, mode: MODE, warm: WARM, ai: AI, hq_colos: hqColos, rows, devices }, null, 2));
  console.log(`\n→ ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
