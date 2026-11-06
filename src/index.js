/**
 * Edge agent per device — reference use case: e-bike fleet telemetry.
 *
 * Domain-neutral routing and agent plumbing; the use case itself (fields,
 * alerts, actions, prompt, policy) lives in src/domains/ebike.js.
 *
 * Demonstrates: Workers, KV, Durable Objects (stateful per-bike agents),
 * Workers AI (edge inference), Agentic AI (autonomous decision + command back to bike),
 * mTLS-ready architecture simulation, global deployment at the edge.
 *
 * Architecture:
 *   Worker (router) → validates device → forwards to BikeAgent (Durable Object)
 *   BikeAgent → stores telemetry in SQLite → contextualises against history → AI decision
 *
 * Public demo: anyone can test /health, /demo/send, and /demo/scenario endpoints.
 * Full API requires registered device IDs (EBIKE-001, EBIKE-002, EBIKE-003).
 *
 */

import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEMO_DEVICES, EXAMPLE_READING, FIELDS, SCHEMA_MIGRATIONS, SCHEMA_SQL,
  decide, generateAlerts, getHistoricalContext, labReading, rulesDecision, stateFromTelemetry,
  telemetryRow, validateTelemetry,
} from "./agent-core.js";

const TELEMETRY_COLUMNS = Object.keys(FIELDS);

// Reasoning before action in the model's JSON answer: 8B used the history far
// better that way (evals/README.md). DECISION_FORMAT = "action_first" restores the original.
// AI_THINKING = "off" skips a reasoning model's hidden thinking pass. For Gemma 4 that removed
// truncation and cut p50 from ~13 s to ~2 s with no loss in score (evals/README.md).
const decisionVariant = env => ({ reasoningFirst: env.DECISION_FORMAT !== 'action_first', noThinking: env.AI_THINKING === 'off' });

// ============================================================
// WORKER (Router)
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Optional: an old hostname that only says where the API went (MOVED_FROM_HOST → PUBLIC_HOST).
    if (env.MOVED_FROM_HOST && env.PUBLIC_HOST && url.hostname === env.MOVED_FROM_HOST) {
      return movedNotice(request, url, env, corsHeaders);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- Health Check & API Info ---
    if (path === '/' || path === '/health') {
      const base = url.origin;
      return jsonResponse({
        service: 'E-Bikes Telemetry API (Demo Prototype)',
        status: 'operational',
        version: '2.0',
        architecture: 'Edge compute (router) → BikeAgent (Durable Object per bike) → SQLite + Workers AI (for AI inference at the edge with historical context)',
        features: [
          'processing at the edge',
          'telemetry',
          'device-auth',
          'eapc-compliance check',
          'edge-ai',
          'agentic-actions',
//          'durable-object-agents',
//          'history(SQLite)',
//          'contextualised-ai',
        ],
        available_endpoints: [
          'GET  / and /health — API info and health-check',
          'POST /telemetry — Submit bike telemetry (AI analysis triggers on alerts)',
          'GET  /bike/:id — Latest state from BikeAgent',
          'GET  /bike/:id/history — Full telemetry history per bike',
          'GET  /bike/:id/reviews — LLM reviews of fast-path decisions',
          'GET  /fleet — Fleet overview with agent stats',
          'GET  /agent-log — Autonomous agents decision audit trail',
        ],
        demo_devices: Object.keys(DEMO_DEVICES),
        try_it: {
          step_1_health: `curl -s ${base}/health | jq .`,
          step_2_normal_telemetry: `curl -s -X POST ${base}/telemetry -H 'Content-Type: application/json' -d '{"bike_id":"EBIKE-001","latitude":51.75,"longitude":-0.34,"battery_level":78,"motor_temp_celsius":42,"speed_kmh":18}'`,
          step_3_trigger_ai_agent: `curl -s -X POST ${base}/telemetry -H 'Content-Type: application/json' -d '{"bike_id":"EBIKE-002","latitude":48.85,"longitude":2.35,"battery_level":8,"motor_temp_celsius":88,"speed_kmh":32}'`,
          step_4_see_history: `curl -s ${base}/bike/EBIKE-002/history | jq .`,
          step_5_fleet_overview: `curl -s ${base}/fleet | jq .`,
          step_6_agent_decisions: `curl -s ${base}/agent-log | jq .`,
          tip: 'Run step 3 multiple times so that the AI agent\'s decisions become more contextualised as the Durable Object accumulates telemetry history in its embedded SQLite.',
        },
        edge_location: request.cf?.colo || 'unknown',
        country: request.cf?.country || 'unknown',
        your_ip_address: request.headers.get('CF-Connecting-IP') || 'unknown',
        timestamp: new Date().toISOString(),
        ...(env.CONTACT_MESSAGE ? { contact: env.CONTACT_MESSAGE } : {}),
      }, 200, corsHeaders);
    }

    // --- GET /lab/probe (lab only) ---
    if (path === '/lab/probe' && request.method === 'GET' && env.LAB_MODE === '1') {
      return handleLabProbe(request, env, corsHeaders);
    }

    // --- POST /telemetry ---
    if (path === '/telemetry' && request.method === 'POST') {
      // Only the public hostname is limited, so lab runs on workers.dev aren't throttled.
      if (env.TELEMETRY_LIMITER && (!env.PUBLIC_HOST || url.hostname === env.PUBLIC_HOST)) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const { success } = await env.TELEMETRY_LIMITER.limit({ key: ip });
        if (!success) {
          return jsonResponse({
            error: 'rate_limited',
            message: 'Too many telemetry posts from your IP. The public demo allows 20 a minute, so try again in a minute.',
          }, 429, { ...corsHeaders, 'Retry-After': '60' });
        }
      }
      return handleTelemetry(request, env, corsHeaders);
    }

    // --- GET /bike/:id/history ---
    if (path.match(/^\/bike\/[^/]+\/history$/) && request.method === 'GET') {
      const bikeId = path.split('/')[2].toUpperCase();
      return handleGetBikeHistory(bikeId, env, corsHeaders);
    }

    // --- GET /bike/:id/reviews ---
    if (path.match(/^\/bike\/[^/]+\/reviews$/) && request.method === 'GET') {
      const bikeId = path.split('/')[2].toUpperCase();
      return handleGetBikeReviews(bikeId, env, corsHeaders);
    }

    // --- GET /bike/:id ---
    if (path.startsWith('/bike/') && request.method === 'GET') {
      const bikeId = path.replace('/bike/', '').toUpperCase();
      return handleGetBike(bikeId, env, corsHeaders);
    }

    // --- GET /fleet ---
    if (path === '/fleet' && request.method === 'GET') {
      return handleFleet(env, corsHeaders);
    }

    // --- GET /agent-log ---
    if (path === '/agent-log' && request.method === 'GET') {
      return handleAgentLog(env, corsHeaders);
    }

    return jsonResponse({
      error: 'Not found',
      available_endpoints: [
        'GET  /health — API info and health-check (try it first)',
        'POST /telemetry — Submit bike telemetry (AI analysis triggers on alerts)',
        'GET  /bike/:id — Latest state from BikeAgent',
        'GET  /bike/:id/history — Telemetry history from BikeAgent SQLite',
        'GET  /fleet — Fleet overview',
        'GET  /agent-log — Autonomous agents decision audit trail',
      ]
    }, 404, corsHeaders);
  }
};

