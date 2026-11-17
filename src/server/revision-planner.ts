import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as weave from "weave";
import {
  beforeDeadline,
  boundedTelemetry,
  createDeadline,
  trace,
} from "./coordinator-runtime";
import {
  OverridesSchema,
  compilePlan,
  type Overrides,
  type PlanVersion,
  type TakeAnalysis,
} from "@/domain";
import {
  chat,
  telemetry,
  type PlannerMessage,
  type PlannerEvent,
} from "./planner";
import {
  ReviewReadActionSchema,
  RevisionActionSchema,
} from "./planner-actions";
import { parameterUnits } from "./planner-feedback";
import {
  revisionFindingId,
  revisionEvidenceChoices,
  revisionEvidenceActionSchema,
  validateRevisionEvidence,
  type RevisionAction,
} from "./revision-actions";
import {
  workflowAgentName,
  workflowAttributes,
  type WorkflowTraceContext,
} from "./workflow-telemetry";

export type RevisionProposal = {
  plan: PlanVersion;
  reason: string;
  findingIds: string[];
  source: "forge" | "library" | "manual";
  traceId?: string;
  model?: string;
  events: PlannerEvent[];
};
export const revisionVersion = "revision-v1.4";
export const findingId = revisionFindingId;

export class RevisionAbstainedError extends Error {
  readonly source = "forge" as const;
  readonly reason: string;
  readonly findingIds: string[];
  readonly traceId?: string;
  readonly model: string;
  readonly events: PlannerEvent[];
  constructor(details: {
    reason: string;
    findingIds: string[];
    traceId?: string;
    model: string;
    events: PlannerEvent[];
  }) {
    super(
      "The agent abstained from proposing a revision. Keep the original plan and review the cited evidence.",
    );
    this.name = "RevisionAbstainedError";
    this.reason = details.reason;
    this.findingIds = details.findingIds;
    this.traceId = details.traceId;
    this.model = details.model;
    this.events = details.events;
  }
}

function physicalSignature(plan: PlanVersion) {
  return JSON.stringify([plan.path, plan.durationSeconds, plan.cameraHeight]);
}

export function validateRevision(
  plan: PlanVersion,
  analysis: TakeAnalysis,
  overrides: Overrides,
  findingIds: string[],
): PlanVersion {
  if (analysis.planId !== plan.id)
    throw new Error("The take belongs to another plan version.");
  if (analysis.coverage.needsReview)
    throw new Error(
      "Correct uncertain tracking before proposing a plan change.",
    );
  overrides = OverridesSchema.parse(overrides);
  if (Object.keys(overrides).length !== 1)
    throw new Error("Propose exactly one parameter change.");
  if ("reverse" in overrides)
    throw new Error(
      "Direction changes need an explicit edit in the shot planner.",
    );
  const known = analysis.findings.map(findingId);
  if (findingIds.length !== 1 || !known.includes(findingIds[0]))
    throw new Error("Cite one finding from this take.");
  const finding = analysis.findings[known.indexOf(findingIds[0])];
  if (
    overrides.travel !== undefined &&
    (plan.family === "hold" || plan.family === "orbit")
  )
    throw new Error(
      "This recipe does not use travel. Choose a used parameter.",
    );
  if (overrides.orbitDegrees !== undefined && plan.family !== "orbit")
    throw new Error("Only an orbit recipe uses orbitDegrees.");
  validateRevisionEvidence(plan, finding, overrides);
  const revised = compilePlan(
    plan.scene,
    plan.gear,
    plan.intent,
    plan.recipeId,
    { ...plan.overrides, ...overrides },
  );
  if (physicalSignature(revised) === physicalSignature(plan))
    throw new Error("This proposal does not change the shot.");
  if (
    (plan.arcLength > 0 && revised.arcLength === 0) ||
    (plan.family === "orbit" &&
      Math.sign(revised.path.sweepAngle) !== Math.sign(plan.path.sweepAngle))
  )
    throw new Error("Preserve the planned movement and its direction.");
  if (!revised.validation.valid)
    throw new Error(
      `The revised shot does not fit: ${revised.validation.violations
        .filter((v) => v.severity === "error")
        .map((v) => v.message)
        .join(" ")}`,
    );
  return revised;
}

