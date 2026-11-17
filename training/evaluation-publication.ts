import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Fixture } from "./fixtures";
import { loadEvaluationRuntime } from "./runtime";

export const legacyPublicationVersion = "recorded-evaluation-v1";
export const publicationVersion = "recorded-evaluation-v2";
export type PublicationVersion =
  | typeof legacyPublicationVersion
  | typeof publicationVersion;
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const Grade = z.object({
  schemaValidity: z.number().min(0).max(1),
  geometryValidity: z.number().min(0).max(1),
  familyMatch: z.boolean(),
  feasibilityOutcome: z.enum([
    "candidate",
    "bounded-search-abstention",
    "failure",
  ]),
  success: z.boolean(),
  invalidCandidateCount: z.number().int().nonnegative(),
  compileCount: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
});
export const Result = z.object({
  fixtureId: z.string().regex(/^(test|dev)-scene-\d+-[a-z-]+$/),
  arm: z.enum(["library", "baseline", "base", "candidate"]),
  available: z.boolean(),
  status: z.enum(["completed", "actor-failure", "service-unavailable"]),
  grade: Grade.nullable(),
  latencyMs: z.number().nonnegative(),
  usage: z
    .object({ inputTokens: z.number(), outputTokens: z.number() })
    .nullable(),
  traceId: z.string().optional(),
});
export type RecordedResult = z.infer<typeof Result>;
const Manifest = z.object({
  attempt: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  arm: Result.shape.arm,
  model: z.string().nullable(),
  inferenceBaseUrl: z.string().nullable().optional(),
  fixtureVersion: z.string(),
  fixtureSha256: z.string(),
  plannerVersion: z.literal("flowblock-planner-v1"),
  checkerVersion: z.string(),
  systemPromptSha256: z.string(),
  sourceHashes: z.record(z.string(), z.string()).optional(),
  fixtureIds: z.array(z.string()).min(1).max(72),
  settings: z.object({ trials: z.literal(1) }).passthrough(),
  startedAt: z.iso.datetime(),
  scope: z.string(),
});

export function publicationVersionFromReceipt(
  receipt: unknown,
): PublicationVersion {
  const parsed = z
    .object({
      status: z.string(),
      publicationVersion: z
        .enum([legacyPublicationVersion, publicationVersion])
        .optional(),
    })
    .parse(receipt);
  if (parsed.publicationVersion) return parsed.publicationVersion;
  if (parsed.status === "publishing") return legacyPublicationVersion;
  throw new Error("Publication receipt has no schema version.");
}

export function recordedScoreVerification(
  available: boolean,
  checkerMatches: boolean,
  version: PublicationVersion = publicationVersion,
) {
  if (!available && version !== legacyPublicationVersion)
    return "not-scored; service-unavailable";
  return checkerMatches
    ? "recomputed-with-frozen-checker"
    : "recorded-score; historical checker differs from preserved archive";
}

export function recordedModelName(
  manifest: Pick<
    z.infer<typeof Manifest>,
    "arm" | "model" | "inferenceBaseUrl" | "settings" | "systemPromptSha256"
  >,
  version: PublicationVersion = publicationVersion,
) {
  if (version === legacyPublicationVersion)
    return manifest.arm === "library"
      ? "deterministic-library-v1"
      : `flowblock-${manifest.arm}-v1`;
  const identity = hash(
    JSON.stringify({
      model: manifest.model,
      gateway: manifest.inferenceBaseUrl ?? null,
      settings: manifest.settings,
      promptSha256: manifest.systemPromptSha256,
    }),
  );
  return `flowblock-${manifest.arm}-v2-${identity}`;
}

export function recordedScores(row: RecordedResult) {
  if (row.available !== (row.grade !== null))
    throw new Error("Availability and recorded grade disagree.");
  if (row.available === (row.status === "service-unavailable"))
    throw new Error("Availability and service status disagree.");
  const scores: Record<string, boolean | number> = { available: row.available };
  if (row.grade) {
    scores.productive_plan =
      row.grade.success && row.grade.feasibilityOutcome === "candidate";
    scores.accepted_abstention =
      row.grade.success &&
      row.grade.feasibilityOutcome === "bounded-search-abstention";
    scores.schema_validity = row.grade.schemaValidity;
    scores.compile_actions = row.grade.compileCount;
    scores.rejected_compile_actions = row.grade.invalidCandidateCount;
  }
  return scores;
}

export function verifyRecordedPredictions(
  expected: {
    input: { fixture_id: string };
    output: unknown;
    scores: unknown;
  }[],
  calls: {
    inputs: Record<string, unknown>;
    output?: unknown;
    ended_at?: string | null;
    exception?: string | null;
  }[],
) {
  if (expected.length !== calls.length) return false;
  const seen = new Set<string>();
  for (const call of calls) {
    const id = (call.inputs.example as { fixture_id?: string } | undefined)
      ?.fixture_id;
    if (!id || seen.has(id) || !call.ended_at || call.exception) return false;
    seen.add(id);
    const row = expected.find((item) => item.input.fixture_id === id);
    if (
      !row ||
      !isDeepStrictEqual(call.inputs.example, row.input) ||
      !isDeepStrictEqual(call.output, {
        output: row.output,
        scores: row.scores,
      })
    )
      return false;
  }
  return true;
}

