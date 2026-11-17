import { describe, expect, it } from "vitest";
import {
  legacyPublicationVersion,
  publicationVersion,
  publicationVersionFromReceipt,
  recordedModelName,
  recordedScoreVerification,
  recordedScores,
  summarizeRecorded,
  verifyRecordedPredictions,
  type RecordedResult,
} from "../training/evaluation-publication";

const row = (overrides: Partial<RecordedResult> = {}): RecordedResult => ({
  fixtureId: "test-scene-00-hold",
  arm: "candidate",
  available: true,
  status: "completed",
  latencyMs: 1200,
  usage: null,
  grade: {
    schemaValidity: 1,
    geometryValidity: 1,
    familyMatch: false,
    feasibilityOutcome: "bounded-search-abstention",
    success: true,
    invalidCandidateCount: 0,
    compileCount: 0,
    toolCalls: 1,
  },
  ...overrides,
});

describe("recorded evaluation publication", () => {
  it("preserves v1 labels for readback and marks unavailable v2 rows unscored", () => {
    expect(
      recordedScoreVerification(false, true, legacyPublicationVersion),
    ).toBe("recomputed-with-frozen-checker");
    expect(recordedScoreVerification(false, true)).toBe(
      "not-scored; service-unavailable",
    );
    expect(recordedScoreVerification(false, false)).toBe(
      "not-scored; service-unavailable",
    );
    expect(recordedScoreVerification(true, true)).toBe(
      "recomputed-with-frozen-checker",
    );
    expect(recordedScoreVerification(true, false)).toContain(
      "historical checker differs",
    );
  });
  it("selects the receipt's version and recognizes only old publishing receipts as implicit v1", () => {
    expect(publicationVersionFromReceipt({ status: "publishing" })).toBe(
      legacyPublicationVersion,
    );
    expect(
      publicationVersionFromReceipt({
        status: "verified",
        publicationVersion: legacyPublicationVersion,
      }),
    ).toBe(legacyPublicationVersion);
    expect(
      publicationVersionFromReceipt({
        status: "publishing",
        publicationVersion,
      }),
    ).toBe(publicationVersion);
    expect(() => publicationVersionFromReceipt({ status: "verified" })).toThrow(
      /no schema version/,
    );
    expect(() =>
      publicationVersionFromReceipt({
        status: "verified",
        publicationVersion: "unknown",
      }),
    ).toThrow();
  });
  it("separates native model identities by actual checkpoint, gateway, settings, and prompt", () => {
    const manifest = {
      arm: "candidate" as const,
      model: "checkpoint:step1",
      inferenceBaseUrl: "https://gateway.example/v1",
      settings: { trials: 1 as const, temperature: 0.1 },
      systemPromptSha256: "prompt-v1",
    };
    const identity = recordedModelName(manifest);
    expect(recordedModelName({ ...manifest })).toBe(identity);
    expect(
      recordedModelName({ ...manifest, model: "checkpoint:step2" }),
    ).not.toBe(identity);
    expect(
      recordedModelName({
        ...manifest,
        inferenceBaseUrl: "https://other.example/v1",
      }),
    ).not.toBe(identity);
    expect(
      recordedModelName({
        ...manifest,
        settings: { trials: 1, temperature: 0.5 },
      }),
    ).not.toBe(identity);
    expect(
      recordedModelName({ ...manifest, systemPromptSha256: "prompt-v2" }),
    ).not.toBe(identity);
    expect(recordedModelName(manifest, legacyPublicationVersion)).toBe(
      "flowblock-candidate-v1",
    );
  });
  it("keeps accepted stops separate from useful plans and omits vacuous geometry credit", () => {
    expect(recordedScores(row())).toMatchObject({
      productive_plan: false,
      accepted_abstention: true,
    });
    expect(recordedScores(row())).not.toHaveProperty("geometry_validity");
  });
  it("never turns an unavailable provider request into a quality failure", () => {
    const unavailable = row({
      available: false,
      grade: null,
      status: "service-unavailable",
    });
    expect(recordedScores(unavailable)).toEqual({ available: false });
    const result = summarizeRecorded([row(), unavailable], 3);
    expect(result.coverage).toEqual({
      requested: 3,
      attempted: 2,
      available: 1,
      unavailable: 1,
      unattempted: 1,
    });
    expect(result.accepted_abstention).toEqual({
      true_count: 1,
      true_fraction: 1,
    });
  });
  it("does not fabricate zero quality when no request was available", () => {
    expect(summarizeRecorded([], 12).productive_plan.true_fraction).toBeNull();
  });
  it("rejects availability records inconsistent with the stored grade or service status", () => {
    expect(() => recordedScores(row({ available: false }))).toThrow(
      /Availability/,
    );
    expect(() =>
      recordedScores(row({ status: "service-unavailable" })),
    ).toThrow(/Availability/);
  });
  it("checks read-back scores, missing tasks, and duplicate rows rather than trusting a summary", () => {
    const expected = ["a", "b"].map((id) => ({
      input: { fixture_id: id, scene: { roomWidthMeters: 5 } },
      output: { status: "completed" },
      scores: { productive_plan: false, accepted_abstention: true },
    }));
    const calls = expected.map((item) => ({
      inputs: { example: item.input },
      output: { output: item.output, scores: item.scores },
      ended_at: "2026-10-29T00:00:00Z",
    }));
    expect(verifyRecordedPredictions(expected, calls)).toBe(true);
    const changedInput = structuredClone(calls);
    changedInput[0].inputs.example.scene.roomWidthMeters = 500;
    expect(verifyRecordedPredictions(expected, changedInput)).toBe(false);
    expect(verifyRecordedPredictions(expected, [calls[0], calls[0]])).toBe(
      false,
    );
    expect(verifyRecordedPredictions(expected, calls.slice(1))).toBe(false);
    const missingScore = structuredClone(calls);
    missingScore[0].output.scores.accepted_abstention = false;
    expect(verifyRecordedPredictions(expected, missingScore)).toBe(false);
    expect(
      verifyRecordedPredictions(
        expected,
        calls.map((call) => ({ ...call, exception: "flush failed" })),
      ),
    ).toBe(false);
  });
});
