import type { Box, Point } from './contracts';

const EPS = 1e-10;
export const radians = (degrees: number) => degrees * Math.PI / 180;
export const degrees = (radiansValue: number) => radiansValue * 180 / Math.PI;
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpPoint = (a: Point, b: Point, t: number): Point => ({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSquared));
  return distance(p, { x: a.x + dx * t, z: a.z + dz * t });
}
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) && ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return true;
  return (Math.abs(abC) <= EPS && pointSegmentDistance(c, a, b) <= EPS)
    || (Math.abs(abD) <= EPS && pointSegmentDistance(d, a, b) <= EPS)
    || (Math.abs(cdA) <= EPS && pointSegmentDistance(a, c, d) <= EPS)
    || (Math.abs(cdB) <= EPS && pointSegmentDistance(b, c, d) <= EPS);
}
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
export function polygonArea(polygon: Point[]): number {
  return polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]; return sum + p.x * q.z - p.z * q.x; }, 0) / 2;
}
export function polygonProblems(polygon: Point[]): string[] {
  const problems: string[] = [];
  if (Math.abs(polygonArea(polygon)) < 1e-8) problems.push('Boundary must enclose a nonzero area.');
  for (let i = 0; i < polygon.length; i++) {
    const next = (i + 1) % polygon.length;
    if (distance(polygon[i], polygon[next]) < 1e-8) problems.push('Boundary has a zero-length edge.');
    for (let j = i + 1; j < polygon.length; j++) {
      const after = (j + 1) % polygon.length;
      if (next === j || after === i) continue;
      if (segmentsIntersect(polygon[i], polygon[next], polygon[j], polygon[after])) problems.push('Boundary must not intersect itself.');
    }
  }
  return [...new Set(problems)];
}
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (pointSegmentDistance(p, a, b) < EPS) return true;
    if (((a.z > p.z) !== (b.z > p.z)) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
export function segmentPolygonDistance(a: Point, b: Point, polygon: Point[]): number {
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return 0;
  return segmentBoundaryDistance(a, b, polygon);
}
export function segmentBoundaryDistance(a: Point, b: Point, polygon: Point[]): number {
  return Math.min(...polygon.map((p, i) => segmentDistance(a, b, p, polygon[(i + 1) % polygon.length])));
}
export function boxCorners(box: Box): Point[] {
  const angle = radians(box.yawDeg), cos = Math.cos(angle), sin = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const x = sx * box.width / 2, z = sz * box.depth / 2;
    return { x: box.center.x + x * cos - z * sin, z: box.center.z + x * sin + z * cos };
  });
}
