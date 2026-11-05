# Security policy

This is a research prototype. It does not talk to real vehicles and is not intended for production use as-is.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/igorbnd/edge-device-agent/security/advisories/new) instead, with steps to reproduce and the impact you expect.

You should get an acknowledgement within a week. Fixes go to the `main` branch; there are no versioned releases to backport to.

## Scope

In scope: the Worker and agent code in `src/`, including input validation, the action allowlist, the policy layer, and prompt injection through stored telemetry.

Out of scope: Cloudflare platform issues (report those to Cloudflare) and the rate limits of any public demo deployment.
