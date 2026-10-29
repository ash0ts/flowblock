# Local operations

## Processes and storage

The web app binds to `127.0.0.1:3037`. Docker Compose exposes PostgreSQL only at `127.0.0.1:54379`; its `flowblock-db` volume survives container restarts. The video worker exposes health and readiness on port 8091 and writes a database heartbeat. The browser’s connection panel uses that heartbeat, so a stopped worker is shown as unavailable.

`.env.local`, `.data`, downloaded checkpoints, vendor code, Python environments, and raw training artifacts are ignored by Git. Do not copy them into a public repository. `.env.example` lists the supported variables without credentials.

Use these read-only checks from the root:

```sh
curl http://127.0.0.1:3037/api/status
curl http://127.0.0.1:8091/readyz
bun run jobs
docker compose --env-file .env.local ps
```

## Identity and private media

`FLOWBLOCK_LOCAL_MODE=1` enables the `local-developer` account only for loopback request hosts. This mode is for one local user. It is not a shared deployment configuration. Writes require a matching origin; loopback scripts may omit Origin. Authenticated accounts use a hash of their provider identity for ownership and object prefixes.

Google sign-in is wired through Auth.js. A separate deployment needs `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, a stable `AUTH_SECRET`, its exact callback URI, and `FLOWBLOCK_LOCAL_MODE=0`. This repository does not create an OAuth client. Configure the callback as `/api/auth/callback/google` on the chosen application origin and verify it before allowing accounts.

Uploads have a 100 MiB application limit. The worker verifies decoded duration, dimensions, and format before inference. A local upload streams into a unique temporary file, then locks and rechecks the take before publication. Upload completion verifies the object size. Private media routes check ownership and allow only the original, proxy, or evidence keys from that take’s stored analysis. Local video responses support byte ranges for seeking.

Optional S3-compatible storage uses private signed requests and explicit upload completion. No object-created notification is assumed. Local operation needs no bucket, storage credentials, or CKS namespace.

## Jobs, retries, and outages

Planning executes within its bounded coordinator and stores a job result. Analysis jobs use PostgreSQL leases with `FOR UPDATE SKIP LOCKED`, a 90-second lease, 15-second renewals, and at most three attempts. Each artifact attempt has its own lease-token prefix. Lost leases cannot publish another attempt’s result.

Job states are `queued`, `running`, `needs_review`, `succeeded`, `failed`, and `cancelled`. Cancelled or deleted work cannot publish a successful result. Failed planning jobs preserve the source draft; retry them with a new idempotency key. Reusing an existing key with changed inputs returns 409. Concurrent identical requests consume quota once.

The allowances per account are 30 planning jobs, 20 uploads, 30 analysis jobs, and 30 revision proposals in a rolling 24-hour window. They are pilot limits, not a subscription system. Local recipe selection remains available when model quotas or connectivity prevent generation.

If inference fails, the UI identifies recipe-library fallback. If tracking is inadequate, the job returns partial evidence or needs review. If the worker is down, uploaded media remains available and can be analyzed after recovery. Check the worker readiness and log before resubmitting an expensive job.

## Retention and deletion

Uploaded media and derivatives expire after 30 days. The running web server sweeps expired and deleted takes at startup and every five minutes. Expired media is denied immediately by request and worker ownership checks even before the sweep removes its bytes. A stopped local application cannot run retention; it catches up on restart.

The creator’s Delete uploaded media action cancels jobs, removes originals and derivatives, clears analysis results and annotations, removes revision records containing copied evidence, and scrubs the file name and take’s plan copy. Opaque tombstones remain for retry cleanup if a process stopped during publication. Deletion can be retried. A storage failure on one take does not stop the sweep from attempting the others. Revision creation and acceptance lock the live source take, so deleting or expiring evidence prevents later acceptance. Saved project versions and local files the creator selected are separate from uploaded media.

Run cleanup manually when recovering a stopped app:

```sh
bun run cleanup
```

Training consent is recorded separately and defaults to false. This implementation’s training dataset is synthetic. No automatic path copies creator footage into Forge datasets, and model traces exclude raw media and signed URLs.

## Backup and rollback

Back up the PostgreSQL volume and `.data/media` together if local work matters. Do not commit either. A database backup without its media directory cannot restore take playback. Browser IndexedDB holds local drafts, shot versions, attempt metadata, and share-management state; export important plans before clearing browser storage.

To update, stop the web process, install the committed lockfile, run `bun run db:migrate`, build, and start again. The initial migration is additive and idempotent. Preserve the previous working checkout and database backup before changing schemas in future releases.

To roll back the application, stop the web process, check out the previous known-good commit, install its lockfile, build, and restart. Do not drop the database or delete its Docker volume. Model rollback is independent: unset `FLOWBLOCK_MODEL` or restore `openai/gpt-oss-20b`; the trained candidate is not selected by default.

## External validation still required

No CoreWeave infrastructure was provisioned. CUDA operation, Google OAuth, remote object storage, real mobile devices, physical clearance, human recipe review, and creator outcomes need their own verification before a wider pilot. The local setup provides executable interfaces and operating paths, not evidence that those environments have passed.
