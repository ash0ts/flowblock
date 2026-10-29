import type { Gear, Intent, Recipe, Scene } from './contracts';

export const framingBands: Record<Intent['framing'], [number, number]> = {
  wide: [0.15, 0.3], medium: [0.3, 0.55], close: [0.55, 0.82],
};
export const defaultScene: Scene = {
  id: 'studio-01', name: 'Daylight studio',
  boundary: [{ x: -4, z: -3.5 }, { x: 4, z: -3.5 }, { x: 4, z: 4.5 }, { x: -4, z: 4.5 }],
  subject: { id: 'product', name: 'Ceramic bottle', center: { x: 0, z: 0 }, width: 0.22, depth: 0.22, height: 0.36, baseHeight: 0.85, yawDeg: 0 },
  obstacles: [
    { id: 'table', name: 'Product table', center: { x: 0, z: 0 }, width: 1.2, depth: 0.7, height: 0.85, baseHeight: 0, yawDeg: 0 },
    { id: 'light-stand', name: 'Key light stand', center: { x: 2.3, z: 0.6 }, width: 0.5, depth: 0.5, height: 2.1, baseHeight: 0, yawDeg: 20 },
    { id: 'backdrop', name: 'Backdrop feet', center: { x: 0, z: -2.6 }, width: 3.2, depth: 0.35, height: 2.4, baseHeight: 0, yawDeg: 0 },
  ],
  lights: [{ id: 'key', name: 'Soft key', position: { x: 2.3, y: 2.2, z: 0.6 }, intensity: 0.8 }],
  measurementUncertainty: 0.03,
};
export const defaultGear: Gear = {
  lens: { kind: 'equivalent', focalLengthMm: 50 }, aspectRatio: 'landscape',
  stabilizer: 'gimbal', gimbalMode: 'follow', cameraRadius: 0.12,
  operatorRadius: 0.28, operatorOffset: 0.45, uncertaintyMargin: 0.04,
  minHeight: 0.4, maxHeight: 2, maxSpeed: 0.6,
};
export const defaultIntent: Intent = {
  brief: 'A calm, deliberate hero shot of the ceramic bottle',
  durationSeconds: 8, framing: 'medium', motion: 'balanced', cameraHeight: 1.3,
};
export const recipes: Recipe[] = [
  { id: 'hero-hold', family: 'hold', name: 'Hero hold', description: 'A locked composition with room for the product to breathe.', bearingDeg: 0, travelFactor: 0, orbitDegrees: 0, heightOffset: 0 },
  { id: 'elevated-hold', family: 'hold', name: 'Elevated hold', description: 'A raised three-quarter view for the top and front surfaces.', bearingDeg: -25, travelFactor: 0, orbitDegrees: 0, heightOffset: 0.2 },
  { id: 'gentle-push', family: 'push-in', name: 'Gentle push', description: 'Move from context toward the product at a measured pace.', bearingDeg: 0, travelFactor: 0.3, orbitDegrees: 0, heightOffset: 0 },
  { id: 'detail-push', family: 'push-in', name: 'Detail push', description: 'A longer approach that brings the product details forward.', bearingDeg: 20, travelFactor: 0.5, orbitDegrees: 0, heightOffset: 0 },
  { id: 'context-pull', family: 'pull-out', name: 'Context pull', description: 'Begin close and open up the surrounding scene.', bearingDeg: 0, travelFactor: 0.3, orbitDegrees: 0, heightOffset: 0 },
  { id: 'wide-pull', family: 'pull-out', name: 'Wide pull', description: 'A longer departure into the surrounding space.', bearingDeg: -20, travelFactor: 0.5, orbitDegrees: 0, heightOffset: 0 },
  { id: 'left-slide', family: 'lateral', name: 'Left slide', description: 'Track left while keeping the product in the composition.', bearingDeg: 0, travelFactor: 0.45, orbitDegrees: 0, heightOffset: 0 },
  { id: 'right-slide', family: 'lateral', name: 'Right slide', description: 'Track right with a consistent look at the product.', bearingDeg: 0, travelFactor: -0.45, orbitDegrees: 0, heightOffset: 0 },
  { id: 'quarter-orbit', family: 'orbit', name: 'Quarter orbit', description: 'Trace a curved approach around the front of the product.', bearingDeg: 0, travelFactor: 0, orbitDegrees: 45, heightOffset: 0 },
  { id: 'reverse-orbit', family: 'orbit', name: 'Reverse orbit', description: 'Trace the same arc in the opposite direction.', bearingDeg: 0, travelFactor: 0, orbitDegrees: -45, heightOffset: 0 },
  { id: 'left-reveal', family: 'reveal', name: 'Left reveal', description: 'Slide from an angled opening into the hero view. Foreground occlusion must be arranged and checked separately.', bearingDeg: 15, travelFactor: 0.65, orbitDegrees: 0, heightOffset: 0 },
  { id: 'right-reveal', family: 'reveal', name: 'Right reveal', description: 'Slide from the other side into the hero view. Foreground occlusion must be arranged and checked separately.', bearingDeg: -15, travelFactor: -0.65, orbitDegrees: 0, heightOffset: 0 },
];