function explanation(
  overrides: Overrides,
  finding: TakeAnalysis["findings"][number],
): string {
  const key = Object.keys(overrides)[0] as keyof Overrides;
  const names: Record<keyof Overrides, string> = {
    distance: "planned camera distance",
    travel: "travel distance",
    bearingDeg: "starting bearing",
    orbitDegrees: "orbit sweep",
    height: "camera height",
    durationSeconds: "shot duration",
    reverse: "movement direction",
  };
  const units: Record<keyof Overrides, string> = {
    distance: " m",
    travel: " m",
    bearingDeg: "°",
    orbitDegrees: "°",
    height: " m",
    durationSeconds: " s",
    reverse: "",
  };
  const value = overrides[key];
  const formatted =
    typeof value === "number"
      ? `${Number(value.toFixed(2))}${units[key]}`
      : value
        ? "reversed"
        : "forward";
  const tradeoff =
    key === "orbitDegrees" || key === "travel"
      ? " This changes how much of the surroundings the shot reveals."
      : key === "durationSeconds"
        ? " This changes the pacing of the shot."
        : key === "distance"
          ? " This changes the planned product size and background perspective."
          : "";
  return `Try ${names[key]} at ${formatted}, then compare the next take against “${finding.title}.”${tradeoff} This is a proposed experiment; the footage does not establish the physical cause.`;
}

function deterministicAdjustment(
  plan: PlanVersion,
  analysis: TakeAnalysis,
): { overrides: Overrides; findingIds: string[] }[] {
  return analysis.findings.flatMap<{
    overrides: Overrides;
    findingIds: string[];
  }>((finding, index) => {
    const findingIds = [findingId(finding, index)];
    if (finding.kind === "duration")
      return [
        {
          overrides: {
            durationSeconds: Math.max(
              5,
              Math.min(15, analysis.video.durationSeconds),
            ),
          },
          findingIds,
        },
      ];
    if (finding.kind === "clipping")
      return [{ overrides: { distance: plan.path.radius * 1.12 }, findingIds }];
    if (finding.kind === "size") {
      // Legacy results cannot establish the direction of the cited phase's size deviation.
      if (finding.measurement?.metric !== "size-ratio") return [];
      const ratio = finding.measurement.observed;
      return [
        {
          overrides: {
            distance: plan.path.radius * (ratio >= 1 ? 1.12 : 0.88),
          },
          findingIds,
        },
      ];
    }
    if (plan.family === "orbit")
      return [
        {
          overrides: {
            orbitDegrees:
              ((plan.path.sweepAngle *
                (plan.overrides.reverse ? -1 : 1) *
                180) /
                Math.PI) *
              0.8,
          },
          findingIds,
        },
      ];
    // Changing duration cannot correct a phase-aligned spatial framing mismatch.
    return [];
  });
}

