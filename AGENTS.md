# FlowBlock agent guide

This is an independent repository. Read [README.md](README.md), the [domain contract](src/domain/README.md), and the nearest subsystem README before editing.

- Keep local planning functional without a database, credentials, or model access.
- Recompile plans from source inputs. Never trust caller-provided paths or validation results.
- Treat a geometry pass as conditional on supplied measurements. Do not claim physical safety or human review.
- Keep video measurements in image space. Uncertain tracking is not evidence of product disappearance.
- Protect owner checks, idempotency, immutable plan history, explicit revision acceptance, and cancellation publication guards.
- Do not commit credentials, media, downloaded model weights, or raw tracing artifacts.
- Preserve completed evaluation receipts. Freeze the runtime when changing behavior after an experiment; document which version each comparison used.
- Do not provision remote infrastructure for this local reference app.

## Checks

Run `bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build` after relevant changes. The database integration tests use isolated schemas when `FLOWBLOCK_TEST_DATABASE_URL` or `DATABASE_URL` is present. `node --env-file=.env.local node_modules/vitest/vitest.mjs run` includes those tests locally.

Use `bun run test:e2e` against the production server for browser regression checks. Set `PLAYWRIGHT_PWA_TEST=1` for offline cache/reload validation. Worker checks run with `uv --no-config run --project worker --env-file .env.local --group dev pytest worker/tests`; the CI workflow also supplies PostgreSQL and FFmpeg.

Use `bun run format` for live TypeScript, React, and CSS. Never format or edit `training/frozen/` or historical `training/results/` receipts.

Regenerate `docs/schemas` and `docs/openapi.json` with `bun run schemas` after contract changes. Review `.github/CODEOWNERS` for new areas. No tests belong in Git hooks.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
