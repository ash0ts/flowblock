import { describe, expect, it } from 'vitest';
import { AlignmentSchema, NativeTransformSchema, RecipeReviewMetadataSchema, TrackingStateSchema } from '../src/domain/native-companion';

const transform = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], order: 'column-major', convention: 'planPoint = nativeToPlan * nativePoint', scale: 1 };
const alignment = { state: 'unconfirmed', nativeToPlan: transform, referencePoints: [], horizontalUncertaintyMeters: 0.05, verticalUncertaintyMeters: 0.03, headingUncertaintyDegrees: 2, confirmedAt: null, confirmedBy: 'unconfirmed' };
describe('native companion interface boundaries', () => {
  it('requires a finite 4x4 transform with explicit frame convention', () => {
    expect(NativeTransformSchema.safeParse(transform).success).toBe(true);
    expect(NativeTransformSchema.safeParse({ ...transform, matrix: [1, 0] }).success).toBe(false);
    expect(NativeTransformSchema.safeParse({ ...transform, matrix: transform.matrix.map((n, i) => i === 0 ? Infinity : n) }).success).toBe(false);
    expect(NativeTransformSchema.safeParse({ ...transform, scale: 100 }).success).toBe(false);
  });
  it('does not label an unconfirmed alignment aligned', () => {
    expect(AlignmentSchema.safeParse(alignment).success).toBe(true);
    expect(AlignmentSchema.safeParse({ ...alignment, state: 'aligned' }).success).toBe(false);
  });
  it('requires confirmation and reference points for an aligned import', () => {
    const points = [0, 1].map(x => ({ id: `${x}`, native: { x, y: 0, z: 0 }, plan: { x, y: 0, z: 0 } }));
    expect(AlignmentSchema.safeParse({ ...alignment, state: 'aligned', confirmedBy: 'operator', confirmedAt: '2026-10-29T10:00:00Z', referencePoints: points }).success).toBe(true);
  });
  it('requires an explicit limited-tracking reason', () => {
    expect(TrackingStateSchema.safeParse({ state: 'limited' }).success).toBe(false);
    expect(TrackingStateSchema.safeParse({ state: 'limited', reason: 'relocalizing' }).success).toBe(true);
  });
  it('cannot claim human review without attributed review metadata', () => {
    const metadata = { recipeId: 'hero-hold', status: 'programmatic-tests-only', reviewer: null, reviewedAt: null, evidence: ['tests/engine.test.ts'], scope: 'Modeled geometry only' };
    expect(RecipeReviewMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(RecipeReviewMetadataSchema.safeParse({ ...metadata, status: 'human-reviewed' }).success).toBe(false);
  });
});
