# FlowBlock

Plan a product shot in the room you have, rehearse it, and use an actual take to choose one adjustment.

FlowBlock is an independent Next.js application. The local stack uses PostgreSQL, private files on this machine, and a Python SAM 2.1 Small worker. Forge APIs provide optional planning, traces, and a recorded training experiment. No CoreWeave Kubernetes or object-storage infrastructure is provisioned by this repository.

## Run locally

Install Node.js 24, Bun 1.3.14, Docker, uv, and FFmpeg. From the repository root:

```sh
bun install --frozen-lockfile
bun run setup:local
docker compose --env-file .env.local up -d db
bun run db:migrate
bun run dev
```

Open [FlowBlock](http://127.0.0.1:3037). The [sample shot](http://127.0.0.1:3037/sample) is read only. The [developer view](http://127.0.0.1:3037/developer) shows model lineage, recorded evaluation results, and this account’s job metadata.

In another terminal, start the real video worker:

```sh
cd worker
uv --no-config sync --frozen --python 3.12
uv --no-config run --no-sync flowblock-worker setup-model
FLOWBLOCK_HEALTH_HOST=127.0.0.1 uv --no-config run --env-file ../.env.local --no-sync flowblock-worker serve --device mps
```

`mps` uses the GPU on Apple Silicon with documented CPU fallbacks. Use `--device cpu` on a machine without an available GPU. CUDA requires a compatible NVIDIA environment and has not been validated here. Model setup downloads and verifies the pinned checkpoint; it does not train SAM.

The app and worker must use the same **absolute** `FLOWBLOCK_STORAGE_DIR`. The setup command creates that configuration and never overwrites an existing `.env.local`. It prints no secrets.

For a local production server, stop the dev server, run `bun run build`, then `bun run start`. Offline reload is enabled in the production build after its service worker caches the application shell. Database and model outages do not disable local geometry editing.

## Make a shot

1. Replace the example room, product, table, obstacles, and camera configuration with your measurements. Measurements use meters.
2. Choose a recipe or describe a brief. Up to three generated candidates appear above the canvas; each keeps its own edits.
3. Inspect the dashed camera path, start circle, end square, operator footprint, and approximate framing. Every edit recompiles from the source inputs. Invalid drafts remain inspectable but do not receive rehearsal guidance.
4. Save a version and rehearse. Record a trimmed 5–15 second clip in your camera app.
5. In Review, mark the product on a clear frame and confirm its expected-visible interval. Upload starts only when you choose **Upload & analyze**. Training consent is separate and off by default.
6. Inspect the track, intended framing, usable coverage, and timestamped evidence. Uncertain masks remain unmeasured. Add a correction box when tracking needs help.
7. Request one revision, inspect its changed parameter, and apply it explicitly. The original plan and prior attempts remain available for comparison.

PNG export and browser print-to-PDF work locally. Shared links contain immutable plan snapshots, never footage, and can be revoked. Explicit project synchronization uses expected-version checks; a conflict preserves the local draft for reconciliation.

## Forge configuration and result

Set `WANDB_API_KEY`, `WANDB_ENTITY`, and `WANDB_PROJECT` in the local environment or `.env.local`. The key stays server-side. The default planner is `openai/gpt-oss-20b`. Model actions go through a strict JSON protocol and deterministic validation. Failure returns an explicitly labeled recipe-library fallback.

The committed experiment trained `meta-llama/Llama-3.1-8B-Instruct` on 238 solver-labeled examples for one epoch. Independent job and checkpoint readback verified completion. On the 12-task held-out qualification, the candidate produced **zero useful matching shots**. Its six aggregate score gains were abstentions on a scene where the fixed recipe search found no matching candidate. That finite search does not prove the scene impossible. The candidate was not promoted.

Read [the training procedure](training/README.md), [recorded results](training/results/README.md), and [machine-readable summary](training/results/summary.json). These results cover two synthetic scene groups. They do not establish creator benefit, cinematic quality, or general model performance.

## Implementation

| Area | Entry point | Responsibility |
| --- | --- | --- |
| Web workspace | [src/app/page.tsx](src/app/page.tsx) | Plan, Rehearse, Review, local drafts, exports, synchronization |
| Shared engine | [src/domain/README.md](src/domain/README.md) | Analytic paths, swept geometry, optics, versioned contracts |
| API | [src/server/api.ts](src/server/api.ts) | Ownership, uploads, jobs, quotas, revisions, snapshots |
| Planning coordinator | [src/server/planner.ts](src/server/planner.ts) | Bounded JSON actions, tool execution, Forge traces |
| Revision coordinator | [src/server/revision-planner.ts](src/server/revision-planner.ts) | Evidence citations, one parameter change, geometric validation |
| Video worker | [worker/README.md](worker/README.md) | FFmpeg proxies, real SAM tracking, measurements, leased jobs |
| Persistence | [migrations/001_initial.sql](migrations/001_initial.sql) | Immutable versions, ownership, attempt records, leases |
| Native interfaces | [src/domain/native-companion.ts](src/domain/native-companion.ts) | Future room-scan import and AR alignment contracts |

[Generated JSON schemas](docs/schemas) and the [OpenAPI reference](docs/openapi.json) describe the public data and operations. Regenerate them with `bun run schemas`. See [architecture](docs/architecture.md) and [operating instructions](docs/operations.md) for retention, recovery, authentication, and rollback.

## What has and has not been established

The code includes deterministic geometry checks, real local model execution, evidence-linked revisions, and a trained candidate with a negative qualification result. [Verification](docs/verification.md) separates executed checks from proposed acceptance targets.

The twelve recipes are authored and programmatically checked. A cinematographer has not reviewed them. The local ML demonstration uses a labeled synthetic clip; no creator-recorded field study has been completed. Actual iPhone and Android capture/upload testing, the proposed 30-clip tracking benchmark, and creator reuse/time-to-usable-take measurements remain open.

Framing is an approximation from a product box. The app does not reconstruct metric camera motion from footage, guarantee clearance in an unmeasured room, simulate lighting, or model every stabilizer crop. Room scanning and AR are contracts only. Google sign-in requires its own credentials and was not exercised in the local bypass mode.
