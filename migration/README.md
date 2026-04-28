# 🚚 Migration

API parity testing for projects migrating REST endpoints from a legacy module
to a new module on the same paths. OpenAPI-driven discovery + per-endpoint
runs + schema-shape diff + targeted AI-fix dispatch.

## Setup (per project)

1. Open this craft tab.
2. Click **Config** to set:
   - `Legacy base URL` (e.g. `http://localhost:8080`)
   - `New base URL` (e.g. `http://localhost:9090`)
   - `OpenAPI spec` — relative path inside the project (e.g.
     `docs/fnac-rest-schema-7.6.json`).
   - `Diff mode` — usually `shape` (only hit the new server, validate
     against OpenAPI). Switch to `exact` if you have legacy running and
     want full deep-equal.
3. Click **Discover from docs** — Forge parses the OpenAPI spec + per-
   controller migration docs (`docs/migration/*.md`) + history file and
   builds the endpoint list.

## Run tests

- Single endpoint: `Run` button on any row.
- Batch: top-bar **Run all** (or select rows + **Run selected**).
- Failures get clustered by error type + controller in the right sidebar.

## Failure handling

Click the 🔍 icon on a failing row to open the diagnose drawer:
- The drawer shows the actual response, expected schema, and a
  failure-category-targeted fix playbook.
- The prompt is editable in-place — bump it, add hints, paste extra
  context.
- Send to your **bound terminal** (default — interactive) or as a Forge
  **task** (background).

Use 🏷 to flag an endpoint as `deviated`/`accepted`/`wontfix`/`flaky` when
the divergence is intentional. Flagged endpoints don't pollute the
failure list and the AI gets told the deviation is on purpose.

## Storage

Per-craft storage at `<project>/.forge/crafts/migration/data/`:
- `config.json` — your config
- `endpoints.json` — discovered endpoints
- `run-<ts>.json` — one file per batch run
- `failures.json` — latest cluster
- `annotations.json` — per-endpoint flags

## License

MIT.