// ============================================================
// BIKE AGENT — Durable Object (one per bike)
// ============================================================

export class BikeAgent extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.initialised = false;
    this.cold = true;      // first request handled by this in-memory instance
    this.colo = null;      // data center this Durable Object runs in (resolved on demand)
  }

  /** The DO's own location, via /cdn-cgi/trace. One subrequest per instance, excluded from timings. */
  async resolveColo() {
    if (this.colo) return;
    try {
      const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
      this.colo = /^colo=(\w+)$/m.exec(text)?.[1] ?? 'unknown';
    } catch {
      this.colo = 'unknown';
    }
  }

  initSchema() {
    if (this.initialised) return;
    for (const sql of SCHEMA_SQL) this.ctx.storage.sql.exec(sql);
    for (const sql of SCHEMA_MIGRATIONS) {
      try {
        this.ctx.storage.sql.exec(sql);
      } catch (err) {
        if (!/duplicate column/i.test(String(err?.message))) throw err;
      }
    }
    this.initialised = true;
  }

  async fetch(request) {
    this.initSchema();

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'telemetry' && request.method === 'POST') {
      const traceStarted = Date.now();
      if (url.searchParams.get('trace') === '1') await this.resolveColo();
      const mode = url.searchParams.get('mode') === 'fast' ? 'fast' : 'sync';
      return this.handleTelemetry(request, Date.now() - traceStarted, mode);
    }

    if (action === 'state') {
      return this.handleGetState();
    }

    if (action === 'history') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      return this.handleGetHistory(limit);
    }

    if (action === 'reviews') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      return this.handleGetReviews(limit);
    }

    if (action === 'decisions') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      return this.handleGetDecisions(limit);
    }

    if (action === 'reset') {
      return this.handleReset();
    }

    return jsonResponse({ error: 'Unknown action', available: ['telemetry', 'state', 'history', 'reviews', 'decisions', 'reset'] }, 400);
  }

  /**
   * Process incoming telemetry — the core agent logic.
   *
   * sync mode: alerts → LLM (with history) → policy → command, all in the request.
   * fast mode: alerts → rules → policy → provisional command in the request;
   *            the LLM reviews it afterwards from an alarm (see alarm()), and a
   *            changed command is delivered with the bike's next telemetry.
   */
  async handleTelemetry(request, traceMs = 0, mode = 'sync') {
    // Workers clocks only advance on I/O: awaited calls (AI) are timed
    // accurately, synchronous SQLite work shows as ~0 ms.
    const started = Date.now();
    const cold = this.cold;
    this.cold = false;
    let aiMs = null;

    const data = await request.json();
    const now = new Date().toISOString();
    const sql = this.ctx.storage.sql;

    const alerts = generateAlerts(data.telemetry);

    // Store in SQLite — persistent across requests
    sql.exec(
      `INSERT INTO telemetry (timestamp, ${TELEMETRY_COLUMNS.join(', ')}, edge_location, alerts_json)
       VALUES (?, ${TELEMETRY_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      now,
      ...telemetryRow(data.telemetry),
      data.edge_location || 'unknown',
      JSON.stringify(alerts)
    );
    const telemetryId = sql.exec(`SELECT last_insert_rowid() AS id`).one().id;

    // A command the LLM review changed since the bike last reported
    const command = this.takeReviewedCommand(now);

    // Historical context — the key differentiator
    const history = getHistoricalContext((q, ...params) => sql.exec(q, ...params).toArray());

    let agentDecision = null;
    let decisionMeta = null;
    let review = null;
    const hasCriticalAlerts = alerts.some(a => a.severity === 'critical' || a.severity === 'warning');

    if (hasCriticalAlerts && mode === 'fast') {
      agentDecision = rulesDecision(data.telemetry, alerts);
      decisionMeta = { model: 'rules' };
    } else if (hasCriticalAlerts && this.env.AI) {
      const aiStarted = Date.now();
      decisionMeta = await decide(this.env.AI, {
        bikeId: data.bike_id, telemetry: data.telemetry, alerts, history,
        model: this.env.AI_MODEL || DEFAULT_MODEL,
        maxTokens: Number(this.env.AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
        variant: decisionVariant(this.env),
      });
      aiMs = Date.now() - aiStarted;
      agentDecision = decisionMeta.decision;
    }

    if (agentDecision) {
      const source = mode === 'fast' ? 'rules' : agentDecision.fallback ? 'rules_fallback' : 'llm';
      sql.exec(
        `INSERT INTO agent_decisions (timestamp, action, parameters_json, reasoning, risk_level, telemetry_context, model, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        now,
        agentDecision.action,
        JSON.stringify(agentDecision.parameters || {}),
        agentDecision.reasoning,
        agentDecision.risk_level,
        JSON.stringify({
          telemetry: data.telemetry, alerts, history_summary: history,
          model_proposal: decisionMeta.proposal ?? null, rejected_output: decisionMeta.rejected ?? null,
        }),
        decisionMeta.model,
        source
      );
      const decisionId = sql.exec(`SELECT last_insert_rowid() AS id`).one().id;
      sql.exec(`UPDATE telemetry SET agent_decision_json = ? WHERE id = ?`, JSON.stringify(agentDecision), telemetryId);

      if (mode === 'fast' && this.env.AI) {
        review = await this.queueReview({ telemetryId, decisionId, now, data, alerts, fastAction: agentDecision.action });
      }
    }

    // Update bike state
    this.updateState('last_seen', now);
    for (const [key, value] of Object.entries(stateFromTelemetry(data.telemetry))) this.updateState(key, value);
    this.updateState('last_edge', data.edge_location || 'unknown');
    this.updateState('total_readings', String(this.getTotalReadings()));

    if (agentDecision) {
      this.updateState('last_agent_action', agentDecision.action);
      this.updateState('last_agent_timestamp', now);
    }

    if (alerts.length > 0) {
      this.updateState('last_alert_type', alerts[0].type);
      this.updateState('last_alert_timestamp', now);
    }

    // Build response
    const response = {
      status: 'accepted',
      bike_id: data.bike_id,
      telemetry_id: telemetryId,
      decision_mode: mode,
      processed_by: 'BikeAgent (Durable Object — stateful, persistent, per-bike)',
      telemetry_stored_in: 'Embedded SQLite (persistent across all requests for this bike)',
      total_readings: this.getTotalReadings(),
      alerts: alerts,
      historical_context: history,
    };

    if (agentDecision) {
      response.agent_action = {
        summary: `Agent autonomously issued ${agentDecision.action} to ${data.bike_id}`,
        command_to_bike: agentDecision.action,
        parameters: agentDecision.parameters || {},
        reasoning: agentDecision.reasoning,
        risk_level: agentDecision.risk_level,
        autonomous: true,
        provisional: mode === 'fast',
        review,
        contextualised: mode !== 'fast',
        history_informed: mode !== 'fast' && history.total_readings > 1,
        model: decisionMeta.model,
        fallback: agentDecision.fallback ?? false,
        policy_overrides: agentDecision.policy_overrides ?? [],
      };
    }

    if (command) response.updated_command = command;

    response.timings = { do_colo: this.colo, do_cold: cold, do_internal_ms: Date.now() - started, do_trace_ms: traceMs, ai_ms: aiMs };
    return jsonResponse(response);
  }

  /**
   * Queues an LLM review of a rules decision. Reviews that have not started
   * yet are superseded: under a burst of readings only the newest is reviewed.
   */
  async queueReview({ telemetryId, decisionId, now, data, alerts, fastAction }) {
    const sql = this.ctx.storage.sql;
    const superseded = sql.exec(`SELECT COUNT(*) AS n FROM reviews WHERE completed_at IS NULL AND started_at IS NULL`).one().n;
    sql.exec(
      `UPDATE reviews SET completed_at = ?, llm_action = 'SUPERSEDED', changed = 0
       WHERE completed_at IS NULL AND started_at IS NULL`,
      now
    );
    sql.exec(
      `INSERT INTO reviews (telemetry_id, decision_id, queued_at, payload_json, fast_action, coalesced) VALUES (?, ?, ?, ?, ?, ?)`,
      telemetryId, decisionId, now,
      JSON.stringify({ bike_id: data.bike_id, telemetry: data.telemetry, alerts }),
      fastAction, superseded
    );
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now());
    return { telemetry_id: telemetryId, status: 'queued', superseded_pending_reviews: superseded };
  }

  /**
   * Slow path: the LLM reviews the newest pending rules decision with the
   * bike's full history. If it changes the action, the decision of record is
   * updated and the new command waits for delivery. If inference fails, the
   * rules decision stands.
   */
  async alarm() {
    this.initSchema();
    const sql = this.ctx.storage.sql;
    const job = sql.exec(`SELECT * FROM reviews WHERE completed_at IS NULL ORDER BY telemetry_id DESC LIMIT 1`).toArray()[0];
    if (!job || !this.env.AI) return;

    sql.exec(`UPDATE reviews SET started_at = ? WHERE telemetry_id = ?`, new Date().toISOString(), job.telemetry_id);
    const { bike_id, telemetry, alerts } = JSON.parse(job.payload_json);
    const history = getHistoricalContext((q, ...params) => sql.exec(q, ...params).toArray(), { beforeDecisionId: job.decision_id });

    const aiStarted = Date.now();
    const result = await decide(this.env.AI, {
      bikeId: bike_id, telemetry, alerts, history,
      model: this.env.AI_MODEL || DEFAULT_MODEL,
      maxTokens: Number(this.env.AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
      variant: decisionVariant(this.env),
    });
    const aiMs = Date.now() - aiStarted;

    const d = result.decision;
    const fallback = Boolean(d.fallback);
    const changed = !fallback && d.action !== job.fast_action;
    sql.exec(
      `UPDATE reviews SET completed_at = ?, llm_action = ?, llm_parameters_json = ?, llm_reasoning = ?,
         changed = ?, fallback = ?, ai_ms = ? WHERE telemetry_id = ?`,
      new Date().toISOString(), d.action, JSON.stringify(d.parameters || {}), d.reasoning,
      changed ? 1 : 0, fallback ? 1 : 0, aiMs, job.telemetry_id
    );

    if (changed) {
      sql.exec(
        `UPDATE agent_decisions SET action = ?, parameters_json = ?, reasoning = ?, risk_level = ?, model = ?, source = 'llm_review'
         WHERE id = ?`,
        d.action, JSON.stringify(d.parameters || {}), d.reasoning, d.risk_level, result.model, job.decision_id
      );
      this.updateState('last_agent_action', d.action);
    } else if (!fallback) {
      sql.exec(`UPDATE agent_decisions SET model = ?, source = 'rules_confirmed_by_llm' WHERE id = ?`, result.model, job.decision_id);
    }

    // Readings that arrived while the model was running get their own review
    if (sql.exec(`SELECT COUNT(*) AS n FROM reviews WHERE completed_at IS NULL`).one().n > 0) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  /** The newest LLM-changed command not yet delivered to the bike (older ones are obsolete). */
  takeReviewedCommand(now) {
    const sql = this.ctx.storage.sql;
    const row = sql.exec(
      `SELECT * FROM reviews WHERE changed = 1 AND delivered_at IS NULL ORDER BY telemetry_id DESC LIMIT 1`
    ).toArray()[0];
    if (!row) return null;
    sql.exec(`UPDATE reviews SET delivered_at = ? WHERE changed = 1 AND delivered_at IS NULL`, now);
    return {
      command_to_bike: row.llm_action,
      parameters: JSON.parse(row.llm_parameters_json || '{}'),
      replaces: row.fast_action,
      reasoning: row.llm_reasoning,
      for_telemetry_id: row.telemetry_id,
      source: 'llm_review',
      reviewed_in_ms: Date.parse(row.completed_at) - Date.parse(row.queued_at),
    };
  }

  async handleGetReviews(limit) {
    const rows = this.ctx.storage.sql.exec(
      `SELECT telemetry_id, queued_at, started_at, completed_at, fast_action, llm_action, llm_reasoning,
              changed, fallback, coalesced, ai_ms, delivered_at
       FROM reviews ORDER BY telemetry_id DESC LIMIT ?`,
      Math.min(limit, 50)
    ).toArray();
    const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
    return jsonResponse({
      processed_by: 'BikeAgent (Durable Object)',
      reviews: rows.map(r => ({
        ...r,
        changed: r.changed === 1,
        fallback: r.fallback === 1,
        status: r.llm_action === 'SUPERSEDED' ? 'superseded' : r.completed_at ? 'done' : r.started_at ? 'running' : 'queued',
        alarm_delay_ms: ms(r.queued_at, r.started_at),
        review_ms: ms(r.queued_at, r.completed_at),
      })),
    });
  }

  async handleGetState() {
    const state = {};
    const rows = this.ctx.storage.sql.exec(
      `SELECT key, value, updated_at FROM bike_state ORDER BY key`
    ).toArray();

    for (const row of rows) {
      state[row.key] = { value: row.value, updated_at: row.updated_at };
    }

    return jsonResponse({
      processed_by: 'BikeAgent (Durable Object)',
      state: state,
      total_readings: this.getTotalReadings(),
      total_decisions: this.getTotalDecisions(),
      storage: 'Embedded SQLite (persistent across all requests for this bike)',
    });
  }

  async handleGetHistory(limit) {
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, timestamp, ${TELEMETRY_COLUMNS.join(', ')}, edge_location, alerts_json, agent_decision_json
       FROM telemetry ORDER BY id DESC LIMIT ?`,
      Math.min(limit, 100)
    ).toArray();

    const history = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      telemetry: Object.fromEntries(TELEMETRY_COLUMNS.map(c => [c, r[c]])),
      edge_location: r.edge_location,
      alerts: JSON.parse(r.alerts_json || '[]'),
      agent_decision: r.agent_decision_json ? JSON.parse(r.agent_decision_json) : null,
    }));

    return jsonResponse({
      processed_by: 'BikeAgent (Durable Object)',
      total_readings: this.getTotalReadings(),
      showing: history.length,
      history: history,
      description: 'This history is stored in the Durable Object\'s embedded SQLite database — persistent, queryable, per-bike. A stateless Worker would lose this data between requests.',
    });
  }

  async handleGetDecisions(limit) {
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, timestamp, action, parameters_json, reasoning, risk_level, model
       FROM agent_decisions ORDER BY id DESC LIMIT ?`,
      Math.min(limit, 50)
    ).toArray();

    const decisions = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      action: r.action,
      parameters: JSON.parse(r.parameters_json || '{}'),
      reasoning: r.reasoning,
      risk_level: r.risk_level,
      model: r.model,
    }));

    return jsonResponse({
      processed_by: 'BikeAgent (Durable Object)',
      total_decisions: decisions.length,
      decisions: decisions,
      note: 'Every autonomous AI decision stored in per-bike SQLite for compliance audit — persistent and queryable',
    });
  }

  async handleReset() {
    this.ctx.storage.sql.exec(`DELETE FROM telemetry`);
    this.ctx.storage.sql.exec(`DELETE FROM agent_decisions`);
    this.ctx.storage.sql.exec(`DELETE FROM bike_state`);
    this.ctx.storage.sql.exec(`DELETE FROM reviews`);

    return jsonResponse({
      status: 'reset',
      message: 'BikeAgent state cleared — telemetry history, agent decisions, and bike state all wiped',
      note: 'Send new telemetry to start building history again',
    });
  }

  // --- Helpers ---

  getTotalReadings() {
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM telemetry`).one()?.count || 0;
  }

  getTotalDecisions() {
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM agent_decisions`).one()?.count || 0;
  }

  updateState(key, value) {
    this.ctx.storage.sql.exec(
      `INSERT INTO bike_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, value
    );
  }
}

// ============================================================
// WORKER ROUTE HANDLERS (all endpoints)
// ============================================================

const EXPECTED_FORMAT = EXAMPLE_READING;

const LOCATION_HINTS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];

async function handleTelemetry(request, env, corsHeaders, bodyOverride = null) {
  const started = Date.now();
  const url = new URL(request.url);
  const lab = env.LAB_MODE === '1';
  let body = bodyOverride;
  if (!body) {
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON payload', expected_format: EXPECTED_FORMAT }, 400, corsHeaders);
    }
  }

  // Telemetry ends up in an LLM prompt and in the agent's memory: numbers only.
  const validation = validateTelemetry(body);
  if (!validation.ok) {
    return jsonResponse({ error: 'Invalid telemetry', details: validation.errors, expected_format: EXPECTED_FORMAT }, 400, corsHeaders);
  }

  const bikeId = validation.bike_id;
  const telemetry = validation.telemetry;
  let device = DEMO_DEVICES[bikeId];

  // Lab deployment only: any LAB-* id is a device, so latency runs get fresh agents
  if (!device && lab && bikeId.startsWith('LAB-')) {
    device = { model: 'Lab device', region: 'lab', registered: true };
  }

  if (!device && env.DEVICE_REGISTRY) {
    const kvDevice = await env.DEVICE_REGISTRY.get(bikeId, 'json');
    if (kvDevice) device = kvDevice;
  }

  if (!device) {
    return jsonResponse({
      error: 'Device not recognised',
      bike_id: bikeId,
      action: 'Device must be registered before sending telemetry',
      hint: 'In production, mTLS is used with client certificates to authenticate each device at the network level'
    }, 403, corsHeaders);
  }

  // Route to BikeAgent Durable Object
  if (env.BIKE_AGENT) {
    // Lab only: place a new bike's agent in a chosen region (applies on first creation)
    const hint = lab ? url.searchParams.get('hint') : null;
    const agentId = env.BIKE_AGENT.idFromName(bikeId);
    const agent = env.BIKE_AGENT.get(agentId, LOCATION_HINTS.includes(hint) ? { locationHint: hint } : undefined);
    const trace = url.searchParams.get('trace') === '1';
    // fast: rules answer now, LLM reviews afterwards. The lab can override per request.
    const requested = lab ? url.searchParams.get('mode') : null;
    const mode = ['fast', 'sync'].includes(requested) ? requested : env.DECISION_MODE === 'fast' ? 'fast' : 'sync';

    const agentPayload = {
      bike_id: bikeId,
      device: device,
      telemetry,
      edge_location: request.cf?.colo || 'unknown',
    };

    const doStarted = Date.now();
    const agentResponse = await agent.fetch(
      new Request(`https://agent/?action=telemetry&mode=${mode}${trace ? '&trace=1' : ''}`, {
        method: 'POST',
        body: JSON.stringify(agentPayload),
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const agentResult = await agentResponse.json();
    const doRoundtripMs = Date.now() - doStarted;

    const response = {
      status: 'accepted',
      message: `Telemetry routed to BikeAgent for ${bikeId}`,
      edge: {
        processed_at: request.cf?.colo || 'unknown',
        country: request.cf?.country || 'unknown',
        city: request.cf?.city || 'unknown',
        your_ip_address: request.headers.get('CF-Connecting-IP') || 'unknown',
      },
      device: device,
      agent: agentResult,
      timestamp: new Date().toISOString(),
    };

    // Also store in KV for fast fleet overview
    const kvStarted = Date.now();
    if (env.BIKE_TELEMETRY) {
      await env.BIKE_TELEMETRY.put(
        `latest:${bikeId}`,
        JSON.stringify(response),
        { expirationTtl: 86400 }
      );

      if (agentResult.agent_action) {
        await env.BIKE_TELEMETRY.put(
          `agent-log:${bikeId}:${Date.now()}`,
          JSON.stringify({
            bike_id: bikeId,
            decision: agentResult.agent_action,
            timestamp: response.timestamp,
          }),
          { expirationTtl: 604800 }
        );
      }
    }
    const kvMs = Date.now() - kvStarted;

    // Per-hop latency, as seen from inside the platform
    const t = agentResult.timings ?? {};
    const timings = {
      decision_mode: mode,
      worker_colo: request.cf?.colo || 'unknown',
      do_colo: t.do_colo ?? (trace ? 'unknown' : 'add ?trace=1'),
      do_cold: t.do_cold ?? null,
      worker_total_ms: Date.now() - started,
      worker_to_do_roundtrip_ms: doRoundtripMs,
      do_internal_ms: t.do_internal_ms ?? null,
      ai_ms: t.ai_ms ?? null,
      worker_to_do_network_ms: t.do_internal_ms != null ? Math.max(0, doRoundtripMs - t.do_internal_ms - (t.do_trace_ms ?? 0)) : null,
      kv_ms: kvMs,
    };
    response.timings = timings;

    const serverTiming = [
      `total;dur=${timings.worker_total_ms}`,
      `do-network;dur=${timings.worker_to_do_network_ms ?? 0}`,
      `ai;dur=${timings.ai_ms ?? 0}`,
      `kv;dur=${kvMs}`,
    ].join(', ');
    return jsonResponse(response, 200, { ...corsHeaders, 'Server-Timing': serverTiming });
  }

  // Fallback: stateless processing if DO not available
  return handleTelemetryStateless(request, env, corsHeaders, bikeId, telemetry, device);
}

