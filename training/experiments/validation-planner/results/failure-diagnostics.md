# Controlled planner failure diagnostics

The six trained-model failures labeled `independentDisagreements` in the recorded analysis are **brief violations, not geometric failures**. Three return the wrong movement family and three orbit in the wrong direction. All six pass the engine geometry check and the independent sampled boundary, obstacle and endpoint checks. The primary brief checker rejects the same six plans, so these are not disagreements between the two checkers. Base has twelve failed independent composite checks; its sampled geometry checks also pass.

These diagnostics read preserved outputs. They do not rerun models, change grades or replace earlier results. [The JSON receipt](failure-diagnostics.json) contains per-occurrence details and SHA-256 identities for every source read.

## Wording and repeated generation

Of 24 scheduled original/paraphrase pairs for the trained arm, 19 have both results available. Seven succeed under both wordings, six fail under both, three succeed only with the original and three only with the paraphrase. Agreement is 13/19, but only 7/19 are jointly productive.

Five of the six discordant pairs involve a rejected bearing followed by repeated identical compile calls until the repair budget ends. The remaining pair returns an orbit in the wrong direction. There is no net original-versus-paraphrase advantage among these 19 pairs. In scene `validation-02`, trial 0 succeeds only with the original and trial 1 only with the paraphrase. The observations show sensitivity across wording and generated samples; two repetitions do not isolate a causal wording effect.

## Geometry perturbations

The trained arm returns a brief-preserving plan in 9 of 21 available perturbation occurrences. Three of 24 scheduled occurrences are unavailable. Of the 12 available failures, 11 exhaust the repair budget and one returns the wrong orbit direction. Ten of the 11 repair failures repeat exactly the same rejected compile three times. The other alternates orbit direction while retaining a colliding bearing.

The rejected intermediate paths are not admitted as final plans. An alternative witness was frozen before execution for every supported fixture. A failure therefore reflects the recorded search behavior on a known-solvable task, not evidence that the request was impossible.

## Three inspected cases

| Occurrence | Recorded behavior | What it establishes |
| --- | --- | --- |
| `validation-07-geometry-perturbation-trial1-llama-sft` | Three identical `right-slide` calls at 35 degrees. Each observation identifies camera and operator collision with `counterfactual-stand`; the next request contains that observation. | The agent received the rejection and repeated the same action. It exhausted repairs without returning a plan. |
| `validation-08-paraphrase-trial0-llama-sft` | The brief asks for a left orbit. It compiles `quarter-orbit` with positive 21.9375-degree sweep, then finishes. | Clearance passes, but the recorded motion goes right under the declared coordinate convention. Both brief checkers reject direction. The matching original trial repairs to a negative sweep and passes. |
| `validation-11-paraphrase-trial0-llama-sft` | The brief asks for a diagonal entry into the hero composition. It compiles `right-slide`, a lateral recipe, and finishes. | Clearance and direction pass. Both brief checkers reject the family substitution. The same paraphrase substitution occurs in trial 1. |

The exact provider JSON, executed action, delivered tool observation and final score were reconciled for all calls in these three cases. Floating-point serialization is compared within 1e-12; the receipt states this tolerance. The finishing explanation claims the movement was preserved in the latter two cases, but the measured motion or family contradicts that claim.

## Paired result reconciliation

The supported comparison has 46 jointly available task/trial pairs: trained 21/46, base 10/46. There are 14 trained-only successes, 3 base-only successes, 7 shared successes and 22 shared failures. Every one of the 21 credited trained plans also passes the independent composite diagnostic. The recorded scene-group bootstrap interval for the trained-minus-base difference spans 0 to 48 percentage points. It conditions on availability and retains dependent conditions and repetitions inside each of 12 scene groups.

The next candidate needs better use of rejection evidence and explicit checks that a chosen family and direction preserve the request. These observations do not identify which part of training produced the behavior. Physical clearance, cinematographic quality and faster usable takes remain unmeasured.
