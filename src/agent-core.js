/**
 * Agent decision core — pure functions shared by the Worker and the evals.
 *
 * Pipeline: validateTelemetry → generateAlerts → getHistoricalContext → decide
 *   decide = LLM proposes (JSON schema, single action) → parseDecision → applyPolicy
 *
 * The LLM proposes; deterministic code disposes. Nothing the model returns
 * reaches a device unless it is one of ACTIONS and passes applyPolicy.
 *
 * This file is domain-neutral. The use case (fields, alerts, actions, history
 * summary, prompt, policy) comes from the domain module imported below; swap
 * it to run the same agent for a different kind of device (docs/adapting.md).
 */

import {
  ACTIONS, FIELDS, ID_FIELD, SYSTEM_PROMPT,
  applyPolicy, buildUserPrompt, determineFallbackAction, renderHistoryFindings, renderHistoryLine,
} from './domains/ebike.js';

export * from './domains/ebike.js';

export const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const DEFAULT_MAX_TOKENS = 200;

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

// ============================================================
// INPUT VALIDATION
// ============================================================

/**
 * Telemetry is untrusted input that ends up in an LLM prompt and in the
 * agent's memory, so every field must be a finite number in a plausible range.
 * Physically implausible-but-numeric values (e.g. 180 km/h) are accepted on
 * purpose: they are a sensor fault the agent should react to.
 */
export function validateTelemetry(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['Body must be a JSON object'] };
  const id = body[ID_FIELD];
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(id)) {
    errors.push(`${ID_FIELD} must be 1–32 characters of letters, digits or "-"`);
  }

  const telemetry = {};
  for (const [name, rule] of Object.entries(FIELDS)) {
    const v = body[name];
    if (v === undefined || v === null) {
      if (rule.required) errors.push(`${name} is required`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${name} must be a number`);
    } else if (v < rule.min || v > rule.max) {
      errors.push(`${name} must be between ${rule.min} and ${rule.max}`);
    } else {
      telemetry[name] = v;
    }
  }
  if (errors.length) return { ok: false, errors };
  const deviceId = id.toUpperCase();
  return { ok: true, device_id: deviceId, [ID_FIELD]: deviceId, telemetry };
}

/** Values for the telemetry columns, in FIELDS order, with defaults for omitted fields. */
export function telemetryRow(telemetry) {
  return Object.entries(FIELDS).map(([name, f]) => telemetry[name] ?? f.default ?? null);
}

// ============================================================
// MEMORY — per-device SQLite schema
// ============================================================

// One column per domain field (FIELDS), then fixed bookkeeping columns.
// The key-value table keeps its original name, bike_state, so existing agents keep their data.
export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
${Object.entries(FIELDS).map(([name, f]) => `    ${name} ${f.sql},\n`).join('')}    edge_location TEXT,
    alerts_json TEXT,
    agent_decision_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    parameters_json TEXT,
    reasoning TEXT,
    risk_level TEXT,
    telemetry_context TEXT,
    model TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bike_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  )`,
  // Fast path: LLM reviews of rules decisions, run from a Durable Object alarm.
  // completed_at IS NULL → pending; changed = 1 → a new command for the device.
  `CREATE TABLE IF NOT EXISTS reviews (
    telemetry_id INTEGER PRIMARY KEY,
    decision_id INTEGER,
    queued_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fast_action TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    llm_action TEXT,
    llm_parameters_json TEXT,
    llm_reasoning TEXT,
    changed INTEGER,
    fallback INTEGER,
    coalesced INTEGER DEFAULT 0,
    ai_ms INTEGER,
    delivered_at TEXT
  )`,
];

/**
 * Column additions for agents created before the column existed. SQLite has
 * no ADD COLUMN IF NOT EXISTS, so callers run each one and ignore "duplicate column".
 */
export const SCHEMA_MIGRATIONS = [
  `ALTER TABLE agent_decisions ADD COLUMN source TEXT`,
];

// ============================================================
// LLM PROPOSAL
// ============================================================

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    parameters: { type: 'object' },
    reasoning: { type: 'string' },
    risk_level: { type: 'string', enum: RISK_LEVELS },
  },
  required: ['action', 'reasoning', 'risk_level'],
};

/**
 * Eval variant: constrained decoding emits properties in schema order, so with
 * DECISION_SCHEMA the model commits to `action` before writing any reasoning.
 * This order makes it reason first.
 */
export const DECISION_SCHEMA_REASONING_FIRST = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    action: { type: 'string', enum: ACTIONS },
    parameters: { type: 'object' },
    risk_level: { type: 'string', enum: RISK_LEVELS },
  },
  required: ['reasoning', 'action', 'risk_level'],
};

