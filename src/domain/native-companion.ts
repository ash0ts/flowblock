import { z } from 'zod';

/** Wire contracts only. This module does not perform capture, alignment or AR rendering. */
export const nativeCompanionSchemaVersion = 'flowblock-native-companion/1.0' as const;
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const NativePointSchema = z.object({ x: finite, y: finite, z: finite }).strict();
export const NativeTransformSchema = z.object({
  matrix: z.array(finite).length(16),
  order: z.literal('column-major'),
  convention: z.literal('planPoint = nativeToPlan * nativePoint'),
  scale: z.literal(1),
}).strict();
const CaptureObjectTransformSchema = z.object({
  matrix: z.array(finite).length(16), order: z.literal('column-major'),
  convention: z.literal('nativePoint = objectToNative * localPoint'),
}).strict();
export const TrackingStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('normal') }).strict(),
  z.object({ state: z.literal('limited'), reason: z.enum(['initializing', 'excessive-motion', 'insufficient-features', 'relocalizing', 'unknown']) }).strict(),
  z.object({ state: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]);
export const AlignmentSchema = z.object({
  state: z.enum(['unconfirmed', 'aligned', 'lost']),
  nativeToPlan: NativeTransformSchema,
  referencePoints: z.array(z.object({ id: z.string().min(1), native: NativePointSchema, plan: NativePointSchema }).strict()),
  horizontalUncertaintyMeters: nonnegative,
  verticalUncertaintyMeters: nonnegative,
  headingUncertaintyDegrees: nonnegative.max(180),
  confirmedAt: z.string().datetime().nullable(),
  confirmedBy: z.enum(['operator', 'unconfirmed']),
}).strict().refine(value => value.state !== 'aligned' || value.confirmedAt !== null && value.confirmedBy === 'operator' && value.referencePoints.length >= 2, 'Aligned imports require operator confirmation and at least two reference points.');
export const MeasurementProvenanceSchema = z.object({
  source: z.enum(['manual', 'roomplan', 'measured-device', 'assumed']),
  measuredAt: z.string().datetime().nullable(),
  captureId: z.string().nullable(),
  uncertaintyMeters: nonnegative,
  operatorVerified: z.boolean(),
  note: z.string(),
}).strict();
export const RoomCaptureImportSchema = z.object({
  schemaVersion: z.literal(nativeCompanionSchemaVersion),
  captureId: z.string().min(1), capturedAt: z.string().datetime(),
  source: z.object({ platform: z.literal('ios'), framework: z.literal('RoomPlan'), appVersion: z.string().min(1) }).strict(),
  coordinateFrame: z.object({ handedness: z.literal('right'), upAxis: z.literal('+y'), lengthUnit: z.literal('meter'), origin: z.literal('capture-session-origin') }).strict(),
  tracking: TrackingStateSchema,
  alignment: AlignmentSchema,
  floorBoundary: z.array(NativePointSchema).min(3),
  objects: z.array(z.object({
    id: z.string().min(1), label: z.string().min(1),
    role: z.enum(['obstacle', 'product-candidate', 'unclassified']),
    nativeTransform: CaptureObjectTransformSchema,
    dimensionsMeters: z.object({ width: finite.positive(), height: finite.positive(), depth: finite.positive() }).strict(),
    provenance: MeasurementProvenanceSchema,
  }).strict()),
  requiresOperatorReview: z.literal(true),
}).strict();
export const ARPathExportSchema = z.object({
  schemaVersion: z.literal(nativeCompanionSchemaVersion),
  planId: z.string().min(1), planSchemaVersion: z.literal('1.0'),
  exportedAt: z.string().datetime(),
  coordinateFrame: z.literal('flowblock-y-up-meters'),
  alignment: AlignmentSchema,
  tracking: TrackingStateSchema,
  modeledGeometryValid: z.boolean(),
  durationSeconds: finite.positive(),
  samples: z.array(z.object({
    timeSeconds: nonnegative, camera: NativePointSchema, target: NativePointSchema,
    operator: NativePointSchema, cameraEnvelopeRadius: nonnegative, operatorEnvelopeRadius: nonnegative,
  }).strict()).min(2),
  displayPolicy: z.object({
    hideWorldAnchoredPathWhenTrackingLimited: z.literal(true),
    hideWorldAnchoredPathWhenAlignmentLost: z.literal(true),
    hideWorldAnchoredPathWhenModeledGeometryInvalid: z.literal(true),
    requireOperatorReconfirmationAfterRelocalization: z.literal(true),
  }).strict(),
  limitations: z.array(z.string()).min(1),
}).strict();
export type RoomCaptureImport = z.infer<typeof RoomCaptureImportSchema>;
export type ARPathExport = z.infer<typeof ARPathExportSchema>;
export type MeasurementProvenance = z.infer<typeof MeasurementProvenanceSchema>;
export type NativeAlignment = z.infer<typeof AlignmentSchema>;

export const RecipeReviewMetadataSchema = z.object({
  recipeId: z.string().min(1),
  status: z.enum(['implementation-only', 'programmatic-tests-only', 'human-reviewed']),
  reviewer: z.string().min(1).nullable(), reviewedAt: z.string().datetime().nullable(),
  evidence: z.array(z.string()), scope: z.string().min(1),
}).strict().refine(value => value.status !== 'human-reviewed' || value.reviewer !== null && value.reviewedAt !== null, 'Human review requires an attributed reviewer and timestamp.');

export const RecordingCropMetadataSchema = z.object({
  activeSensorWidthMm: finite.positive(), activeSensorHeightMm: finite.positive(),
  recordingWidthPixels: z.number().int().positive(), recordingHeightPixels: z.number().int().positive(),
  stabilizationCropFactor: finite.min(1), anamorphicDesqueeze: finite.positive(),
  provenance: MeasurementProvenanceSchema,
}).strict();
