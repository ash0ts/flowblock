import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import * as weave from "weave";
import {
  compilePlan,
  OverridesSchema,
  RecipeIdSchema,
  recipes,
  type PlanVersion,
} from "../../../src/domain";
import {
  chat,
  PlanningInputSchema,
  telemetry,
  type ChatResult,
  type PlannerEvent,
  type PlannerMessage,
  type PlanningInput,
  type PlanningResult,
} from "../../../src/server/planner";
import {
  beforeDeadline,
  boundedTelemetry,
  createDeadline,
  trace,
} from "../../../src/server/coordinator-runtime";

export const researchPlannerVersion = "flowblock-research-planner-v2";
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_recipes") }).strict(),
  z
    .object({
      action: z.literal("compile_candidate"),
      recipeId: RecipeIdSchema,
      overrides: OverridesSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("validate_candidate"),
      candidateId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("finish"),
      candidateIds: z.array(z.string().min(1)).max(1),
      explanation: z.string().min(1).max(4000),
    })
    .strict(),
]);
export const systemPrompt = `You are FlowBlock's product-shot planning coordinator. Produce ONE move that preserves the user's brief and supplied scene, gear, framing targets, exact camera height and exact duration. Return exactly one JSON action per turn, no markdown. You have six total actions and at most two repairs. Initial planning has no uploaded take or revision tools.
Start by compiling a matching recipe with its defaults while preserving the declared camera height exactly. If a recipe has a height offset, override height with the declared intent.cameraHeight. Honor any requested minimum travel, minimum orbit angle and movement direction. Omit distance unless a measured distance is explicitly required: the compiler solves distance from the lens and product framing. Omit other overrides unless needed. Recipe travel fractions describe defaults; a travel override is an absolute nonnegative distance in METERS. Use travel only for push-in, pull-out, lateral, or reveal; never use it for hold or orbit. Use orbitDegrees only for an orbit; its sign sets direction. Omit unsupported overrides instead of setting them to zero. A reverse override reverses the actual move without changing its family label. A push-in must move closer; a pull-out must move farther away. Zero travel is not a moving shot.
Inspect compile_candidate's validation and observed motion. Geometry validation is authoritative under supplied measurements. Repair a failed candidate with another compile_candidate action, changing a parameter justified by its observations. Do not change scene facts, substitute an unrequested family, shorten a mandatory movement, or change required duration/framing silently. A reveal recipe does not validate foreground occlusion; state that unsupported requirement when applicable.
Finish with at most one candidate ID you have compiled and validated, preserving the brief. A candidate ID is the returned plan ID, never a recipe ID or invented ID. If your tested candidates fail, you may finish empty only AFTER an actual compile check. An empty result means the tested candidates were not selected; it is not proof that every possible move is infeasible. Return an explicit finish before the action limit. No fallback library results receive model credit.
Available actions:\n${JSON.stringify(z.toJSONSchema(actionSchema))}`;

function recipeContext() {
  return recipes.map((recipe) => ({
    id: recipe.id,
    family: recipe.family,
    name: recipe.name,
    description: recipe.description,
    defaults: {
      bearingDeg: recipe.bearingDeg,
      heightOffsetMeters: recipe.heightOffset,
      ...(recipe.family === "orbit"
        ? { orbitDegrees: recipe.orbitDegrees }
        : recipe.family === "hold"
          ? {}
          : {
              travelFractionOfOpticallySolvedDistance: Math.abs(
                recipe.travelFactor,
              ),
            }),
    },
    allowedOverrides: [
      "distance",
      "bearingDeg",
      "height",
      "durationSeconds",
      "reverse",
      ...(recipe.family === "orbit"
        ? ["orbitDegrees"]
        : recipe.family === "hold"
          ? []
          : ["travel"]),
    ],
  }));
}
export function initialMessages(input: PlanningInput): PlannerMessage[] {
  const parsed = PlanningInputSchema.parse(input);
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: JSON.stringify({ ...parsed, recipes: recipeContext() }),
    },
  ];
}
export function observeCompile(plan: PlanVersion) {
  return {
    candidateId: plan.id,
    recipeId: plan.recipeId,
    family: plan.family,
    validation: plan.validation,
    framing: plan.framing,
    durationSeconds: plan.durationSeconds,
    cameraHeight: plan.cameraHeight,
    motion: {
      pathKind: plan.path.kind,
      travelMeters: plan.arcLength,
      startPosition: plan.keyframes[0].position,
      endPosition: plan.keyframes.at(-1)!.position,
      startDistanceMeters: plan.keyframes[0].distance,
      endDistanceMeters: plan.keyframes.at(-1)!.distance,
      orbitSweepDegrees: (plan.path.sweepAngle * 180) / Math.PI,
    },
  };
}
export type ResearchFailure =
  | "action-budget"
  | "repair-budget"
  | "deadline"
  | "provider-error"
  | "tool-error";