const SYSTEM_PROMPT_REASONING_FIRST = SYSTEM_PROMPT.replace(
  /Respond with ONLY a JSON object: .*$/s,
  'Respond with ONLY a JSON object, reasoning first: {"reasoning":"1-2 sentences: what the history shows and what follows from it","action":"ACTION","parameters":{},"risk_level":"low|medium|high|critical"}',
);

/** Workers AI models return different shapes; reduce them to text or an object. */
function extractOutput(aiResponse) {
  if (aiResponse?.response != null) return aiResponse.response;
  const content = aiResponse?.choices?.[0]?.message?.content;
  if (content != null) return content;
  return '';
}

/** First balanced {...} in the text, respecting strings (models sometimes emit several). */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Returns { proposal } or { error }. A proposal always has an action from
 * ACTIONS; anything else is rejected, never forwarded to the device.
 */
export function parseDecision(aiResponse) {
  const out = extractOutput(aiResponse);
  let parsed = null;
  if (out && typeof out === 'object') {
    parsed = out;
  } else if (typeof out === 'string') {
    const json = firstJsonObject(out.replace(/```json\s*/g, '').replace(/```\s*/g, ''));
    try { parsed = json ? JSON.parse(json) : null; } catch { parsed = null; }
  }
  if (!parsed) return { error: 'unparseable', raw: typeof out === 'string' ? out.slice(0, 500) : out };

  const rawAction = Array.isArray(parsed.action) ? parsed.action[0] : parsed.action;
  const action = String(rawAction ?? '').trim().toUpperCase();
  if (!ACTIONS.includes(action)) return { error: 'invalid_action', invalid_action: String(rawAction).slice(0, 64) };

  return {
    proposal: {
      action,
      parameters: parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters) ? parsed.parameters : {},
      reasoning: String(parsed.reasoning ?? 'No reasoning provided').slice(0, 500),
      risk_level: RISK_LEVELS.includes(parsed.risk_level) ? parsed.risk_level : 'unknown',
    },
  };
}

// ============================================================
// FAST PATH — rules only, no model call
// ============================================================

/**
 * The decision the device gets immediately in fast mode. The LLM reviews it
 * afterwards and may replace it.
 */
export function rulesDecision(telemetry, alerts) {
  const critical = alerts.some(a => a.severity === 'critical');
  return applyPolicy({
    action: determineFallbackAction(alerts),
    parameters: {},
    reasoning: `Rules fast path: ${alerts.map(a => a.type).join(', ')}. Pending LLM review with history.`,
    risk_level: critical ? 'high' : 'medium',
  }, telemetry, alerts);
}

// ============================================================
// DECIDE — the full pipeline around one model call
// ============================================================

/**
 * @param deviceId the device's id (`bikeId` is accepted as an alias)
 * @param ai      anything with run(model, input) → Workers AI result (the AI binding, or a REST adapter)
 * @param history result of getHistoricalContext, or null to withhold history
 * @param variant eval-only prompt variants: { reasoningFirst, findings }; the Worker uses the defaults
 */
export async function decide(ai, { deviceId, bikeId, telemetry, alerts, history, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, temperature = 0.2, variant = {} }) {
  const fallback = reason => ({
    action: determineFallbackAction(alerts),
    parameters: {},
    reasoning: `${reason} — deterministic rule-based fallback applied`,
    risk_level: 'medium',
    fallback: true,
  });

  let aiResponse;
  try {
    aiResponse = await ai.run(model, {
      messages: [
        { role: 'system', content: variant.reasoningFirst ? SYSTEM_PROMPT_REASONING_FIRST : SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(deviceId ?? bikeId, telemetry, alerts, variant.findings ? renderHistoryFindings(history, telemetry) : renderHistoryLine(history)) },
      ],
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_schema', json_schema: variant.reasoningFirst ? DECISION_SCHEMA_REASONING_FIRST : DECISION_SCHEMA },
    });
  } catch (err) {
    return { decision: applyPolicy(fallback('AI inference unavailable'), telemetry, alerts), error: String(err?.message ?? err), model };
  }

  const parsed = parseDecision(aiResponse);
  const meta = { model, usage: aiResponse?.usage ?? null, finish_reason: aiResponse?.choices?.[0]?.finish_reason ?? null };
  if (parsed.error) {
    const why = parsed.error === 'invalid_action'
      ? `Model proposed an unknown action (${parsed.invalid_action})`
      : 'AI response not parseable';
    return { decision: applyPolicy(fallback(why), telemetry, alerts), rejected: parsed, ...meta };
  }
  return { decision: applyPolicy(parsed.proposal, telemetry, alerts), proposal: parsed.proposal, ...meta };
}

