# Shot geometry and plan contracts

`contracts.ts` defines the version 1.0 JSON inputs and plan output. `engine.ts` compiles one recipe, validates its geometry, and samples its motion. `defaults.ts` contains the example studio and twelve authored recipes. `take-analysis.ts` defines the independent video-tracking result contract. The native companion wire formats live in `native-companion.ts`; they have no capture, transform-import or AR-rendering implementation.

## Coordinate frame

Scene positions use meters in a floor-aligned Cartesian frame. `x` and `z` describe the floor; `y` is height above it. Product and obstacle boxes store a floor center, width along local x, depth along local z, base height and height. Positive box `yawDeg` rotates local +x toward world +z. This explicit x/z convention should be used when importing an external transform rather than assuming another system's yaw sign.

Recipe bearing zero places the camera on the product's +z side; increasing bearing moves it toward +x. The camera always looks at the center of the static product box. Camera yaw is `atan2(target.x-camera.x, target.z-camera.z)`; positive pitch points upward. There is no roll or animated product pose. Each recipe uses one constant camera height.

## Optics and framing

A physical lens uses its focal length and supplied sensor dimensions. An equivalent lens assumes a 36 by 24 mm full-frame reference sensor. Sensor long and short dimensions are oriented for landscape or portrait, then center-cropped to 16:9, 9:16 or 1:1. Horizontal and vertical field of view are `2 atan(active sensor dimension / (2 focal length))`. These are rectilinear pinhole estimates.

Framing projects all eight corners of the rotated product box through the camera basis. The normalized image origin is top-left. The framing box stores center, width and height; coverage is the greater of projected width and height. A corner behind the camera or a degenerate view produces `projectionValid: false`; its zero-size placeholder is only a serializable preview value, not an observed small product.

The default coverage bands are wide 0.15–0.30, medium 0.30–0.55 and close 0.55–0.82. Optional start and end bands interpolate linearly in time. The distance solver searches for the midpoint target using actual projected box dimensions. Framing checks sample 41 times with a 0.005 coverage tolerance. This is a sampled framing check; it is separate from the continuous geometric envelope check.

The current engine does not apply stabilization crops, custom recording aspect ratios, lens distortion, focus breathing, anamorphic desqueeze, sensor-window modes or camera calibration. `RecordingCropMetadataSchema` reserves those measured facts for a future adapter; creating metadata does not make the compiler consume it.

## Continuous swept envelopes

Paths are analytic holds, straight lines or circular arcs. Playback advances by normalized arc length, so a moving recipe has constant modeled translation speed. It does not model acceleration into motion, braking at the end or stabilizer dynamics.

The operator center lies behind the camera along the horizontal camera-to-product radial direction. Camera and operator each have a disc radius. Both radii are inflated by the sum of scene measurement uncertainty and gear handling uncertainty. Obstacles, including the product footprint, occupy their complete rotated floor rectangle at every height. This intentionally conservative floor model rejects passing a camera above a table and does not represent crouching or an operator's changing body orientation.

Each analytic camera and operator path is approximated by chords with a proven maximum deviation of 0.005 m or less, tighter than the 0.01 m envelope requirement. For a twice-differentiable path parameterized on [0,1], the bound per subdivision is `max ||p''|| / (8 n²)`. For an arc the camera bound uses `radius × sweep²`, and the operator uses `(radius + offset) × sweep²`. For a straight camera path the operator bound uses `6 × offset × pathLength² / minimumRadialDistance²`. The chosen chord-deviation bound is added to the corresponding body radius.

Every inflated chord is checked against every polygon edge and every rotated obstacle footprint. Endpoints must lie inside the boundary, and the whole chord must have positive clearance from every boundary edge. This detects concave notches, thin obstacles and arc excursions between endpoint poses. Contact is invalid. Self-intersecting or degenerate boundaries are invalid. Paths crossing the product center are invalid because their horizontal view direction is undefined. Near-singular paths that would require more than 10,000 subdivisions are explicitly rejected rather than reducing precision.

`validation.valid` means valid against this measured model and its configured limits. It is not an on-set safety certification. `minClearance` is the minimum modeled envelope separation; negative values indicate an intersection, not a calibrated penetration-depth measurement. Unmeasured objects, overhead hazards, moving people, floor condition, cables, product motion and tracking quality are outside this model.

## Recipes and equipment

The six implemented families are hold, push-in, pull-out, lateral, orbit and reveal, with two recipes per family. Their current review status is **programmatic tests only**. They have not received an attributed cinematographer or operator review. The engine suite checks deterministic execution, input constraints, projection, uncertainty and swept geometry; those checks do not establish aesthetic quality or operator approval.

Reveal recipes are angled lateral slides into a hero view. They do not verify a foreground occluder, its visibility timing, or a hidden-to-visible transition. The plan reports this limitation as an advisory.

Gear checks include camera height, maximum translational speed, translating paths on a fixed tripod, circular paths on a generic slider, and a warning when locked gimbal mode conflicts with aiming changes. Gimbal `follow` and `pov` are metadata labels with no distinct dynamic models. The engine has no calibrated yaw/pitch limits, axis acceleration limits, motor capacity, payload balancing, per-recipe gimbal tuning or device-specific mode mappings.

## Immutable versions and external capture

Compilation validates strict finite-number inputs, clones them, derives a deterministic version ID and freezes the result recursively. Requested dimensions and overrides are not silently corrected. Validation reports unused recipe overrides. Revalidation recompiles the source snapshot instead of trusting a persisted path or validity flag. Runtime plans include their source scene, gear, intent and overrides.

The current `Scene` has one aggregate measurement-uncertainty scalar. It does not preserve per-object measurement source, capture timestamp, sensor tracking state or alignment provenance. Native companion contracts keep those fields separately and require operator review before an import could become scene facts. `nativeToPlan` is a column-major, meter-scale transform with the explicit convention `planPoint = nativeToPlan × nativePoint`. An aligned record requires an operator-confirmation flag, timestamp and at least two reference points. It does not identify the operator, solve the alignment or verify that the transform is rigid.

The AR export contract requires world-anchored paths to be hidden while tracking is limited or alignment is lost, and requires reconfirmation after relocalization. These are wire-level requirements for a future native client. No native capture, transform application, tracking-state enforcement or AR presentation currently exists in the web engine.

The frozen planner training/evaluation uses the implementation recorded in [the research contract](../../training/research-contract.json) and [dataset manifest](../../training/frozen/manifest.json). Its solver-selected labels are not human recipe approvals.
