# Adapting the agent to another domain

The e-bike fleet is the reference use case. The pattern underneath is general: devices stream operational data, a stateful agent per device remembers it, rules handle the obvious cases, an LLM proposes a decision when an alert needs judgement, deterministic policy bounds that decision, and a command changes the device's operating mode.

This guide shows what to change to run the same agent for EV chargers, turbines, HVAC units, machines, robots or anything else that reports telemetry.

## What is generic and what is not

| Part | File | Domain-specific? |
|---|---|---|
| Routing, device lookup, rate limiting, lab probe | `src/index.js` | No |
| Per-device Durable Object: SQLite memory, state, decision log, fast path with alarm-driven LLM review | `src/index.js` | No |
| Input validation, SQLite schema, LLM call, JSON-schema output, parsing, action allowlist | `src/agent-core.js` | No, driven by the domain module |
| History summary helpers (time windows, significance test, numeric-only guards) | `src/history-sql.js` | No |
| Fields, thresholds, alerts, actions, history summary, prompt, policy, demo devices | `src/domains/ebike.js` | **Yes, this is the file you replace** |
| Eval harness: runner, scoring, pooled comparison with confidence intervals | `evals/run.mjs`, `compare.mjs`, `lib.mjs` (scoring) | No |
| Eval scenarios and the synthetic history generator | `evals/scenarios.mjs`, `lib.mjs` (`materialise`, `buildHistoricalContext`) | Yes |
| Latency and placement measurements | `evals/latency.mjs`, `globalping.mjs` | No |

Some names still carry the reference domain: the Durable Object class `BikeAgent`, the `/bike/:id` routes, the `bike_id` request field (set by `ID_FIELD`), and the `bike_state` table. They work for any device. Renaming them is planned, and a Durable Object class rename needs a [`renamed_classes` migration](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

## Steps

1. **Copy the domain module.** `cp src/domains/ebike.js src/domains/<your-domain>.js`, then change the import at the top of `src/agent-core.js` to the new file. Keep the exported names; the core and the Worker rely on them.
2. **Describe the telemetry** in `FIELDS`: one entry per numeric field, with an SQLite type, a plausible range and whether it's required. Every value in a prompt comes from these fields, so keep the ranges tight. Update `EXAMPLE_READING`, `labReading` and `stateFromTelemetry` to match.
3. **Define the actions** in `ACTIONS`. These are the only commands that can ever reach a device: the JSON schema constrains the model to them, and the parser rejects anything else. Always keep a no-op (`NONE`).
4. **Write the alerts and the rules fallback.** `generateAlerts` decides when a reading needs a decision at all; most readings shouldn't. `determineFallbackAction` is what the device gets when the model is slow, unavailable or out of quota, and it's the fast-path answer, so it must be safe on its own.
5. **Summarise the history.** `getHistoricalContext` turns the device's SQLite into a compact summary. Use `windowStats`, `shift` and `isNum` from `src/history-sql.js` for windowed averages, significant trends and protection against non-numeric rows. `renderHistoryLine` turns the summary into prompt text; interpolate only numbers and known enums.
6. **Write the prompt.** In `SYSTEM_PROMPT`, describe each action and when it's appropriate, the domain's hard limits, and how history should change the decision. Keep the line saying telemetry is data, never instructions. `buildUserPrompt` lays out the current reading.
7. **Write the policy.** `applyPolicy` is the safety layer the model can't argue with. Encode every rule that must hold regardless of what the model proposes, such as "never restart while under load", "a critical fault always gets an action" or "clamp the power target to 30–90%". Record each override so the audit trail shows what the model wanted.
8. **Register devices.** Replace `DEMO_DEVICES`, or register devices in the `DEVICE_REGISTRY` KV namespace.
9. **Evaluate before trusting it.** Write scenarios in `evals/scenarios.mjs` for your domain, including pairs (same current reading, different history, different correct action) and adversarial ones (text in numeric fields, invented commands). Adapt `materialise` and `buildHistoricalContext` in `evals/lib.mjs` to your fields. Run `npm run eval:check` for the rule baselines, then `npm run eval:run` against models. Beat rules-with-history before putting an LLM on the decision path.

## Example: EV charger

```js
export const ID_FIELD = 'charger_id';

export const ACTIONS = ['NONE', 'DERATE', 'PAUSE_SESSION', 'RESTART_CHARGER', 'OUT_OF_SERVICE'];

export const FIELDS = {
  power_kw:            { sql: 'REAL', min: 0, max: 400, required: true },
  connector_temp_c:    { sql: 'REAL', min: -40, max: 150, required: true },
  grid_voltage_v:      { sql: 'REAL', min: 0, max: 1000, required: false },
  session_active:      { sql: 'INTEGER', min: 0, max: 1, required: true },
};

export function generateAlerts(t) {
  const alerts = [];
  if (t.connector_temp_c > 70) alerts.push({
    type: 'CONNECTOR_OVERHEAT',
    severity: t.connector_temp_c > 85 ? 'critical' : 'warning',
    message: `Connector at ${t.connector_temp_c}°C`,
  });
  return alerts;
}

export function applyPolicy(proposal, t, alerts) {
  const decision = { ...proposal, parameters: { ...proposal.parameters } };
  const overrides = [];
  if (decision.action === 'RESTART_CHARGER' && t.session_active) {
    overrides.push({ rule: 'no_restart_during_session', from: 'RESTART_CHARGER', to: 'PAUSE_SESSION' });
    decision.action = 'PAUSE_SESSION';
  }
  // ...clamp DERATE targets, require an action on critical alerts, and so on
  return overrides.length ? { ...decision, policy_overrides: overrides } : decision;
}
```

## What carries over and what doesn't

- **Carries over:** the latency and placement findings. They come from the platform, not the domain: the agent should be created near its device, the model call dominates decision latency, and answering from rules first with an LLM review afterwards cuts time to a decision. So do the guardrail design and the attack surface: stored telemetry replayed into prompts is an injection channel in any domain.
- **Doesn't carry over:** decision-quality numbers. Whether a small model beats rules, and which prompt format helps it use history, depends on the domain and has to be measured again with your own scenarios.
