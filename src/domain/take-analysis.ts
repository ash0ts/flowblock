import { z } from "zod";

const finite = z.number().finite();
const unit = finite.min(0).max(1);
const point = z.object({ x: unit, y: unit });
const box = z.object({ x: unit, y: unit, width: unit, height: unit });
export const TakeAnalysisSchema = z.object({
  schemaVersion: z.literal("1.0"),
  analysisSpace: z.literal("upright-normalized-image"),
  jobId: z.string(),
  takeId: z.string(),
  planId: z.string(),
  planVersion: z.string(),
  summary: z.string(),
  provenance: z.object({
    model: z.literal("SAM 2.1 Small"),
    repositoryCommit: z.string(),
    checkpointSha256: z.string(),
    device: z.enum(["cuda", "mps", "cpu"]),
    realInference: z.literal(true),
    rulesVersion: z.enum(["framing-v1", "framing-v1.1"]),
    generatedAt: z.string(),
    targetTimeBasis: z
      .enum(["absolute-seconds", "normalized-phase"])
      .optional(),
  }),
  video: z.object({
    durationSeconds: finite.positive(),
    sourceWidth: finite.positive(),
    sourceHeight: finite.positive(),
    rotationDegrees: finite,
    width: finite.positive(),
    height: finite.positive(),
    codec: z.string(),
    fps: z.literal(15),
    sampledFrames: z.number().int().nonnegative(),
    sourceStartPtsSeconds: finite,
    timestampMapping: z.literal("nearest-source-presentation-timestamp"),
    timeMap: z.array(
      z.object({
        frameIndex: z.number().int(),
        proxySeconds: finite,
        sourceSeconds: finite,
        sourcePtsSeconds: finite,
      }),
    ),
  }),
  tracks: z.array(
    z.object({
      frameIndex: z.number().int().nonnegative(),
      timestamp: finite.nonnegative(),
      proxyTimestamp: finite.nonnegative(),
      box: box.nullable(),
      center: point.nullable(),
      boundary: z.array(point),
      maskArea: unit,
      touchesBorder: z.boolean(),
      visibility: z.enum([
        "visible",
        "missing",
        "uncertain",
        "intentionally-hidden",
      ]),
      uncertaintyReasons: z.array(z.string()),
    }),
  ),
  coverage: z.object({
    expectedFrames: z.number().int().nonnegative(),
    measuredFrames: z.number().int().nonnegative(),
    missingFrames: z.number().int().nonnegative(),
    uncertainFrames: z.number().int().nonnegative(),
    intentionallyHiddenFrames: z.number().int().nonnegative(),
    measuredFraction: unit,
    needsReview: z.boolean(),
  }),
  findings: z
    .array(
      z.object({
        kind: z.enum(["framing", "size", "clipping", "duration"]),
        phase: z.string(),
        title: z.string(),
        detail: z.string(),
        evidenceTimestamps: z.array(finite.nonnegative()),
        affectedFrames: z.number().int().nonnegative(),
        measuredPhaseFrames: z.number().int().nonnegative(),
        suggestion: z.string(),
        measurement: z
          .object({
            metric: z.enum([
              "center-distance",
              "size-ratio",
              "border-contact-fraction",
              "duration-seconds",
            ]),
            observed: finite,
            target: finite,
            delta: finite,
            unit: z.enum([
              "normalized-image-distance",
              "relative-size",
              "fraction",
              "seconds",
            ]),
            timestamp: finite.nonnegative(),
          })
          .optional(),
        evidence: z
          .array(
            z.object({
              timestamp: finite.nonnegative(),
              objectKey: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .max(2),
  artifacts: z.object({
    proxyObjectKey: z.string(),
    timestampsObjectKey: z.string(),
    analysisObjectKey: z.string(),
  }),
  limitations: z.array(z.string()),
});

export type TakeAnalysis = z.infer<typeof TakeAnalysisSchema>;
