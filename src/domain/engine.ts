import {
  GearSchema, IntentSchema, OverridesSchema, RecipeIdSchema, SceneSchema, schemaVersion,
  type AnalyticPath, type FramingBox, type Gear, type Intent, type Overrides,
  type PlanSample, type PlanVersion, type Point, type RecipeId, type Scene, type ValidationReport, type Violation,
} from './contracts';
import { framingBands, recipes } from './defaults';
import { boxCorners, degrees, distance, lerp, lerpPoint, pointInPolygon, pointSegmentDistance, polygonProblems, radians, segmentBoundaryDistance, segmentPolygonDistance } from './geometry';

export const MAX_APPROXIMATION_ERROR = 0.005;
const MODEL = 'Conservative 2D swept camera and operator footprints, inflated by measurement and handling uncertainty. Obstacles occupy their full floor footprint at every height. Lighting and unmeasured objects are not validated.';
const EPS = 1e-9;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(child => { if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child); });
  }
  return value;
}
function hash(value: unknown): string {
  const text = JSON.stringify(value);
  const seeds = [2166136261, 2246822507, 3266489909, 668265263];
  return seeds.map(seed => {
    let h = seed;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); h ^= h >>> 13; }
    return (h >>> 0).toString(16).padStart(8, '0');
  }).join('');
}
export function deriveFov(rawGear: Gear) {
  const gear = GearSchema.parse(rawGear);
  const { lens, aspectRatio } = gear;
  const nativeWidth = lens.kind === 'physical' ? lens.sensorWidthMm : 36;
  const nativeHeight = lens.kind === 'physical' ? lens.sensorHeightMm : 24;
  const long = Math.max(nativeWidth, nativeHeight), short = Math.min(nativeWidth, nativeHeight);
  const sourceWidth = aspectRatio === 'portrait' ? short : long;
  const sourceHeight = aspectRatio === 'portrait' ? long : short;
  const ratio = aspectRatio === 'portrait' ? 9 / 16 : aspectRatio === 'square' ? 1 : 16 / 9;
  const sensorWidth = Math.min(sourceWidth, sourceHeight * ratio);
  const sensorHeight = Math.min(sourceHeight, sourceWidth / ratio);
  const horizontalRad = 2 * Math.atan(sensorWidth / (2 * lens.focalLengthMm));
  const verticalRad = 2 * Math.atan(sensorHeight / (2 * lens.focalLengthMm));
  return { horizontalRad, verticalRad, horizontalDeg: degrees(horizontalRad), verticalDeg: degrees(verticalRad), sensorWidthMm: sensorWidth, sensorHeightMm: sensorHeight };
}
function pointOnPath(path: AnalyticPath, t: number): Point {
  if (path.kind !== 'arc') return lerpPoint(path.start, path.end, t);
  const angle = path.startAngle + path.sweepAngle * t;
  return { x: path.center.x + path.radius * Math.sin(angle), z: path.center.z + path.radius * Math.cos(angle) };
}
function operatorAt(camera: Point, center: Point, offset: number): Point {
  const radialDistance = distance(camera, center);
  // A coincident camera has no horizontal view direction. Validation rejects it;
  // this explicit orientation keeps invalid candidate previews serializable.
  if (radialDistance < EPS) return { x: camera.x, z: camera.z + offset };
  return { x: camera.x + offset * (camera.x - center.x) / radialDistance, z: camera.z + offset * (camera.z - center.z) / radialDistance };
}
function projectSubject(scene: Scene, gear: Gear, camera: Point, height: number): { box: FramingBox; coverage: number; valid: boolean } {
  const center = scene.subject.center;
  const targetHeight = scene.subject.baseHeight + scene.subject.height / 2;
  const dx = center.x - camera.x, dy = targetHeight - height, dz = center.z - camera.z;
  const total = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dz);
  const fallback: FramingBox = { centerX: 0.5, centerY: 0.5, width: 0, height: 0 };
  if (total < EPS || horizontal < EPS) return { box: fallback, coverage: 0, valid: false };
  const forward = { x: dx / total, y: dy / total, z: dz / total };
  const right = { x: -forward.z * total / horizontal, z: forward.x * total / horizontal };
  const up = { x: -right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y };
  const fov = deriveFov(gear), tx = Math.tan(fov.horizontalRad / 2), ty = Math.tan(fov.verticalRad / 2);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of boxCorners(scene.subject)) for (const y of [scene.subject.baseHeight, scene.subject.baseHeight + scene.subject.height]) {
    const v = { x: p.x - camera.x, y: y - height, z: p.z - camera.z };
    const depth = v.x * forward.x + v.y * forward.y + v.z * forward.z;
    if (depth <= EPS) return { box: fallback, coverage: 0, valid: false };
    const px = 0.5 + (v.x * right.x + v.z * right.z) / (2 * depth * tx);
    const py = 0.5 - (v.x * up.x + v.y * up.y + v.z * up.z) / (2 * depth * ty);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const box = { centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
  return { box, coverage: Math.max(box.width, box.height), valid: true };
}
function solveDistance(scene: Scene, gear: Gear, height: number, bearing: number, target: number): number {
  const at = (radius: number) => projectSubject(scene, gear, { x: scene.subject.center.x + Math.sin(bearing) * radius, z: scene.subject.center.z + Math.cos(bearing) * radius }, height);
  let previous = 0.1, previousProjection = at(previous), best = previous, bestError = Infinity;
  for (let i = 1; i <= 200; i++) {
    const current = 0.1 * Math.pow(300, i / 200), projection = at(current);
    if (projection.valid && Math.abs(projection.coverage - target) < bestError) { best = current; bestError = Math.abs(projection.coverage - target); }
    if (previousProjection.valid && projection.valid && previousProjection.coverage >= target && projection.coverage <= target) {
      let lo = previous, hi = current;
      for (let j = 0; j < 40; j++) { const mid = (lo + hi) / 2; if (at(mid).coverage > target) lo = mid; else hi = mid; }
      return (lo + hi) / 2;
    }
    previous = current; previousProjection = projection;
  }
  return best;
}
function sampleUnchecked(plan: Pick<PlanVersion, 'path' | 'scene' | 'gear' | 'cameraHeight' | 'durationSeconds'>, t: number): PlanSample {
  const p = pointOnPath(plan.path, t), center = plan.scene.subject.center;
  const target = { x: center.x, y: plan.scene.subject.baseHeight + plan.scene.subject.height / 2, z: center.z };
  const horizontal = distance(p, center), projected = projectSubject(plan.scene, plan.gear, p, plan.cameraHeight);
  return {
    t, timeSeconds: t * plan.durationSeconds, position: { x: p.x, y: plan.cameraHeight, z: p.z },
    operator: operatorAt(p, center, plan.gear.operatorOffset), target,
    yawDeg: degrees(Math.atan2(center.x - p.x, center.z - p.z)),
    pitchDeg: degrees(Math.atan2(target.y - plan.cameraHeight, horizontal)),
    distance: Math.hypot(horizontal, target.y - plan.cameraHeight),
    coverage: projected.coverage, framingBox: projected.box, projectionValid: projected.valid, progress: t,
  };
}
export function samplePlan(plan: PlanVersion, t: number): PlanSample {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('Playback progress must be a finite number from 0 to 1.');
  return sampleUnchecked(plan, t);
}
export function targetAtTime(plan: PlanVersion, timeSeconds: number) {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > plan.durationSeconds) throw new RangeError('Target time must lie within the plan duration.');
  const t = timeSeconds / plan.durationSeconds;
  return { ...samplePlan(plan, t).framingBox, coverageBand: [lerp(plan.framing.temporalStart[0], plan.framing.temporalEnd[0], t), lerp(plan.framing.temporalStart[1], plan.framing.temporalEnd[1], t)] as [number, number] };
}
export function validateScene(rawScene: Scene): Violation[] {
  const scene = SceneSchema.parse(rawScene);
  const violations: Violation[] = polygonProblems(scene.boundary).map(message => ({ code: 'invalid_boundary', severity: 'error', message }));
  const ids = [scene.subject.id, ...scene.obstacles.map(obstacle => obstacle.id)];
  if (new Set(ids).size !== ids.length) violations.push({ code: 'duplicate_object_id', severity: 'error', message: 'The product and obstacle IDs must be unique.' });
  const corners = boxCorners(scene.subject);
  if (!corners.every((p, i) => pointInPolygon(p, scene.boundary) && segmentBoundaryDistance(p, corners[(i + 1) % corners.length], scene.boundary) > EPS)) violations.push({ code: 'subject_outside_boundary', severity: 'error', message: 'The complete product footprint must lie strictly inside the measured boundary.' });
  return violations;
}
function validateGeometry(plan: PlanVersion): ValidationReport {
  const { path, scene, gear } = plan;
  const violations = validateScene(scene);
  const seen = new Set(violations.map(v => v.code));
  const add = (violation: Violation) => { const key = `${violation.code}:${violation.obstacleId ?? ''}`; if (!seen.has(key)) { seen.add(key); violations.push(violation); } };
  const minRadius = path.kind === 'arc' ? path.radius : pointSegmentDistance(path.center, path.start, path.end);
  let cameraM2 = 0, operatorM2 = 0;
  if (path.kind === 'arc') {
    cameraM2 = path.radius * path.sweepAngle ** 2;
    operatorM2 = (path.radius + gear.operatorOffset) * path.sweepAngle ** 2;
  } else if (minRadius > EPS) {
    // For p(t)=a+t(b-a), ||d²(p/||p||)/dt²|| <= 6||b-a||²/r_min².
    // Linear interpolation deviates by at most max||f''||/(8 n²).
    operatorM2 = 6 * gear.operatorOffset * plan.arcLength ** 2 / minRadius ** 2;
  } else {
    add({ code: 'undefined_view_direction', severity: 'error', message: 'The path crosses the product center, where horizontal camera and operator orientation are undefined.' });
  }
  const n = Math.max(1, Math.ceil(Math.sqrt(Math.max(cameraM2, operatorM2) / (8 * MAX_APPROXIMATION_ERROR))));
  // Input limits bound normal paths. Reject pathological near-singular paths
  // explicitly instead of silently reducing the promised envelope precision.
  if (n > 10000) return { valid: false, violations: [...violations, { code: 'geometry_resolution', severity: 'error', message: 'This path is too close to the product center to validate at the required precision.' }], minClearance: 0, approximationError: MAX_APPROXIMATION_ERROR, checkedSegments: 0, model: MODEL };
  const cameraError = cameraM2 / (8 * n * n), operatorError = operatorM2 / (8 * n * n);
  const uncertainty = scene.measurementUncertainty + gear.uncertaintyMargin;
  let minClearance = Infinity;
  const obstacles = [scene.subject, ...scene.obstacles].map(box => ({ box, polygon: boxCorners(box) }));
  for (let i = 0; i < n; i++) {
    const a = pointOnPath(path, i / n), b = pointOnPath(path, (i + 1) / n);
    const envelopes = [
      { name: 'camera', a, b, radius: gear.cameraRadius + uncertainty + cameraError },
      { name: 'operator', a: operatorAt(a, path.center, gear.operatorOffset), b: operatorAt(b, path.center, gear.operatorOffset), radius: gear.operatorRadius + uncertainty + operatorError },
    ];
    for (const envelope of envelopes) {
      const boundaryClearance = segmentBoundaryDistance(envelope.a, envelope.b, scene.boundary) - envelope.radius;
      const inside = pointInPolygon(envelope.a, scene.boundary) && pointInPolygon(envelope.b, scene.boundary);
      minClearance = Math.min(minClearance, inside ? boundaryClearance : -Math.abs(boundaryClearance));
      if (!inside || boundaryClearance <= EPS) add({ code: `${envelope.name}_boundary`, severity: 'error', message: `The swept ${envelope.name} envelope touches or crosses the measured boundary.`, timeSeconds: i / n * plan.durationSeconds });
      for (const obstacle of obstacles) {
        const clearance = segmentPolygonDistance(envelope.a, envelope.b, obstacle.polygon) - envelope.radius;
        minClearance = Math.min(minClearance, clearance);
        if (clearance <= EPS) add({ code: `${envelope.name}_obstacle`, severity: 'error', message: `The swept ${envelope.name} envelope touches or intersects ${obstacle.box.name}.`, obstacleId: obstacle.box.id, timeSeconds: i / n * plan.durationSeconds });
      }
    }
  }
  if (plan.cameraHeight < gear.minHeight || plan.cameraHeight > gear.maxHeight) add({ code: 'camera_height', severity: 'error', message: 'Camera height is outside the configured gear range.' });
  if (plan.arcLength / plan.durationSeconds > gear.maxSpeed + EPS) add({ code: 'camera_speed', severity: 'error', message: 'The path exceeds the configured maximum camera speed.' });
  if (gear.stabilizer === 'tripod' && path.kind !== 'hold') add({ code: 'tripod_translation', severity: 'error', message: 'A fixed tripod cannot execute this translating path.' });
  if (gear.stabilizer === 'slider' && path.kind === 'arc') add({ code: 'slider_arc', severity: 'error', message: 'This recipe requires a curved route; the generic slider model supports straight travel.' });
  if (gear.gimbalMode === 'lock' && (plan.family === 'lateral' || plan.family === 'orbit' || plan.family === 'reveal')) add({ code: 'gimbal_lock', severity: 'warning', message: 'The path turns the camera toward the product. A locked gimbal requires manual aiming or a different mode.' });
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, sample = sampleUnchecked(plan, t);
    const band = targetAtTime(plan, t * plan.durationSeconds).coverageBand;
    if (!sample.projectionValid) add({ code: 'invalid_projection', severity: 'error', message: 'The complete product cannot be projected in front of the camera.', timeSeconds: sample.timeSeconds });
    else if (sample.coverage < band[0] - 0.005 || sample.coverage > band[1] + 0.005) add({ code: 'framing_band', severity: 'error', message: 'Projected product coverage leaves the requested temporal framing band.', timeSeconds: sample.timeSeconds });
  }
  if (plan.family === 'reveal') add({ code: 'reveal_visibility', severity: 'warning', message: 'This is an angled slide into the hero view. Foreground reveal timing requires a measured occluder and a separate visibility check.' });
  if ((plan.family === 'hold' || plan.family === 'orbit') && plan.overrides.travel !== undefined) add({ code: 'unused_travel', severity: 'error', message: 'This recipe does not accept a travel override. Use distance or orbit angle.' });
  if (plan.family !== 'orbit' && plan.overrides.orbitDegrees !== undefined) add({ code: 'unused_orbit', severity: 'error', message: 'Only an orbit recipe accepts an orbit-angle override.' });
  return { valid: !violations.some(v => v.severity === 'error'), violations, minClearance, approximationError: Math.max(cameraError, operatorError), checkedSegments: n, model: MODEL };
}
export function compilePlan(rawScene: Scene, rawGear: Gear, rawIntent: Intent, rawRecipeId: RecipeId, rawOverrides: Overrides = {}): PlanVersion {
  const scene = SceneSchema.parse(rawScene), gear = GearSchema.parse(rawGear), intent = IntentSchema.parse(rawIntent);
  const recipeId = RecipeIdSchema.parse(rawRecipeId), overrides = OverridesSchema.parse(rawOverrides);
  const recipe = recipes.find(r => r.id === recipeId)!;
  const center = { ...scene.subject.center }, bearing = radians(overrides.bearingDeg ?? recipe.bearingDeg);
  const height = overrides.height ?? intent.cameraHeight + recipe.heightOffset;
  const band = framingBands[intent.framing], temporalStart = intent.framingTargets?.start ?? band, temporalEnd = intent.framingTargets?.end ?? band;
  const desiredCoverage = (temporalStart[0] + temporalStart[1] + temporalEnd[0] + temporalEnd[1]) / 4;
  const radius = overrides.distance ?? solveDistance(scene, gear, height, bearing, desiredCoverage);
  const radial = (r: number): Point => ({ x: center.x + Math.sin(bearing) * r, z: center.z + Math.cos(bearing) * r });
  const movementScale = intent.motion === 'subtle' ? 0.65 : intent.motion === 'dynamic' ? 1.4 : 1;
  const travel = overrides.travel ?? Math.abs(recipe.travelFactor) * radius * movementScale;
  let path: AnalyticPath = { kind: 'hold', start: radial(radius), end: radial(radius), center, radius, startAngle: bearing, sweepAngle: 0 };
  if (recipe.family === 'push-in' || recipe.family === 'pull-out') {
    const direction = recipe.family === 'push-in' ? 1 : -1;
    path = { ...path, kind: 'line', start: radial(radius + direction * travel / 2), end: radial(radius - direction * travel / 2) };
  } else if (recipe.family === 'lateral' || recipe.family === 'reveal') {
    const sign = Math.sign(recipe.travelFactor), base = radial(radius);
    const tangent = (amount: number): Point => ({ x: base.x + Math.cos(bearing) * amount, z: base.z - Math.sin(bearing) * amount });
    path = { ...path, kind: 'line', start: tangent(sign * travel * (recipe.family === 'reveal' ? 1 : 0.5)), end: tangent(recipe.family === 'reveal' ? 0 : -sign * travel / 2) };
  } else if (recipe.family === 'orbit') {
    const sweepAngle = radians(overrides.orbitDegrees ?? recipe.orbitDegrees * movementScale);
    path = { ...path, kind: 'arc', startAngle: bearing - sweepAngle / 2, sweepAngle };
    path.start = pointOnPath(path, 0); path.end = pointOnPath(path, 1);
  }
  if (overrides.reverse) path = { ...path, start: path.end, end: path.start, startAngle: path.startAngle + path.sweepAngle, sweepAngle: -path.sweepAngle };
  const arcLength = path.kind === 'arc' ? Math.abs(path.radius * path.sweepAngle) : distance(path.start, path.end);
  const plan: PlanVersion = {
    schemaVersion, id: `plan-${hash({ schemaVersion, scene, gear, intent, recipeId, overrides })}`,
    recipeId, family: recipe.family, name: recipe.name, scene, gear, intent, overrides, path,
    durationSeconds: overrides.durationSeconds ?? intent.durationSeconds, arcLength, cameraHeight: height,
    validation: { valid: false, violations: [], minClearance: 0, approximationError: 0, checkedSegments: 0, model: MODEL },
    framing: { startCoverage: 0, endCoverage: 0, target: [...band], temporalStart: [...temporalStart], temporalEnd: [...temporalEnd] }, keyframes: [], score: 0,
  };
  plan.keyframes = Array.from({ length: 41 }, (_, i) => sampleUnchecked(plan, i / 40));
  plan.framing.startCoverage = plan.keyframes[0].coverage; plan.framing.endCoverage = plan.keyframes[40].coverage;
  plan.validation = validateGeometry(plan);
  const errors = plan.validation.violations.filter(v => v.severity === 'error').length;
  plan.score = Math.round((100 - errors * 30 - plan.validation.violations.length * 2 - Math.abs(plan.framing.startCoverage - desiredCoverage) * 20) * 100) / 100;
  return deepFreeze(plan);
}
export function validatePlan(plan: PlanVersion): ValidationReport {
  // Recompile from the source snapshot: persisted paths or reports are never trusted.
  return compilePlan(plan.scene, plan.gear, plan.intent, plan.recipeId, plan.overrides).validation;
}
export function planShots(scene: Scene, gear: Gear, intent: Intent): PlanVersion[] {
  return recipes.map(recipe => compilePlan(scene, gear, intent, recipe.id)).sort((a, b) => Number(b.validation.valid) - Number(a.validation.valid) || b.score - a.score || a.recipeId.localeCompare(b.recipeId));
}
