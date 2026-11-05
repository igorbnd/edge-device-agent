# Contributing

Thanks for your interest. Issues and pull requests are welcome, especially:

- new or harder eval scenarios (`evals/scenarios.mjs`),
- domain modules for other kinds of devices (`src/domains/`), ideally with their own scenarios,
- results for other models or regions,
- bug fixes in the agent core or the Worker.

## Setup

Requires Node 22.5 or newer (the tests use the built-in `node:sqlite`). A Cloudflare account is only needed for model runs, latency runs and deploys.

```sh
npm test               # unit tests for the decision core, no network
npm run eval:check     # validates the scenarios and scores the rule baselines, no network
npx wrangler dev       # local Worker, Durable Objects and SQLite
```

To adapt the agent to another kind of device, see [docs/adapting.md](docs/adapting.md).

Copy `wrangler.example.toml` to `wrangler.toml` and fill in your own values before running `wrangler`. `wrangler.toml` is git-ignored; never commit account IDs, namespace IDs or secrets.

## Pull requests

- Keep changes focused; one topic per pull request.
- Run `npm test` and `npm run eval:check` before opening it. CI runs both.
- If a change affects decisions, include before/after eval numbers (`node evals/compare.mjs ...`) and add the raw results under `evals/results/`.
- Model runs use Workers AI quota. Note the model ID, sample count and date in the description.
- Match the existing code style: plain ES modules, no build step, no extra dependencies unless they are clearly needed.

## Reporting bugs

Open an issue with the request you sent, the response you got, and what you expected. For security issues, see [SECURITY.md](SECURITY.md) instead.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
