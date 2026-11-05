#!/usr/bin/env node
/**
 * Pools samples from several run files and compares model × variant cells
 * with 95% confidence intervals.
 *
 *   node evals/compare.mjs evals/results/a.jsonl evals/results/b.jsonl … [--mode full] [--temperature 0.2]
 *
 * score: mean points on the 17 non-adversarial scenarios. Two bootstrap CIs (2,000 rounds):
 *        score_ci   resamples each scenario's own samples: sampling noise only, scenarios fixed
 *        scen_ci    also resamples the scenarios: would the result hold for a similar scenario set?
 * pairs: share of pair-repeats told apart (both members acceptable, different
 *        actions). Members are matched by file + repeat. CI: Wilson.
 * Rows without `variant` / `temperature` predate those flags: base, 0.2.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SCENARIOS } from './scenarios.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const MODE = arg('mode', 'full');
const TEMP = Number(arg('temperature', 0.2));
const files = process.argv.slice(2).filter((a, i, all) => a.endsWith('.jsonl') && !all[i - 1]?.startsWith('--'));

const byId = Object.fromEntries(SCENARIOS.map(s => [s.id, s]));
const rows = files.flatMap(f => readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .map(r => ({ ...r, variant: r.variant ?? 'base', temperature: r.temperature ?? 0.2, sample: `${basename(f)}:${r.repeat}` })))
  .filter(r => r.mode === MODE && r.temperature === TEMP && !r.error);

// deterministic PRNG so the CI is reproducible
let seed = 42;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const groups = {};
for (const r of rows) (groups[`${r.model.split('/').pop()}|${r.variant}`] ??= []).push(r);

const pct = x => `${Math.round(100 * x)}%`;
const out = [];
for (const [key, rs] of Object.entries(groups)) {
  const [model, variant] = key.split('|');
  const perScenario = {};
  for (const r of rs.filter(r => byId[r.scenario].kind !== 'adversarial')) (perScenario[r.scenario] ??= []).push(r.points);
  const ids = Object.keys(perScenario);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const score = mean(ids.map(id => mean(perScenario[id])));
  const boots = [];
  for (let b = 0; b < 2000; b++) {
    boots.push(mean(ids.map(id => {
      const xs = perScenario[id];
      return mean(xs.map(() => xs[Math.floor(rand() * xs.length)]));
    })));
  }
  boots.sort((a, b) => a - b);
  const bootsScen = [];
  for (let b = 0; b < 2000; b++) {
    bootsScen.push(mean(ids.map(() => {
      const xs = perScenario[ids[Math.floor(rand() * ids.length)]];
      return mean(xs.map(() => xs[Math.floor(rand() * xs.length)]));
    })));
  }
  bootsScen.sort((a, b) => a - b);

  let told = 0, total = 0;
  const pairs = [...new Set(SCENARIOS.filter(s => s.pair).map(s => s.pair))];
  for (const sample of new Set(rs.map(r => r.sample))) {
    for (const p of pairs) {
      const m = rs.filter(r => r.sample === sample && byId[r.scenario].pair === p && byId[r.scenario].kind !== 'cold-start');
      if (m.length < 2) continue;
      total++;
      if (m.every(x => x.points > 0) && new Set(m.map(x => x.primary)).size === m.length) told++;
    }
  }
  const [lo, hi] = wilson(told, total);
  const ms = rs.map(r => r.ms).filter(x => x > 0).sort((a, b) => a - b);
  const neurons = rs.filter(r => r.neurons != null);

  out.push({
    model, variant,
    samples: Math.round(rs.length / SCENARIOS.length),
    score: pct(score), score_ci: `${pct(boots[50])}–${pct(boots[1949])}`, scen_ci: `${pct(bootsScen[50])}–${pct(bootsScen[1949])}`,
    pairs: `${told}/${total}`, pairs_rate: pct(told / total || 0), pairs_ci: `${pct(lo)}–${pct(hi)}`,
    unsafe: rs.filter(r => r.unsafe).length,
    p50_ms: ms[Math.floor(ms.length / 2)] ?? null,
    neurons_per_call: neurons.length ? (neurons.reduce((n, r) => n + r.neurons, 0) / neurons.length).toFixed(1) : '—',
  });
}
out.sort((a, b) => (a.model + a.variant).localeCompare(b.model + b.variant));

const cols = Object.keys(out[0] ?? {});
const w = cols.map(c => Math.max(c.length, ...out.map(r => String(r[c]).length)));
const line = r => cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  ');
console.log(`mode ${MODE}, temperature ${TEMP}, ${files.length} files. 95% CIs: score bootstrap, pairs Wilson.\n`);
console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
console.log(w.map(n => '-'.repeat(n)).join('  '));
out.forEach(r => console.log(line(r)));
