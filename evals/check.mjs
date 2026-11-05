#!/usr/bin/env node
/**
 * Validates the scenario set and scores two rule baselines, both through applyPolicy
 * like the LLM decisions: `rules` (current reading only, what the Worker falls back to)
 * and `rules+hist` (rulesWithHistoryAction: the same history summary the LLM sees).
 * No network, no API keys.
 *
 *   node evals/check.mjs              # validate + baseline table
 *   node evals/check.mjs --show P1-B  # print the exact prompts for one scenario
 */

import { SCENARIOS } from './scenarios.mjs';
import { ACTIONS, applyPolicy, rulesWithHistoryAction } from '../src/agent-core.js';
import { buildPrompts, determineFallbackAction, generateAlerts, score } from './lib.mjs';

const showId = process.argv[process.argv.indexOf('--show') + 1];
if (process.argv.includes('--show')) {
  const s = SCENARIOS.find(x => x.id === showId);
  if (!s) { console.error(`Unknown scenario ${showId}`); process.exit(1); }
  for (const mode of ['full', 'none']) {
    const p = buildPrompts(s, mode);
    console.log(`\n===== ${s.id} — mode: ${mode} =====\n--- user ---\n${p.user}`);
  }
  console.log(`\n--- system ---\n${buildPrompts(s).system}`);
  process.exit(0);
}

// ---------- validation ----------
const errors = [];
const ids = new Set();
for (const s of SCENARIOS) {
  if (ids.has(s.id)) errors.push(`${s.id}: duplicate id`);
  ids.add(s.id);
  const { best, acceptable, unsafe } = s.expected;
  for (const a of [best, ...acceptable, ...unsafe]) if (!ACTIONS.includes(a)) errors.push(`${s.id}: unknown action ${a}`);
  if (!acceptable.includes(best)) errors.push(`${s.id}: best not in acceptable`);
  const overlap = acceptable.filter(a => unsafe.includes(a));
  if (overlap.length) errors.push(`${s.id}: acceptable ∩ unsafe = ${overlap}`);
  const alerts = generateAlerts(s.current);
  if (!alerts.some(a => a.severity === 'warning' || a.severity === 'critical')) {
    errors.push(`${s.id}: current reading raises no alert, so the worker would never call the model`);
  }
}

const pairs = {};
for (const s of SCENARIOS.filter(x => x.pair)) (pairs[s.pair] ??= []).push(s);
for (const [p, members] of Object.entries(pairs)) {
  const cur = JSON.stringify(members[0].current);
  if (members.some(m => JSON.stringify(m.current) !== cur)) errors.push(`${p}: members do not share the same current reading`);
  const contextual = members.filter(m => m.kind !== 'cold-start');
  if (new Set(contextual.map(m => m.expected.best)).size < 2) errors.push(`${p}: members have the same best action — pair cannot discriminate`);
  const lines = new Set(contextual.map(m => buildPrompts(m, 'full').historyLine));
  if (lines.size < contextual.length) errors.push(`${p}: history lines are identical — the model cannot tell the members apart`);
}

if (errors.length) {
  console.error('Scenario validation FAILED:\n  ' + errors.join('\n  '));
  process.exit(1);
}

// ---------- rule baselines ----------
const viaPolicy = (action, s, alerts) => applyPolicy({ action, parameters: {}, reasoning: 'rules', risk_level: 'medium' }, s.current, alerts).action;
const rows = SCENARIOS.map(s => {
  const p = buildPrompts(s, 'full');
  return {
    s, p,
    r: score(s, viaPolicy(determineFallbackAction(p.alerts), s, p.alerts)),
    h: score(s, viaPolicy(rulesWithHistoryAction(s.current, p.alerts, p.history), s, p.alerts)),
  };
});

const pad = (v, n) => String(v).padEnd(n);
console.log(`\n${SCENARIOS.length} scenarios OK, ${Object.keys(pairs).length} pairs\n`);
console.log(pad('ID', 6) + pad('kind', 12) + pad('best', 13) + pad('rules', 13) + pad('pts', 5) + pad('rules+hist', 13) + pad('pts', 5) + 'history line the model sees');
console.log('-'.repeat(130));
for (const { s, p, r, h } of rows) {
  const flag = x => (x.unsafe ? ' UNSAFE' : '');
  console.log(pad(s.id, 6) + pad(s.kind, 12) + pad(s.expected.best, 13) + pad(r.primary + flag(r), 13) + pad(r.points, 5)
    + pad(h.primary + flag(h), 13) + pad(h.points, 5) + p.historyLine.slice(0, 70));
}

console.log('-'.repeat(130));
for (const key of ['r', 'h']) {
  const all = rows.map(x => x[key]);
  const nonAdv = rows.filter(x => x.s.kind !== 'adversarial').map(x => x[key]);
  const pct = xs => Math.round((100 * xs.reduce((n, r) => n + r.points, 0)) / xs.length);
  const discriminated = Object.values(pairs).filter(members => {
    const ctx = members.filter(m => m.kind !== 'cold-start').map(m => rows.find(x => x.s === m)[key]);
    return ctx.every(r => r.points > 0) && new Set(ctx.map(r => r.primary)).size === ctx.length;
  }).length;
  console.log(`${key === 'r' ? 'Rules (current reading)' : 'Rules + history        '}: ${pct(all)}% of ${all.length}, ${pct(nonAdv)}% of the ${nonAdv.length} non-adversarial, ` +
    `unsafe ${all.filter(r => r.unsafe).length}, pairs discriminated ${discriminated}/${Object.keys(pairs).length}`);
}