export function summarizeRecorded(rows: RecordedResult[], requested: number) {
  const available = rows.filter((row) => row.available);
  const productive = rows.filter(
    (row) => recordedScores(row).productive_plan,
  ).length;
  const abstentions = rows.filter(
    (row) => recordedScores(row).accepted_abstention,
  ).length;
  return {
    available: {
      true_count: available.length,
      true_fraction: rows.length ? available.length / rows.length : null,
    },
    productive_plan: {
      true_count: productive,
      true_fraction: available.length ? productive / available.length : null,
    },
    accepted_abstention: {
      true_count: abstentions,
      true_fraction: available.length ? abstentions / available.length : null,
    },
    coverage: {
      requested,
      attempted: rows.length,
      available: available.length,
      unavailable: rows.length - available.length,
      unattempted: requested - rows.length,
    },
    recorded_latency_ms: {
      mean: available.length
        ? available.reduce((sum, row) => sum + row.latencyMs, 0) /
          available.length
        : null,
    },
  };
}

/** Import recorded v1 predictions. No provider is called and no live engine is used. */
export async function loadRecordedEvaluation(
  directory: string,
  version: PublicationVersion = publicationVersion,
) {
  const manifestBytes = await readFile(
    resolve(directory, "manifest.json"),
    "utf8",
  );
  const manifest = Manifest.parse(JSON.parse(manifestBytes));
  const fixtureBytes = await readFile(
    resolve("training/frozen/fixtures.json"),
    "utf8",
  );
  if (hash(fixtureBytes) !== manifest.fixtureSha256)
    throw new Error("Recorded fixture hash does not match the frozen data.");
  const runtime = await loadEvaluationRuntime("frozen-v1");
  if (runtime.runtime.plannerVersion !== manifest.plannerVersion)
    throw new Error("Recorded runtime does not match the archive.");
  if (hash(runtime.runtime.systemPrompt) !== manifest.systemPromptSha256)
    throw new Error("Recorded prompt differs from the frozen runtime.");
  const fixtures = JSON.parse(fixtureBytes) as Fixture[];
  if (new Set(manifest.fixtureIds).size !== manifest.fixtureIds.length)
    throw new Error("Duplicate requested fixture IDs.");
  const selected = manifest.fixtureIds.map((id) => {
    const fixture = fixtures.find((item) => item.id === id);
    if (!fixture || fixture.split === "train")
      throw new Error(`Invalid evaluation fixture: ${id}`);
    return fixture;
  });
  const resultsBytes = await readFile(
    resolve(directory, "results.jsonl"),
    "utf8",
  );
  const rows = resultsBytes
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Result.parse(JSON.parse(line)));
  if (new Set(rows.map((row) => row.fixtureId)).size !== rows.length)
    throw new Error("Duplicate recorded task results.");
  const sourceHashes: Record<string, string> = {
    "manifest.json": hash(manifestBytes),
    "results.jsonl": hash(resultsBytes),
  };
  const predictions = [];
  for (const row of rows) {
    const fixture = selected.find((item) => item.id === row.fixtureId);
    if (!fixture || row.arm !== manifest.arm)
      throw new Error("Result is outside the declared attempt.");
    recordedScores(row);
    const rawBytes = await readFile(
      resolve(directory, `${row.fixtureId}.json`),
      "utf8",
    );
    sourceHashes[`${row.fixtureId}.json`] = hash(rawBytes);
    const raw = JSON.parse(rawBytes);
    if (
      !isDeepStrictEqual(Result.parse(raw.entry), row) ||
      raw.fixtureId !== row.fixtureId
    )
      throw new Error(
        `Recorded prediction and result disagree: ${row.fixtureId}`,
      );
    if (raw.result.inputHash !== hash(JSON.stringify(fixture.input)))
      throw new Error(
        `Recorded input differs from the frozen fixture: ${row.fixtureId}`,
      );
    if (
      row.available &&
      manifest.checkerVersion === runtime.checker.checkerVersion
    ) {
      const responses = raw.calls.flatMap(
        (call: { response?: { content: string } }) =>
          call.response ? [call.response.content] : [],
      );
      const recomputed = runtime.checker.gradeResult(
        fixture,
        raw.result,
        row.arm,
        responses,
      );
      if (!isDeepStrictEqual(Grade.parse(recomputed), row.grade))
        throw new Error(
          `Frozen checker disagrees with recorded score: ${row.fixtureId}`,
        );
    }
    predictions.push({
      input: {
        fixture_id: fixture.id,
        scene_group: fixture.sceneGroup,
        expected_family: fixture.expectedFamily,
        bounded_search_feasible: fixture.oracle.feasible,
        ...fixture.input,
      },
      output: {
        status: row.status,
        available: row.available,
        source: raw.result.source,
        // Exclude fallback plans from the model's prediction.
        candidates:
          raw.result.source === "forge" || row.arm === "library"
            ? raw.result.plans.map(
                (plan: {
                  id: string;
                  recipeId: string;
                  family: string;
                  validation: unknown;
                }) => ({
                  id: plan.id,
                  recipeId: plan.recipeId,
                  family: plan.family,
                  validation: plan.validation,
                }),
              )
            : [],
        original_conversation_id: row.traceId ?? null,
        recorded_latency_ms: row.latencyMs,
        provider_usage: row.usage,
        recorded_grade: row.grade,
        score_verification: recordedScoreVerification(
          row.available,
          manifest.checkerVersion === runtime.checker.checkerVersion,
          version,
        ),
      },
      scores: recordedScores(row),
    });
  }
  const publicationId = hash(
    JSON.stringify({ publicationVersion: version, sourceHashes }),
  );
  return {
    publicationId,
    publicationVersion: version,
    modelName: recordedModelName(manifest, version),
    manifest,
    sourceHashes,
    predictions,
    datasetRows: selected.map((fixture) => ({
      fixture_id: fixture.id,
      scene_group: fixture.sceneGroup,
      expected_family: fixture.expectedFamily,
      bounded_search_feasible: fixture.oracle.feasible,
      ...fixture.input,
    })),
    summary: summarizeRecorded(rows, selected.length),
  };
}
