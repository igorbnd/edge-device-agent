# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-11-05

First public release.

### Added

- Domain-neutral agent core (`src/agent-core.js`) with the e-bike use case isolated in `src/domains/ebike.js`, and a guide to adapting it to other devices (`docs/adapting.md`).
- Worker and `BikeAgent` Durable Object: one stateful agent per bike with SQLite memory, alerts, LLM decisions and a policy layer.
- Fast decision mode: rules answer immediately, an LLM review runs afterwards from a Durable Object alarm.
- Guardrails: telemetry type and range checks, a JSON-schema action enum, an action allowlist and `applyPolicy`.
- Eval suite: 20 labelled scenarios, model runs, pooled comparison with confidence intervals, rule baselines.
- Latency tooling: per-hop timings and a Globalping device × agent-placement study.
- Optional rate limit for telemetry posts on a public hostname.