export type ResearchPlanningResult = PlanningResult & {
  termination: "finished" | ResearchFailure;
  failure?: { kind: ResearchFailure; stage: string; message: string };
};
export type ResearchPlannerOptions = {
  model?: string;
  deadlineMs?: number;
  chat?: typeof chat;
  trace?: boolean;
};
class ResearchStop extends Error {
  constructor(
    readonly kind: ResearchFailure,
    message: string,
  ) {
    super(message);
  }
}
export async function runResearchPlanner(
  raw: PlanningInput,
  options: ResearchPlannerOptions = {},
): Promise<ResearchPlanningResult> {
  return weave.runIsolated(() => runIsolated(raw, options));
}
async function runIsolated(
  raw: PlanningInput,
  options: ResearchPlannerOptions,
): Promise<ResearchPlanningResult> {
  const started = Date.now();
  const input = PlanningInputSchema.parse(raw);
  const inputHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const model =
    options.model ?? process.env.FLOWBLOCK_MODEL ?? "openai/gpt-oss-20b";
  const scope = createDeadline(options.deadlineMs, started);
  const deadline = scope.signal;
  const events: PlannerEvent[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const messages = initialMessages(input);
  const candidates = new Map<string, PlanVersion>();
  let compileCount = 0;
  let repairs = 0;
  let stage = "initialization";
  let traced = false;
  let conversation: ReturnType<typeof weave.startConversation> | undefined;
  let turn:
    | ReturnType<ReturnType<typeof weave.startConversation>["startTurn"]>
    | undefined;
  let result: ResearchPlanningResult | undefined;
  const finish = (
    plans: PlanVersion[],
    message: string,
    termination: ResearchPlanningResult["termination"],
    failure?: ResearchPlanningResult["failure"],
  ): ResearchPlanningResult => ({
    plans,
    source: "forge",
    message,
    traceId: conversation?.conversationId,
    model,
    events,
    usage,
    inputHash,
    plannerVersion: researchPlannerVersion,
    latencyMs: Date.now() - started,
    termination,
    ...(failure ? { failure } : {}),
  });
  const repair = () => {
    if (++repairs > 2)
      throw new ResearchStop(
        "repair-budget",
        "The two-repair budget was exhausted.",
      );
  };
  try {
    traced =
      options.trace !== false && (await boundedTelemetry(telemetry, deadline));
    deadline.throwIfAborted();
    conversation = traced
      ? trace(() =>
          weave.startConversation({
            agentName: "FlowBlock research planner",
            agentVersion: researchPlannerVersion,
            model,
            conversationId: randomUUID(),
            attributes: {
              inputHash,
              "flowblock.telemetry_version": "agent-lens-v1",
              "flowblock.experiment_runtime": researchPlannerVersion,
            },
          }),
        )
      : undefined;
    turn = trace(() =>
      conversation?.startTurn({
        userMessage: input.prompt || input.intent.brief,
      }),
    );
    for (let i = 0; i < 6; i++) {
      deadline.throwIfAborted();
      stage = "inference";
      const llm = trace(() =>
        turn?.startLLM({ model, providerName: "coreweave" }),
      );
      let response: ChatResult;
      try {
        const sentMessages = structuredClone(messages);
        trace(() => {
          if (llm) llm.inputMessages = sentMessages;
        });
        response = await beforeDeadline(
          () => (options.chat ?? chat)(sentMessages, model, deadline),
          deadline,
        );
        trace(() => {
          llm?.output(response.content);
          llm?.record({ usage: response.usage });
        });
      } catch (error) {
        trace(() =>
          llm?.recordError(
            error instanceof Error
              ? error
              : new Error("Provider request failed"),
          ),
        );
        throw error;
      } finally {
        trace(() => llm?.end());
      }
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      messages.push({ role: "assistant", content: response.content });
      stage = "protocol";
      let rawAction: unknown = response.content;
      try {
        rawAction = JSON.parse(response.content);
      } catch {
        /* The schema rejection below records malformed JSON too. */
      }
      const parsed = actionSchema.safeParse(rawAction);
      if (!parsed.success) {
        const observation = {
          error: "invalid_action",
          message:
            "Return exactly one JSON action matching the planning-only schema.",
          issues: parsed.error.issues,
        };
        events.push({
          action: rawAction,
          observation,
          elapsedMs: Date.now() - started,
        });
        messages.push({
          role: "user",
          content: JSON.stringify({ observation }),
        });
        repair();
        continue;
      }
      const action = parsed.data;
      stage = "tool";
      const tool = trace(() =>
        turn?.startTool({ name: action.action, args: JSON.stringify(action) }),
      );
      const event: PlannerEvent = {
        action,
        observation: { status: "started" },
        elapsedMs: Date.now() - started,
      };
      events.push(event);
      let observation: unknown;
      let needsRepair = false;
      let completed: ResearchPlanningResult | undefined;
      try {
        switch (action.action) {
          case "list_recipes":
            observation = recipeContext();
            break;
          case "compile_candidate": {
            compileCount++;
            const plan = compilePlan(
              input.scene,
              input.gear,
              input.intent,
              action.recipeId,
              action.overrides,
            );
            candidates.set(plan.id, plan);
            observation = observeCompile(plan);
            needsRepair = !plan.validation.valid;
            break;
          }
          case "validate_candidate": {
            const plan = candidates.get(action.candidateId);
            observation = plan
              ? { candidateId: plan.id, validation: plan.validation }
              : {
                  error: "unknown_candidate",
                  message:
                    "Compile a candidate before validating its returned ID.",
                };
            needsRepair = !plan;
            break;
          }
          case "finish": {
            const plans = action.candidateIds.flatMap(
              (id) => candidates.get(id) ?? [],
            );
            if (
              action.candidateIds.some(
                (id) => !candidates.get(id)?.validation.valid,
              )
            ) {
              observation = {
                error: "invalid_finish",
                message: "Finish must reference a compiled, validated plan ID.",
              };
              needsRepair = true;
            } else if (!action.candidateIds.length && compileCount === 0) {
              observation = {
                error: "unchecked_abstention",
                message:
                  "Compile at least one matching recipe before concluding that your tested candidates were not selected.",
              };
              needsRepair = true;
            } else {
              const message = plans.length
                ? action.explanation
                : `${action.explanation} No candidate was selected after ${compileCount} compile checks. These finite checks do not prove that the requested shot is infeasible.`;
              observation = {
                accepted: plans.map((plan) => plan.id),
                message,
                compileChecks: compileCount,
              };
              completed = finish(plans, message, "finished");
            }
            break;
          }
        }
        event.observation = observation;
        event.elapsedMs = Date.now() - started;
        trace(() => tool?.end({ result: JSON.stringify(observation) }));
      } catch (error) {
        event.observation = {
          error: "tool_failure",
          message:
            "The planning tool failed before returning a validated observation.",
        };
        event.elapsedMs = Date.now() - started;
        trace(() =>
          tool?.end({
            error:
              error instanceof Error
                ? error
                : new Error("Planning tool failed"),
          }),
        );
        throw error;
      }
      if (completed) {
        result = completed;
        break;
      }
      messages.push({ role: "user", content: JSON.stringify({ observation }) });
      if (needsRepair) repair();
    }
    if (!result)
      throw new ResearchStop(
        "action-budget",
        "The six-action budget ended without a valid finish.",
      );
  } catch (error) {
    const kind: ResearchFailure = deadline.aborted
      ? "deadline"
      : error instanceof ResearchStop
        ? error.kind
        : stage === "inference"
          ? "provider-error"
          : "tool-error";
    const message =
      error instanceof ResearchStop
        ? error.message
        : kind === "deadline"
          ? "The shared planning deadline was reached."
          : kind === "provider-error"
            ? "The inference request did not complete."
            : "A planning tool could not complete.";
    result = finish([], message, kind, { kind, stage, message });
    trace(() =>
      turn?.recordError(error instanceof Error ? error : new Error(message)),
    );
  } finally {
    trace(() => {
      if (result) {
        turn?.record({
          outputMessages: [{ role: "assistant", content: result.message }],
        });
        turn?.setAttributes({
          "flowblock.result_source": result.source,
          "flowblock.plan_count": result.plans.length,
          "flowblock.termination": result.termination,
        });
      }
    });
    trace(() => turn?.end());
    trace(() => conversation?.end());
    if (traced && !deadline.aborted)
      await boundedTelemetry(() => weave.flushOTel(), deadline);
    scope.close();
  }
  result.latencyMs = Date.now() - started;
  return result;
}
