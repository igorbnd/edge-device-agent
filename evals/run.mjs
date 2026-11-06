#!/usr/bin/env node
/**
 * Runs the scenario set against Workers AI models over the REST API.
 *
 *   node evals/run.mjs                                   # all models, both modes, 5 repeats
 *   node evals/run.mjs --models 8b-fast,70b --repeats 1 --scenarios P1-A,P1-B
 *   node evals/run.mjs --models qwen3-30b --max-tokens 200   # force the deployed token budget
 *   node evals/run.mjs --summary evals/results/<file>.jsonl   # re-print a past run
 *   node evals/run.mjs --models 8b-fast --variants base,rfirst,findings,rfirst+findings
 *   node evals/run.mjs --models 8b-fast --variants rfirst --temperature 0.7 --repeats 9
 *
 * Auth: CLOUDFLARE_API_TOKEN if set, otherwise the wrangler OAuth login.
 * Account: CLOUDFLARE_ACCOUNT_ID, otherwise account_id from ../wrangler.toml.
 *
 * Each call runs the real pipeline from src/agent-core.js:
 *   validateTelemetry → decide() (JSON schema, parse, allowlist) → applyPolicy
 * and scores the action the Worker would actually send to the bike.
 *
 * Latency is laptop → Cloudflare API → model, so compare it across models only.
 * It is not the in-worker edge latency.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';
import { buildHistoricalContext, decide, generateAlerts, score, validateTelemetry } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// maxTokens: 200 is what the worker sends. Reasoning models spend that on
// thinking and return empty content, so they get a larger budget here, which
// means they are NOT drop-in replacements for the deployed config.
export const MODELS = {
  '8b-fast': { id: '@cf/meta/llama-3.1-8b-instruct-fast', maxTokens: 200 },   // what the worker calls today (uncatalogued)
  '8b-fp8': { id: '@cf/meta/llama-3.1-8b-instruct-fp8', maxTokens: 200 },
  '70b': { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', maxTokens: 200 },
  'gpt-oss-20b': { id: '@cf/openai/gpt-oss-20b', maxTokens: 1500, reasoning: true },
  'qwen3-30b': { id: '@cf/qwen/qwen3-30b-a3b-fp8', maxTokens: 1500, reasoning: true },
  'gemma4-26b': { id: '@cf/google/gemma-4-26b-a4b-it', maxTokens: 1500, reasoning: true },
};

// Prompt variants (see decide() in src/agent-core.js). `base` is the original action-first
// format; `rfirst` is what the Worker sends by default since 2026-11-06 (DECISION_FORMAT).
//   rfirst    reasoning before action in the JSON schema
//   findings  history stated as conclusions instead of numbers
export const VARIANTS = {
  base: {},
  rfirst: { reasoningFirst: true },
  findings: { findings: true },
  'rfirst+findings': { reasoningFirst: true, findings: true },
};

// ---------- args ----------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

// ---------- auth ----------
function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const toml = readFileSync(join(HERE, '..', 'wrangler.toml'), 'utf8');
  return toml.match(/^account_id\s*=\s*"([^"]+)"/m)[1];
}

/** `wrangler auth token` refreshes an expired OAuth login; the config file copy may be stale. */
function wranglerToken() {
  try {
    return JSON.parse(execFileSync('wrangler', ['auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).token;
  } catch {
    throw new Error('No usable wrangler login — run `wrangler login` or set CLOUDFLARE_API_TOKEN');
  }
}

let token = process.env.CLOUDFLARE_API_TOKEN || wranglerToken();
let refreshed = false;
function refreshToken() {
  if (process.env.CLOUDFLARE_API_TOKEN || refreshed) return false;
  token = wranglerToken();
  refreshed = true;
  return true;
}

// ---------- Workers AI ----------
const ACCOUNT = accountId();
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

async function cf(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
    if (res.status === 401 && refreshToken()) continue;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
    }
    return body.result;
  }
}

/** Lets decide() call Workers AI over REST exactly as it calls the AI binding. */
const restAI = { run: (model, input) => cf(`/ai/run/${model}`, { method: 'POST', body: JSON.stringify(input) }) };

async function prices() {
  try {
    const list = await cf('/ai/models/search?per_page=500');
    const out = {};
    for (const m of list) {
      const p = m.properties?.find(x => x.property_id === 'price')?.value;
      if (!Array.isArray(p)) continue;
      const get = unit => p.find(x => x.unit?.includes(unit))?.price ?? null;
      out[m.name] = { in: get('input'), out: get('output') };
    }
    return out;
  } catch {
    return {};
  }
}

// ---------- run ----------
async function runOne(job) {
  const { scenario, mode, model, maxTokens, repeat, variant, temperature } = job;
  const base = { scenario: scenario.id, pair: scenario.pair ?? null, kind: scenario.kind, mode, model, variant, temperature, repeat, max_tokens: maxTokens };

  const validation = validateTelemetry({ bike_id: 'EBIKE-001', ...scenario.current });
  if (!validation.ok) {
    return { ...base, ms: 0, rejected_input: validation.errors, error: null, parse_failed: false, truncated: false, ...score(scenario, 'REJECTED') };
  }

  const alerts = generateAlerts(validation.telemetry);
  const history = mode === 'full' ? buildHistoricalContext(scenario) : null;
  const started = performance.now();
  const r = await decide(restAI, { bikeId: validation.bike_id, telemetry: validation.telemetry, alerts, history, model, maxTokens, temperature, variant: VARIANTS[variant] });
  const ms = Math.round(performance.now() - started);

  return {
    ...base, ms,
    tokens_in: r.usage?.prompt_tokens ?? null, tokens_out: r.usage?.completion_tokens ?? null,
    neurons: r.usage?.neurons ?? null,
    error: r.error ?? null,
    parse_failed: r.rejected?.error === 'unparseable',
    model_invalid_action: r.rejected?.invalid_action ?? null,
    truncated: r.finish_reason === 'length',
    proposal: r.proposal?.action ?? null,
    policy_overrides: r.decision.policy_overrides ?? [],
    fallback: r.decision.fallback ?? false,
    reasoning: r.decision.reasoning,
    ...score(scenario, r.decision.action),
  };
}

async function pool(jobs, size, fn, onDone) {
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      onDone(await fn(job));
    }
  });
  await Promise.all(workers);
}

