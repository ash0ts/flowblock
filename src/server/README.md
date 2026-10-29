# Application services

`api.ts` handles HTTP routing, request validation, ownership, and response shapes. `jobs.ts` reserves planning and analysis work with an idempotency lock and quota in one database transaction. `takes.ts` owns live-take lookup and the common deletion path used by the API and `maintenance.ts`.

The browser supplies authored scene, gear, and intent. Every server operation recompiles those inputs before trusting a path or validation result. Planning runs through `planner.ts`; evidence-based changes run through `revision-planner.ts`. Both coordinators share deadline and optional-telemetry handling in `coordinator-runtime.ts`. Tracing failures cannot discard a completed result.

Plan generation creates a running job and publishes its result with a conditional database update. Analysis uses the separately leased Python worker. Cancelling completed work reports its actual state. Project writes lock the project and compare the expected version before saving a new immutable snapshot and its current name.

Revisions cite a stored analysis owned by the requester. Before publication, the server locks its live source take. Acceptance takes the same lock before updating the revision. Deletion locks the take first, removes associated revision evidence, cancels and scrubs analysis jobs, and then removes media. This lock order prevents publication after deletion without holding a database transaction open during inference. Saved project versions are separate from uploaded take records.

`storage.ts` validates object keys, streams bounded uploads into unique partial files, and publishes under the take lock. Local playback supports range requests. Remote S3 support is an optional adapter and has not been verified against a deployed bucket.

See [operations](../../docs/operations.md) for quotas, retention, recovery, and local identity. [Generated API contracts](../../docs/openapi.json) describe the requests and responses. [The architecture guide](../../docs/architecture.md) explains the product boundaries and model roles.
