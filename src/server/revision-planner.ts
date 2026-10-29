import { randomUUID } from "node:crypto";
import * as weave from "weave";
import {
  beforeDeadline,
  boundedTelemetry,
  createDeadline,
  trace,
} from "./coordinator-runtime";
import {
  AgentActionSchema,
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

export type RevisionProposal = {
  plan: PlanVersion;
  reason: string;
  findingIds: string[];
  source: "forge" | "library" | "manual";
  traceId?: string;
  model?: string;
  events: PlannerEvent[];
};
export const revisionVersion = "revision-v1.1";
export const findingId = (
  finding: TakeAnalysis["findings"][number],
  index: number,
) => `${finding.kind}:${finding.phase}:${index}`;

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
  if (Object.keys(overrides).length !== 1)
    throw new Error("Propose exactly one parameter change.");
  if ("reverse" in overrides)
    throw new Error(
      "Direction changes need an explicit edit in the shot planner.",
    );
  const known = analysis.findings.map(findingId);
  if (findingIds.length !== 1 || !known.includes(findingIds[0]))
    throw new Error("Cite one finding from this take.");
  const revised = compilePlan(
    plan.scene,
    plan.gear,
    plan.intent,
    plan.recipeId,
    { ...plan.overrides, ...overrides },
  );
  if (physicalSignature(revised) === physicalSignature(plan))
    throw new Error("This proposal does not change the shot.");
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

export async function proposeRevision(
  plan: PlanVersion,
  analysis: TakeAnalysis,
  options: {
    chat?: typeof chat;
    trace?: boolean;
    model?: string;
    deadlineMs?: number;
    overrides?: Overrides;
    findingIds?: string[];
  } = {},
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
          agentName: "FlowBlock revision",
          agentVersion: revisionVersion,
          model,
          conversationId: randomUUID(),
          attributes: { parentPlanId: plan.id, jobId: analysis.jobId },
        }),
      )
    : undefined;
  const turn = trace(() =>
    conversation?.startTurn({
      userMessage: "Propose one measured, feasible next-take experiment.",
    }),
  );
  const messages: PlannerMessage[] = [
    {
      role: "system",
      content:
        'You coordinate one next-take experiment for FlowBlock. Return one JSON action, no markdown. Read the take findings first using {"action":"read_take_findings"}. Then use {"action":"propose_revision","overrides":{ONE_PARAMETER:NUMBER},"findingIds":["one exact finding ID"],"reason":"hypothesis and tradeoff"}. Editable parameters: distance in meters, travel in meters, bearingDeg, orbitDegrees, height in meters, durationSeconds. Do not modify the recipe, scene, gear, or desired framing targets. Use only the measured evidence; never infer real walking distance, obstacle clearance, or physical shake. A timing mismatch can change duration; a framing mismatch can suggest a small feasible parameter experiment. Tool validation is authoritative. Repair at most twice; six actions maximum. An uncertain track is not evidence of product disappearance.',
    },
    {
      role: "user",
      content: JSON.stringify({
        plan: {
          id: plan.id,
          recipeId: plan.recipeId,
          family: plan.family,
          overrides: plan.overrides,
          durationSeconds: plan.durationSeconds,
          radius: plan.path.radius,
          sweepDegrees: (plan.path.sweepAngle * 180) / Math.PI,
          arcLength: plan.arcLength,
          cameraHeight: plan.cameraHeight,
        },
        analysisId: analysis.jobId,
      }),
    },
  ];
  let read = false,
    repairs = 0;
  try {
    for (let i = 0; i < 6; i++) {
      if (deadline.aborted) throw new Error("Revision deadline reached");
      const llm = trace(() =>
        turn?.startLLM({ model, providerName: "coreweave" }),
      );
      let content: string;
      try {
        trace(() => {
          if (llm) llm.inputMessages = messages;
        });
        const result = await beforeDeadline(
          () => (options.chat || chat)(messages, model, deadline),
          deadline,
        );
        content = result.content;
        trace(() => {
          llm?.output(content);
          llm?.record({ usage: result.usage });
        });
      } finally {
        trace(() => llm?.end());
      }
      messages.push({ role: "assistant", content });
      let observation: unknown;
      try {
        const action = AgentActionSchema.parse(JSON.parse(content));
        const tool = trace(() =>
          turn?.startTool({
            name: action.action,
            args: JSON.stringify(action),
          }),
        );
        try {
          if (action.action === "read_take_findings") {
            read = true;
            observation = {
              findings,
              coverage: analysis.coverage,
              measuredDurationSeconds: analysis.video.durationSeconds,
            };
          } else if (action.action === "propose_revision" && read) {
            const result = build(action.overrides, action.findingIds, "forge");
            observation = {
              candidateId: result.plan.id,
              validation: result.plan.validation,
              findingIds: result.findingIds,
            };
            events.push({
              action,
              observation,
              elapsedMs: Date.now() - started,
            });
            trace(() => tool?.end({ result: JSON.stringify(observation) }));
            return { ...result, traceId: conversation?.conversationId, model };
          } else
            throw new Error(
              "Read findings, then propose one parameter change with one finding ID.",
            );
          trace(() => tool?.end({ result: JSON.stringify(observation) }));
          events.push({ action, observation, elapsedMs: Date.now() - started });
        } catch (error) {
          trace(() =>
            tool?.end({
              error:
                error instanceof Error ? error : new Error("Invalid proposal"),
            }),
          );
          throw error;
        }
      } catch (error) {
        if (++repairs > 2) throw error;
        observation = {
          error: error instanceof Error ? error.message : "Invalid JSON action",
        };
      }
      messages.push({ role: "user", content: JSON.stringify({ observation }) });
    }
  } catch (error) {
    trace(() =>
      turn?.recordError(
        error instanceof Error ? error : new Error("Revision failed"),
      ),
    );
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
  return fallback();
}