// ---------- summary ----------
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export function summarise(rows, priceTable = {}) {
  const groups = {};
  for (const r of rows) (groups[`${r.model}|${r.mode}|${r.variant ?? 'base'}|${r.temperature ?? 0.2}`] ??= []).push(r);
  const pairIds = [...new Set(SCENARIOS.filter(s => s.pair && s.kind !== 'cold-start').map(s => s.pair))];

  const out = [];
  for (const [key, rs] of Object.entries(groups)) {
    const [model, mode, variant, temperature] = key.split('|');
    const ok = rs.filter(r => !r.error);
    const repeats = [...new Set(rs.map(r => r.repeat))];

    let disc = 0, discTotal = 0;
    for (const k of repeats) {
      for (const pair of pairIds) {
        const members = ok.filter(r => r.repeat === k && r.pair === pair && r.kind !== 'cold-start');
        const expected = SCENARIOS.filter(s => s.pair === pair && s.kind !== 'cold-start').length;
        if (members.length !== expected) continue;
        discTotal++;
        if (members.every(m => m.points > 0) && new Set(members.map(m => m.primary)).size === members.length) disc++;
      }
    }

    const tin = ok.reduce((n, r) => n + (r.tokens_in ?? 0), 0);
    const tout = ok.reduce((n, r) => n + (r.tokens_out ?? 0), 0);
    const price = priceTable[model];
    const costPer1k = price?.in != null && ok.length
      ? ((tin * price.in + tout * (price.out ?? 0)) / 1e6 / ok.length) * 1000
      : null;

    out.push({
      model, mode, variant, temp: temperature, calls: rs.length, errors: rs.length - ok.length,
      score: pct(ok.reduce((n, r) => n + r.points, 0), ok.length),
      unsafe: ok.filter(r => r.unsafe).length,
      invalid: ok.filter(r => r.invalid.length).length,
      model_invalid: ok.filter(r => r.model_invalid_action).length,
      overridden: ok.filter(r => r.policy_overrides?.length).length,
      rejected_in: ok.filter(r => r.rejected_input).length,
      parse_fail: ok.filter(r => r.parse_failed).length,
      truncated: ok.filter(r => r.truncated).length,
      pairs: `${disc}/${discTotal}`,
      p50_ms: quantile(ok.filter(r => r.ms > 0).map(r => r.ms), 0.5),
      p95_ms: quantile(ok.filter(r => r.ms > 0).map(r => r.ms), 0.95),
      usd_per_1k: costPer1k == null ? '—' : costPer1k.toFixed(3),
    });
  }
  return out.sort((a, b) => (a.model + a.mode + a.variant).localeCompare(b.model + b.mode + b.variant));
}

function printTable(rows) {
  const cols = Object.keys(rows[0] ?? {});
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = r => cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  ');
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  rows.forEach(r => console.log(line(r)));
}

// ---------- main ----------
async function main() {
  const summaryFile = arg('summary');
  if (summaryFile) {
    const rows = readFileSync(summaryFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    printTable(summarise(rows, await prices()));
    return;
  }

  const modelKeys = arg('models', Object.keys(MODELS).join(',')).split(',');
  const maxOverride = arg('max-tokens');
  const models = modelKeys.map(k => {
    const m = MODELS[k] ?? { id: k, maxTokens: 200 };
    return { ...m, maxTokens: maxOverride ? Number(maxOverride) : m.maxTokens };
  });
  const modes = arg('modes', 'full,none').split(',');
  const repeats = Number(arg('repeats', 5));
  const only = arg('scenarios');
  const scenarios = only ? SCENARIOS.filter(s => only.split(',').includes(s.id)) : SCENARIOS;
  const concurrency = Number(arg('concurrency', 4));
  const variants = arg('variants', 'base').split(',');
  const temperature = Number(arg('temperature', 0.2));
  const unknown = variants.filter(v => !VARIANTS[v]);
  if (unknown.length) throw new Error(`unknown variant(s): ${unknown.join(', ')}`);

  const jobs = [];
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const m of models) for (const variant of variants) for (const mode of modes) for (const scenario of scenarios)
      jobs.push({ scenario, mode, model: m.id, maxTokens: m.maxTokens, repeat, variant, temperature });

  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  writeFileSync(file, '');
  console.log(`${jobs.length} calls → ${file}`);

  const rows = [];
  let done = 0;
  await pool(jobs, concurrency, runOne, r => {
    rows.push(r);
    appendFileSync(file, JSON.stringify(r) + '\n');
    if (++done % 20 === 0 || done === jobs.length) process.stdout.write(`\r${done}/${jobs.length}`);
  });
  console.log('\n');

  const errs = rows.filter(r => r.error);
  if (errs.length) {
    const byModel = {};
    for (const e of errs) byModel[e.model] ??= e.error;
    console.log('Errors (first per model):');
    for (const [m, e] of Object.entries(byModel)) console.log(`  ${m}: ${e}`);
    console.log();
  }
  printTable(summarise(rows, await prices()));
}

main().catch(e => { console.error(e); process.exit(1); });
