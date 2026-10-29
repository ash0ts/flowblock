import { z } from 'zod';

export const schemaVersion = '1.0' as const;
const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
export const PointSchema = z.object({ x: finite.min(-1000).max(1000), z: finite.min(-1000).max(1000) }).strict();
export const Vector3Schema = z.object({ x: finite.min(-1000).max(1000), y: finite.min(-1000).max(1000), z: finite.min(-1000).max(1000) }).strict();
export const FamilySchema = z.enum(['hold', 'push-in', 'pull-out', 'lateral', 'orbit', 'reveal']);
export const recipeIds = ['hero-hold', 'elevated-hold', 'gentle-push', 'detail-push', 'context-pull', 'wide-pull', 'left-slide', 'right-slide', 'quarter-orbit', 'reverse-orbit', 'left-reveal', 'right-reveal'] as const;
export const RecipeIdSchema = z.enum(recipeIds);
export const BoxSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().min(1).max(100),
  center: PointSchema, width: positive.max(100), depth: positive.max(100),
  height: positive.max(20), baseHeight: nonnegative.max(20), yawDeg: finite.min(-360).max(360),
}).strict();
export const SceneSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().min(1).max(100),
  boundary: z.array(PointSchema).min(3).max(200),
  subject: BoxSchema,
  obstacles: z.array(BoxSchema).max(100),
  lights: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), position: Vector3Schema, intensity: nonnegative.max(100) }).strict()).max(20),
  measurementUncertainty: nonnegative.max(2),
}).strict();
export const LensSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('physical'), focalLengthMm: positive.min(4).max(600), sensorWidthMm: positive.min(2).max(100), sensorHeightMm: positive.min(2).max(100) }).strict(),
  z.object({ kind: z.literal('equivalent'), focalLengthMm: positive.min(4).max(600) }).strict(),
]);
export const GearSchema = z.object({
  lens: LensSchema,
  aspectRatio: z.enum(['landscape', 'portrait', 'square']),
  stabilizer: z.enum(['handheld', 'gimbal', 'tripod', 'slider']),
  gimbalMode: z.enum(['follow', 'lock', 'pov']),
  cameraRadius: nonnegative.max(1), operatorRadius: nonnegative.max(1),
  operatorOffset: nonnegative.max(2), uncertaintyMargin: nonnegative.max(1),
  minHeight: nonnegative.max(4), maxHeight: positive.max(5), maxSpeed: positive.max(5),
}).strict().refine(g => g.maxHeight >= g.minHeight, { message: 'Maximum camera height must be at least minimum camera height', path: ['maxHeight'] });
export const CoverageBandSchema = z.tuple([finite.min(0.01).max(1), finite.min(0.01).max(1)]).refine(([min, max]) => min <= max, 'Coverage band must be ordered');
export const IntentSchema = z.object({
  brief: z.string().max(4000).default('A controlled product hero shot'),
  durationSeconds: positive.min(2).max(60),
  framing: z.enum(['wide', 'medium', 'close']),
  motion: z.enum(['subtle', 'balanced', 'dynamic']),
  cameraHeight: positive.min(0.1).max(5),
  framingTargets: z.object({ start: CoverageBandSchema, end: CoverageBandSchema }).strict().optional(),
}).strict();
export const OverridesSchema = z.object({
  distance: positive.min(0.1).max(30).optional(),
  travel: nonnegative.max(20).optional(),
  bearingDeg: finite.min(-360).max(360).optional(),
  orbitDegrees: finite.min(-180).max(180).optional(),
  height: positive.min(0.1).max(5).optional(),
  durationSeconds: positive.min(2).max(60).optional(),
  reverse: z.boolean().optional(),
}).strict();
export type Point = z.infer<typeof PointSchema>;
export type Vector3 = z.infer<typeof Vector3Schema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Box = z.infer<typeof BoxSchema>;
export type Gear = z.infer<typeof GearSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type Family = z.infer<typeof FamilySchema>;
export type RecipeId = z.infer<typeof RecipeIdSchema>;
export type Recipe = { id: RecipeId; family: Family; name: string; description: string; bearingDeg: number; travelFactor: number; orbitDegrees: number; heightOffset: number };
export type AnalyticPath = { kind: 'hold' | 'line' | 'arc'; start: Point; end: Point; center: Point; radius: number; startAngle: number; sweepAngle: number };
export type Violation = { code: string; severity: 'error' | 'warning'; message: string; obstacleId?: string; timeSeconds?: number };
export type ValidationReport = { valid: boolean; violations: Violation[]; minClearance: number; approximationError: number; checkedSegments: number; model: string };
export type FramingBox = { centerX: number; centerY: number; width: number; height: number };
export type PlanSample = { t: number; timeSeconds: number; position: Vector3; operator: Point; target: Vector3; yawDeg: number; pitchDeg: number; distance: number; coverage: number; framingBox: FramingBox; projectionValid: boolean; progress: number };
export type PlanVersion = {
  schemaVersion: typeof schemaVersion; id: string; recipeId: RecipeId; family: Family; name: string;
  scene: Scene; gear: Gear; intent: Intent; overrides: Overrides; path: AnalyticPath;
  durationSeconds: number; arcLength: number; cameraHeight: number;
  validation: ValidationReport; framing: { startCoverage: number; endCoverage: number; target: [number, number]; temporalStart: [number, number]; temporalEnd: [number, number] };
  keyframes: PlanSample[]; score: number;
};
export type Plan = PlanVersion;
export const AnalyticPathSchema = z.object({
  kind: z.enum(['hold', 'line', 'arc']), start: PointSchema, end: PointSchema, center: PointSchema,
  radius: nonnegative, startAngle: finite, sweepAngle: finite,
}).strict();
export const ViolationSchema = z.object({
  code: z.string(), severity: z.enum(['error', 'warning']), message: z.string(),
  obstacleId: z.string().optional(), timeSeconds: nonnegative.optional(),
}).strict();
export const ValidationReportSchema = z.object({
  valid: z.boolean(), violations: z.array(ViolationSchema), minClearance: finite,
  approximationError: nonnegative.max(0.01), checkedSegments: z.number().int().nonnegative(), model: z.string(),
}).strict();
export const FramingBoxSchema = z.object({ centerX: finite, centerY: finite, width: nonnegative, height: nonnegative }).strict();
export const PlanSampleSchema = z.object({
  t: finite.min(0).max(1), timeSeconds: nonnegative, position: Vector3Schema, operator: PointSchema,
  target: Vector3Schema, yawDeg: finite, pitchDeg: finite, distance: nonnegative, coverage: nonnegative,
  framingBox: FramingBoxSchema, projectionValid: z.boolean(), progress: finite.min(0).max(1),
}).strict();
export const PlanVersionSchema = z.object({
  schemaVersion: z.literal(schemaVersion), id: z.string().min(1), recipeId: RecipeIdSchema, family: FamilySchema, name: z.string(),
  scene: SceneSchema, gear: GearSchema, intent: IntentSchema, overrides: OverridesSchema, path: AnalyticPathSchema,
  durationSeconds: positive, arcLength: nonnegative, cameraHeight: positive,
  validation: ValidationReportSchema,
  framing: z.object({ startCoverage: nonnegative, endCoverage: nonnegative, target: CoverageBandSchema, temporalStart: CoverageBandSchema, temporalEnd: CoverageBandSchema }).strict(),
  keyframes: z.array(PlanSampleSchema).min(1), score: finite,
}).strict();
export const AgentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list_recipes') }).strict(),
  z.object({ action: z.literal('compile_candidate'), recipeId: RecipeIdSchema, overrides: OverridesSchema.optional() }).strict(),
  z.object({ action: z.literal('validate_candidate'), candidateId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('read_take_findings') }).strict(),
  z.object({ action: z.literal('propose_revision'), overrides: OverridesSchema, reason: z.string().min(1), findingIds: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ action: z.literal('finish'), candidateIds: z.array(z.string()).max(12), explanation: z.string().min(1) }).strict(),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
export const AgentResponseSchema = z.object({
  schemaVersion: z.literal(schemaVersion), message: z.string().min(1).max(4000),
  actions: z.array(AgentActionSchema).max(12),
}).strict();