type RevisionOptions = {
  chat?: typeof chat;
  trace?: boolean;
  model?: string;
  deadlineMs?: number;
  overrides?: Overrides;
  findingIds?: string[];
  workflowTrace?: WorkflowTraceContext;
};
export async function proposeRevision(
  plan: PlanVersion,
  analysis: TakeAnalysis,
  options: RevisionOptions = {},
): Promise<RevisionProposal> {
  return weave.runIsolated(() =>
    proposeRevisionIsolated(plan, analysis, options),
  );
}
async function proposeRevisionIsolated(
  plan: PlanVersion,
  analysis: TakeAnalysis,
  options: RevisionOptions,
): Promise<RevisionProposal> {
  const events: PlannerEvent[] = [];
  const started = Date.now();
  if (analysis.planId !== plan.id)
    throw new Error("The take belongs to another plan version.");
  const findings = analysis.findings.map((f, index) => ({
    id: findingId(f, index),
    kind: f.kind,
    phase: f.phase,
    title: f.title,
    detail: f.detail,
    timestamps: f.evidenceTimestamps,
    affectedFrames: f.affectedFrames,
    measuredPhaseFrames: f.measuredPhaseFrames,
    measurement: f.measurement,
  }));
  if (!findings.length || analysis.coverage.needsReview)
    throw new Error(
      "Reliable measured findings are required before a revision.",
    );
  const build = (
    overrides: Overrides,
    findingIds: string[],
    source: RevisionProposal["source"],
  ): RevisionProposal => {
    const revised = validateRevision(plan, analysis, overrides, findingIds);
    const finding =
      analysis.findings[findings.findIndex((f) => f.id === findingIds[0])];
    return {
      plan: revised,
      reason: explanation(overrides, finding),
      findingIds,
      source,
      events,
    };
  };
  if (options.overrides)
    return build(
      options.overrides,
      options.findingIds ?? [findings[0].id],
      "manual",
    );
  const fallback = () => {
    for (const proposal of deterministicAdjustment(plan, analysis)) {
      try {
        return build(proposal.overrides, proposal.findingIds, "library");
      } catch {
        /* Try the next measured finding. */
      }
    }
    throw new Error(
      "No single feasible parameter change was found. Keep the original plan and adjust the setup explicitly.",
    );
  };
  if (!process.env.WANDB_API_KEY && !options.chat) return fallback();
  const model =
    options.model || process.env.FLOWBLOCK_MODEL || "openai/gpt-oss-20b";
  const scope = createDeadline(options.deadlineMs, started),
    deadline = scope.signal;
  const traced =
    options.trace !== false && (await boundedTelemetry(telemetry, deadline));
  const conversation = traced
    ? trace(() =>
        weave.startConversation({
          agentName: options.workflowTrace
            ? workflowAgentName
            : "FlowBlock revision",
          agentVersion: revisionVersion,
          model,
          conversationId: options.workflowTrace?.workflowId ?? randomUUID(),
          attributes: {
            parentPlanId: plan.id,
            jobId: analysis.jobId,
            "flowblock.telemetry_version": "agent-lens-v1",
            ...(options.workflowTrace
              ? workflowAttributes(options.workflowTrace)
              : {}),
          },
        }),
      )
    : undefined;
  const turn = trace(() =>
    conversation?.startTurn({
      userMessage: "Propose one measured, feasible next-take experiment.",
    }),
  );
  const choices = revisionEvidenceChoices(plan, analysis);
  const evidenceSchema = revisionEvidenceActionSchema(plan, analysis);
  const supportedParameters = [
    ...new Set(choices.flatMap((choice) => choice.parameters)),
  ];
  const systemMessage = (hasRead: boolean): PlannerMessage => ({
    role: "system",
    content: `${hasRead ? "Choose one next-take experiment from the evidence-specific finding and parameter pairs, or explicitly abstain_revision with cited findings and a reason. The findings are already available; do not reread them. An empty object or an unchanged parameter is not abstention." : "Read the take findings before proposing any changes. Only read_take_findings is available for this step."} Return one JSON action, no markdown. Preserve the original brief. Do not modify the recipe, scene, gear, desired framing targets, or movement direction. Use only the listed parameter for the cited finding. Numeric values are your proposed experiment, subject to validation; a size ratio is not a calibrated distance multiplier. Never infer real walking distance, obstacle clearance, or physical shake from footage. Explain changes as experiments, not established physical causes. After rejection, change a relevant value or abstain; repeating a rejected proposal is not progress. Repair at most twice; six actions maximum. An uncertain track is not evidence of product disappearance. Available actions:\n${JSON.stringify(z.toJSONSchema(hasRead ? evidenceSchema : ReviewReadActionSchema))}`,
  });
  const messages: PlannerMessage[] = [
    systemMessage(false),
    {
      role: "user",
      content: JSON.stringify({
        plan: {
          id: plan.id,
          recipeId: plan.recipeId,
          family: plan.family,
          intent: plan.intent,
          overrides: plan.overrides,
          durationSeconds: plan.durationSeconds,
          radius: plan.path.radius,
          sweepDegrees: (plan.path.sweepAngle * 180) / Math.PI,
          arcLength: plan.arcLength,
          cameraHeight: plan.cameraHeight,
          allowedOverrides: supportedParameters,
        },
        parameterUnits: Object.fromEntries(
          supportedParameters.map((parameter) => [
            parameter,
            parameterUnits[parameter],
          ]),
        ),
        analysisId: analysis.jobId,
      }),
    },
  ];
  type StopReason =
    | "completed"
    | "provider_error"
    | "deadline"
    | "repair_budget"
    | "action_budget"
    | "unexpected_error"
    | "model_abstention";
  let read = false,
    repairs = 0;
  let stopReason: StopReason = "action_budget";
  let providerFailed = false;
  const rejectedProposals = new Set<string>();
  const publishResult = (result: RevisionProposal): RevisionProposal => {
    trace(() => {
      turn?.record({
        outputMessages: [{ role: "assistant", content: result.reason }],
      });
      turn?.setAttributes({
        "flowblock.result_source": result.source,
        "flowblock.revised_plan_id": result.plan.id,
        "flowblock.outcome": result.source === "forge" ? "revised" : "fallback",
        "flowblock.stop_reason": stopReason,
        "flowblock.rejected_actions": repairs,
      });
    });
    return { ...result, traceId: conversation?.conversationId, model };
  };
  try {
    try {
      for (let i = 0; i < 6; i++) {
        if (deadline.aborted) throw deadline.reason;
        const llm = trace(() =>
          turn?.startLLM({ model, providerName: "coreweave" }),
        );
        const requestMessages = messages.map((message) => ({ ...message }));
        let content: string;
        try {
          trace(() => {
            if (llm) llm.inputMessages = requestMessages;
          });
          const result = await beforeDeadline(
            () => (options.chat || chat)(requestMessages, model, deadline),
            deadline,
          );
          content = result.content;
          trace(() => {
            llm?.output(content);
            llm?.record({ usage: result.usage });
          });
        } catch (error) {
          providerFailed = !deadline.aborted;
          trace(() => {
            llm?.setAttributes({
              "flowblock.stop_reason": deadline.aborted
                ? "deadline"
                : "provider_error",
            });
            llm?.recordError(
              error instanceof Error ? error : new Error("Inference failed"),
            );
          });
          throw error;
        } finally {
          trace(() => llm?.end());
        }
        messages.push({ role: "assistant", content });
        let rawAction: unknown = { raw: content };
        let action: RevisionAction | undefined;
        let observation: unknown;
        let proposal: RevisionProposal | undefined;
        let rejection: string | undefined;
        try {
          rawAction = JSON.parse(content);
          action = read
            ? evidenceSchema.parse(rawAction)
            : ReviewReadActionSchema.parse(rawAction);
        } catch {
          rejection = read
            ? "Return one evidence-specific propose_revision action, or abstain_revision with a reason and listed finding IDs. An empty object is not an action."
            : "Read the take findings before proposing or abstaining.";
          const parsed = RevisionActionSchema.safeParse(rawAction);
          if (
            read &&
            parsed.success &&
            parsed.data.action === "read_take_findings"
          )
            rejection =
              "Findings are already available. Propose one supported change or explicitly abstain.";
          if (
            read &&
            parsed.success &&
            parsed.data.action === "propose_revision"
          ) {
            const proposed = parsed.data;
            const finding = analysis.findings.find(
              (item, index) =>
                findingId(item, index) === proposed.findingIds[0],
            );
            if (!finding) rejection = "Cite one finding ID from this take.";
            else
              try {
                validateRevisionEvidence(plan, finding, parsed.data.overrides);
              } catch (error) {
                rejection =
                  error instanceof Error
                    ? error.message
                    : "Unsupported evidence/parameter pair.";
              }
          }
        }
        const tool = trace(() =>
          turn?.startTool({
            name: action?.action ?? "validate_revision_action",
            args: JSON.stringify(action ? rawAction : { received: rawAction }),
          }),
        );
        try {
          if (action?.action === "read_take_findings") {
            read = true;
            messages[0] = systemMessage(true);
            observation = {
              findings,
              coverage: analysis.coverage,
              measuredDurationSeconds: analysis.video.durationSeconds,
              revisionChoices: choices,
              nextActions: ["propose_revision", "abstain_revision"],
            };
          } else if (action?.action === "propose_revision") {
            const fingerprint = JSON.stringify([
              action.findingIds,
              Object.entries(action.overrides).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ]);
            if (rejectedProposals.has(fingerprint)) {
              rejection =
                "This exact proposal was already rejected. No new compile ran. Change a relevant value or explicitly abstain.";
            } else
              try {
                proposal = build(action.overrides, action.findingIds, "forge");
                observation = {
                  candidateId: proposal.plan.id,
                  validation: proposal.plan.validation,
                  findingIds: proposal.findingIds,
                };
              } catch (error) {
                rejectedProposals.add(fingerprint);
                rejection =
                  error instanceof Error ? error.message : "Invalid proposal";
              }
          } else if (action?.action === "abstain_revision") {
            observation = {
              status: "abstained",
              findingIds: action.findingIds,
              reason: action.reason,
            };
          }
          if (rejection)
            observation = {
              status: "rejected",
              error: rejection,
              repairGuidance: read
                ? {
                    choices,
                    nextActions: ["propose_revision", "abstain_revision"],
                    instruction:
                      "Choose one listed finding/parameter pair with a changed value, or explicitly abstain. Do not change unrelated facts or repeat the rejected action.",
                  }
                : { nextActions: ["read_take_findings"] },
            };
          events.push({
            action: rawAction,
            observation,
            elapsedMs: Date.now() - started,
          });
        } finally {
          // A rejected action is an observation the coordinator can repair.
          trace(() =>
            tool?.setAttributes({
              "flowblock.action_outcome": rejection ? "rejected" : "accepted",
            }),
          );
          trace(() => tool?.end({ result: JSON.stringify(observation) }));
        }
        if (action?.action === "abstain_revision") {
          stopReason = "model_abstention";
          const abstention = new RevisionAbstainedError({
            ...action,
            model,
            traceId: conversation?.conversationId,
            events,
          });
          trace(() => {
            turn?.record({
              outputMessages: [
                { role: "assistant", content: abstention.message },
              ],
            });
            turn?.setAttributes({
              "flowblock.result_source": "forge",
              "flowblock.outcome": "abstained",
              "flowblock.stop_reason": stopReason,
              "flowblock.rejected_actions": repairs,
            });
          });
          throw abstention;
        }
        if (proposal) {
          stopReason = "completed";
          return publishResult(proposal);
        }
        messages.push({
          role: "user",
          content: JSON.stringify({ observation }),
        });
        if (rejection && ++repairs > 2) {
          stopReason = "repair_budget";
          break;
        }
      }
    } catch (error) {
      if (error instanceof RevisionAbstainedError) throw error;
      stopReason = deadline.aborted
        ? "deadline"
        : providerFailed
          ? "provider_error"
          : "unexpected_error";
      trace(() =>
        turn?.recordError(
          error instanceof Error ? error : new Error("Revision failed"),
        ),
      );
    }
    try {
      return publishResult(fallback());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "No revision found.";
      trace(() => {
        turn?.record({
          outputMessages: [{ role: "assistant", content: message }],
        });
        turn?.setAttributes({
          "flowblock.outcome": "abstained",
          "flowblock.stop_reason": stopReason,
          "flowblock.rejected_actions": repairs,
        });
      });
      throw error;
    }
  } finally {
    try {
      trace(() => turn?.end());
      trace(() => conversation?.end());
      if (traced && !deadline.aborted)
        await boundedTelemetry(() => weave.flushOTel(), deadline);
    } finally {
      scope.close();
    }
  }
}
