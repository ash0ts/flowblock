# Local verification

Recorded on 2026-10-29. These are implementation checks and synthetic demonstrations. The proposed creator-study and held-out video-accuracy thresholds have not been measured.

## Initial build checks (`22ad314`)

| Check | Observed result |
| --- | --- |
| TypeScript/domain/API suite | 253 tests passed, including actual PostgreSQL transactions in isolated schemas |
| Python worker suite | 49 tests passed, including FFmpeg decoding and PostgreSQL lease/publication races |
| Chromium production suite | 9 tests passed, including offline service-worker reload, persistence, unavailable analysis, empty generation, revision UI state, sharing controls, and conflict reconciliation |
| Static verification | TypeScript and ESLint passed |
| Production compilation | Standalone Next.js build passed; bundle check excluded local environment files, media, weights, and training artifacts |
| Isolated CPU application image | Docker build passed; `/`, `/sample`, `/developer`, and `/api/status` returned 200 without access to the development checkout |
| Live local services | Web app, PostgreSQL, private file storage, and MPS worker reported available |

The browser checks use desktop Chromium and a narrow portrait viewport. They are not tests on physical iPhone or Android devices. Several UI error/recovery cases intercept API responses; the separate HTTP smoke below exercises the real services.

## Code review checks

The review passed 278 TypeScript/domain/API tests and 61 Python worker tests, including actual PostgreSQL races and FFmpeg decoding. It added coverage for projection bounds, deadline and telemetry failures, revision provenance, deletion races, source timestamps, uncertain masks, decoded duration, persistence, and stale editor responses. All 20 production Chromium checks passed, including offline reload, cache isolation, delayed IndexedDB commits, retained storage failures, editable generated parameters, and take-operation races. The final desktop and mobile viewport checks played and sought a real local SAM analysis proxy, loaded its timestamped JPEG, and reported no JavaScript errors or horizontal overflow. The ignored local browser receipt is `.data/reviewed-ui-evidence.json`. Formatting, TypeScript, ESLint, and the standalone production build passed. The initial build counts above remain the historical baseline.

Linux CI exposed a playback crash when the first animation-frame timestamp preceded the effect’s `performance.now()` sample. The controlled timestamp regression reproduced the error before the fix. Playback now initializes elapsed time from its first animation frame and uses that clock throughout. The original native-click playback test remains. CI preserves failure screenshots and traces for seven days.

The CSS cleanup removed 163 superseded declarations. Desktop (1440×1000) and mobile (390×1608) renders and computed styles matched before and after that cleanup. The ignored local receipt is `.data/css-visual-comparison.json`.

[The review receipt](verification-review.json) records a fresh local run of the real SAM checkpoint on the same synthetic clip, using engine v1.1 and framing rules v1.1. All 75 sampled frames yielded usable measurements; the five-second clip produced a duration finding against an eight-second plan. A manually specified five-second revision passed validation and acceptance. Playback returned HTTP 206 for a range request. This review smoke did not call an external language model or run training, and it does not establish accuracy on creator footage.

The original evaluation runtime, domain engine, fixture generator, and checker now execute from a separate hash-verified source archive. A regression makes live modules unavailable and verifies that historical compilation, grading, and fixture generation still work. The original 238 dataset examples were reproduced byte for byte. Historical result receipts remain unchanged.

## Plan, take, revision, second take

[The API receipt](verification-api.json) records the actual local HTTP sequence. The labeled synthetic bottle clip has 75 sampled frames over five seconds. The worker ran the pinned SAM 2.1 Small checkpoint using MPS and measured all 75 frames. The first plan specified eight seconds, so analysis surfaced a duration mismatch with a timestamped JPEG and measured difference.

The Forge coordinator read that finding and proposed one change: planned duration from eight seconds to five. The API recompiled the shot, required explicit acceptance, and preserved the original plan. The same synthetic video was then uploaded against the revised plan. The second real inference run again measured 75 frames and produced no findings.

This is a synthetic replay with corrected plan timing. It does not show that a person filmed better footage. The receipt also records an evidence JPEG response of 200, a 1,024-byte video range response of 206, a revoked plan link returning 404, and a stale project write returning 409.

Private take identifiers and media keys remain in `.data/smoke-loop.json`; the committed receipt omits them. The fixture is generated by `worker/tests/generate_synthetic.py`. `scripts/smoke-media.ts` and `scripts/smoke-loop.ts` reproduce the local sequence against a configured running worker and Forge endpoint.

## Training and traces

[The training record](../training/results/README.md) includes a real completed SFT job, a positive checkpoint readback, four evaluation arms, and an independently read-back Weave conversation. The candidate was not promoted. It produced no useful matching plans in the qualification; its aggregate gains were abstentions.

The qualification used 12 tasks from two held-out synthetic scene groups, with one occurrence per task and arm. The 72-task full campaign was not executed. The exact evaluated v1 runtime is frozen. The current product uses engine v1.1, planner v1.2, and revision coordinator v1.1. These later changes are not presented as part of the matched training effect.

## Open acceptance work

- Attributed cinematography review of the twelve recipes and equipment instructions.
- Creator-recorded clips, including reflective, transparent, textureless, partially hidden, and intentionally cropped products.
- The proposed 30-clip/10-product tracking benchmark, framing-event precision and recall, abstention rates, and usable coverage.
- Physical iPhone and Android capture/upload flows, touch and assistive-technology checks on real devices.
- The counterbalanced creator study, blind usable-take review, repeat-use observations, and time-to-usable-take measurements.
- CUDA worker validation, Google OAuth, remote private object storage, and any shared deployment configuration.
- Measured service latency, GPU memory, queue delay, and billed per-job cost on a chosen deployment.

Native room scanning and AR remain interface contracts. Per-object measurement provenance, calibrated stabilization crops, foreground occlusion planning, and gimbal dynamics are not implemented by the current compiler. These limitations are documented beside the [domain model](../src/domain/README.md).