/**
 * Fallback stateless telemetry processing — used if Durable Objects
 * are not configured. Preserves the API v1 logic.
 */
async function handleTelemetryStateless(request, env, corsHeaders, bikeId, telemetry, device) {
  const alerts = generateAlerts(telemetry);

  const telemetryRecord = {
    bike_id: bikeId,
    device: device,
    telemetry,
    alerts: alerts,
    edge: {
      processed_at: request.cf?.colo || 'unknown',
      country: request.cf?.country || 'unknown',
      city: request.cf?.city || 'unknown',
      your_ip_address: request.headers.get('CF-Connecting-IP') || 'unknown',
    },
    timestamp: new Date().toISOString(),
  };

  let agentDecision = null;
  let model = null;
  const hasCriticalAlerts = alerts.some(a => a.severity === 'critical' || a.severity === 'warning');

  if (hasCriticalAlerts && env.AI) {
    const result = await decide(env.AI, {
      bikeId, telemetry, alerts, history: null,
      model: env.AI_MODEL || DEFAULT_MODEL,
      maxTokens: Number(env.AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
    });
    agentDecision = result.decision;
    model = result.model;
  }

  if (agentDecision) {
    telemetryRecord.agent_decision = agentDecision;
    if (env.BIKE_TELEMETRY) {
      await env.BIKE_TELEMETRY.put(
        `agent-log:${bikeId}:${Date.now()}`,
        JSON.stringify({
          bike_id: bikeId,
          decision: agentDecision,
          alerts: alerts,
          telemetry_snapshot: telemetryRecord.telemetry,
          timestamp: telemetryRecord.timestamp,
        }),
        { expirationTtl: 604800 }
      );
    }
  }

  if (env.BIKE_TELEMETRY) {
    await env.BIKE_TELEMETRY.put(
      `latest:${bikeId}`,
      JSON.stringify(telemetryRecord),
      { expirationTtl: 86400 }
    );
  }

  const response = {
    status: 'accepted',
    message: `Telemetry processed at ${telemetryRecord.edge.processed_at} edge (stateless mode — Durable Objects not configured)`,
    record: telemetryRecord,
  };

  if (agentDecision) {
    response.agent_action = {
      summary: `Agent autonomously issued ${agentDecision.action} to ${bikeId}`,
      command_to_bike: agentDecision.action,
      parameters: agentDecision.parameters || {},
      reasoning: agentDecision.reasoning,
      risk_level: agentDecision.risk_level,
      autonomous: true,
      model,
      fallback: agentDecision.fallback ?? false,
      policy_overrides: agentDecision.policy_overrides ?? [],
      processed_at_edge: request.cf?.colo || 'unknown',
    };
  }

  return jsonResponse(response, 200, corsHeaders);
}

async function handleGetBike(bikeId, env, corsHeaders) {
  // Try Durable Object first
  if (env.BIKE_AGENT) {
    try {
      const agentId = env.BIKE_AGENT.idFromName(bikeId);
      const agent = env.BIKE_AGENT.get(agentId);
      const stateResponse = await agent.fetch(
        new Request('https://agent/?action=state')
      );
      const state = await stateResponse.json();

      if (state.total_readings > 0) {
        return jsonResponse({
          status: 'found',
          bike_id: bikeId,
          device: DEMO_DEVICES[bikeId] || null,
          agent_state: state,
          retrieved_from: 'BikeAgent Durable Object (persistent SQLite)',
        }, 200, corsHeaders);
      }
    } catch {
      // Fall through to KV
    }
  }

  // Fallback to KV
  if (env.BIKE_TELEMETRY) {
    const stored = await env.BIKE_TELEMETRY.get(`latest:${bikeId}`, 'json');
    if (stored) {
      return jsonResponse({
        status: 'found',
        bike_id: bikeId,
        latest_telemetry: stored,
        retrieved_from: 'KV store (edge-cached, globally distributed)',
      }, 200, corsHeaders);
    }
  }

  if (DEMO_DEVICES[bikeId]) {
    return jsonResponse({
      status: 'registered_no_data',
      bike_id: bikeId,
      device: DEMO_DEVICES[bikeId],
      message: 'Device registered but no telemetry received yet.',
    }, 200, corsHeaders);
  }

  return jsonResponse({
    error: 'Bike not found',
    bike_id: bikeId,
    registered_devices: Object.keys(DEMO_DEVICES),
  }, 404, corsHeaders);
}

async function handleGetBikeHistory(bikeId, env, corsHeaders) {
  if (!env.BIKE_AGENT) {
    return jsonResponse({ error: 'Durable Objects not configured' }, 503, corsHeaders);
  }

  // idFromName() would hand back an empty agent for any typo, so only bikes that telemetry accepts are looked up.
  const registered = DEMO_DEVICES[bikeId] || (env.DEVICE_REGISTRY && await env.DEVICE_REGISTRY.get(bikeId));
  if (!registered) {
    return jsonResponse({
      error: 'Bike not found',
      bike_id: bikeId,
      registered_devices: Object.keys(DEMO_DEVICES),
    }, 404, corsHeaders);
  }

  const agentId = env.BIKE_AGENT.idFromName(bikeId);
  const agent = env.BIKE_AGENT.get(agentId);

  const response = await agent.fetch(
    new Request('https://agent/?action=history&limit=50')
  );
  const result = await response.json();

  return jsonResponse({
    bike_id: bikeId,
    ...result,
  }, 200, corsHeaders);
}

/**
 * Lab only. GET version of POST /telemetry for measurement networks that can
 * only send GET (Globalping): synthesises a reading, runs the real telemetry
 * path, and returns a compact result (Globalping keeps only 10 kB of body).
 *   ?bike=LAB-…  &alert=1 (a reading that trips an alert → decision)  &hint, &mode, &trace as for /telemetry
 */
async function handleLabProbe(request, env, corsHeaders) {
  const url = new URL(request.url);
  const alert = url.searchParams.get('alert') === '1';
  const reading = {
    bike_id: url.searchParams.get('bike') || 'LAB-PROBE',
    ...labReading(alert),
  };
  const res = await handleTelemetry(request, env, corsHeaders, reading);
  const full = await res.json();
  const action = full.agent?.agent_action;
  return jsonResponse({
    status: full.status ?? 'error',
    error: full.error,
    bike_id: full.agent?.bike_id ?? reading.bike_id,
    device: { country: request.cf?.country, region: request.cf?.regionCode, city: request.cf?.city, asn: request.cf?.asn },
    command: action?.command_to_bike ?? null,
    provisional: action?.provisional ?? null,
    timings: full.timings,
  }, res.status, { ...corsHeaders, 'Server-Timing': res.headers.get('Server-Timing') ?? '' });
}

async function handleGetBikeReviews(bikeId, env, corsHeaders) {
  if (!env.BIKE_AGENT) {
    return jsonResponse({ error: 'Durable Objects not configured' }, 503, corsHeaders);
  }
  const agent = env.BIKE_AGENT.get(env.BIKE_AGENT.idFromName(bikeId));
  const result = await (await agent.fetch(new Request('https://agent/?action=reviews&limit=20'))).json();
  return jsonResponse({ bike_id: bikeId, ...result }, 200, corsHeaders);
}

async function handleFleet(env, corsHeaders) {
  const fleet = {};

  for (const [bikeId, device] of Object.entries(DEMO_DEVICES)) {
    let latestTelemetry = null;
    if (env.BIKE_TELEMETRY) {
      latestTelemetry = await env.BIKE_TELEMETRY.get(`latest:${bikeId}`, 'json');
    }

    let agentReadings = 0;
    if (env.BIKE_AGENT) {
      try {
        const agentId = env.BIKE_AGENT.idFromName(bikeId);
        const agent = env.BIKE_AGENT.get(agentId);
        const stateResponse = await agent.fetch(
          new Request('https://agent/?action=state')
        );
        const state = await stateResponse.json();
        agentReadings = state.total_readings || 0;
      } catch {
        // Agent not yet initialised
      }
    }

    fleet[bikeId] = {
      device,
      status: latestTelemetry ? 'reporting' : 'silent',
      has_active_alerts: latestTelemetry?.alerts?.length > 0 || latestTelemetry?.agent?.alerts?.length > 0 || false,
      has_agent_action: !!latestTelemetry?.agent_decision || !!latestTelemetry?.agent?.agent_action,
      agent_total_readings: agentReadings,
      last_telemetry: latestTelemetry || null,
    };
  }

  return jsonResponse({
    fleet_overview: {
      total_bikes: Object.keys(fleet).length,
      reporting: Object.values(fleet).filter(b => b.status === 'reporting').length,
      with_alerts: Object.values(fleet).filter(b => b.has_active_alerts).length,
      with_agent_actions: Object.values(fleet).filter(b => b.has_agent_action).length,
    },
    bikes: fleet,
    note: 'Fleet operator dashboard — real-time view across all connected e-bikes',
  }, 200, corsHeaders);
}

async function handleAgentLog(env, corsHeaders) {
  if (!env.BIKE_TELEMETRY) {
    return jsonResponse({
      error: 'Agent log requires KV store',
      note: 'Autonomous agent decisions are logged for regulatory audit and compliance',
    }, 503, corsHeaders);
  }

  const logEntries = [];
  const list = await env.BIKE_TELEMETRY.list({ prefix: 'agent-log:', limit: 20 });

  for (const key of list.keys) {
    const entry = await env.BIKE_TELEMETRY.get(key.name, 'json');
    if (entry) logEntries.push(entry);
  }

  return jsonResponse({
    agent_log: {
      total_decisions: logEntries.length,
      entries: logEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    },
    note: 'Autonomous agent decision audit trail — stored for compliance and regulatory reporting. Per-bike detailed history available via GET /bike/:id/history',
  }, 200, corsHeaders);
}

// ============================================================
// SHARED UTILITIES
// ============================================================

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function movedNotice(request, url, env, corsHeaders) {
  const newUrl = `https://${env.PUBLIC_HOST}${url.pathname}${url.search}`;
  const until = env.MOVED_UNTIL ? ` This address stops working on ${env.MOVED_UNTIL}.` : '';
  if ((request.headers.get('Accept') || '').includes('text/html')) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>E-Bikes API has moved</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}code{background:#eee;padding:.1rem .3rem}</style>
</head><body><h1>The E-Bikes API has moved</h1>
<p>It now lives at <a href="${newUrl}">${newUrl}</a>.</p>
<p>The old address <code>${url.hostname}</code> is being retired.${until} Please update your bookmarks and API clients.</p>
</body></html>`;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } });
  }
  return jsonResponse({
    error: 'moved',
    message: `The E-Bikes API has moved to ${env.PUBLIC_HOST}.${until}`,
    new_url: newUrl,
  }, 410, corsHeaders);
}
