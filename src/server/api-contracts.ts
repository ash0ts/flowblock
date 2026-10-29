import { z } from "zod";
const normalizedBox = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (b) => b.x + b.width <= 1.000001 && b.y + b.height <= 1.000001,
    "Box must fit inside the image",
  );
const annotation = z
  .object({ timeSeconds: z.number().min(0).max(15), box: normalizedBox })
  .strict();
const target = z
  .object({
    centerX: z.number().min(0).max(1),
    centerY: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict();
export const AnalyzeSchema = z
  .object({
    targetTimeBasis: z
      .enum(["absolute-seconds", "normalized-phase"])
      .optional(),
    seed: annotation,
    corrections: z.array(annotation).max(10).default([]),
    expectedVisible: z
      .object({
        startSeconds: z.number().min(0).max(15),
        endSeconds: z.number().positive().max(15),
      })
      .refine((t) => t.endSeconds > t.startSeconds),
    target: z.object({ start: target, end: target }).optional(),
    targetKeyframes: z
      .array(target.extend({ timeSeconds: z.number().min(0).max(60) }))
      .min(2)
      .max(200)
      .optional(),
  })
  .strict();
export const UploadSchema = z
  .object({
    fileName: z.string().min(1).max(240),
    contentType: z.enum([
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-m4v",
    ]),
    sizeBytes: z.number().int().positive().max(104857600),
    plan: z.unknown(),
    trainingConsent: z.boolean().default(false),
  })
  .strict();
export const ProjectSchema = z
  .object({
    name: z.string().min(1).max(100),
    plan: z.unknown(),
    projectId: z.string().uuid().optional(),
    expectedVersionId: z.string().uuid().nullable().optional(),
  })
  .strict();
