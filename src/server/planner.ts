import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import * as weave from "weave";
import {
  initializeWorkflowTelemetry,
  workflowAgentName,
  workflowAttributes,
  type WorkflowTraceContext,
} from "./workflow-telemetry";
import { PlanningActionSchema } from "./planner-actions";
import {
  allowedOverrides,
  compileFingerprint,
  intentMismatches,
  orbitDirectionContext,
  parameterUnits,
  recipeContext,
  searchBearingRepairs,
  validationGuidance,
} from "./planner-feedback";
import {
  beforeDeadline,
  boundedTelemetry,
  createDeadline,
  trace,
} from "./coordinator-runtime";
import {
  SceneSchema,
  GearSchema,
  IntentSchema,
  RecipeIdSchema,
  OverridesSchema,
  compilePlan,
  planShots,
  recipes,
  type PlanVersion,
} from "@/domain";
export const plannerVersion = "flowblock-planner-v1.5";
export const PlanningInputSchema = z
  .object({
    scene: SceneSchema,
    gear: GearSchema,
    intent: IntentSchema,
    prompt: z.string().max(4000).optional(),
  })
  .strict();
export type PlanningInput = z.infer<typeof PlanningInputSchema>;
export type PlannerMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type PlannerEvent = {
  action: unknown;
  observation: unknown;
  elapsedMs: number;
};
export type PlanningResult = {
  plans: PlanVersion[];
  source: "forge" | "library";
  message: string;
  traceId?: string;
  model?: string;
  events: PlannerEvent[];
  usage: { inputTokens: number; outputTokens: number };
  inputHash: string;
  plannerVersion: string;
  latencyMs: number;
  outcome?: "completed" | "checked_abstention" | "partial" | "fallback";
  stopReason?:
    | "completed"
    | "repair_budget"
    | "action_budget"
    | "provider_error"
    | "deadline"
    | "not_configured"
    | "unexpected_error";
};
export const systemPrompt = `You are FlowBlock's product-shot planning coordinator. Return exactly one JSON action per turn, no markdown. Never edit the scene, gear, or measurements. Use only the given recipes and their allowedOverrides, defaults, and parameterUnits. Preserve the requested movement family, direction, height, and duration. bearingDeg selects the viewing side (an orbit's midpoint bearing), not traversal direction. Its sign does not reverse an orbit. Orbit direction comes from the compiled signed sweep: positive means camera-right while facing the product, negative camera-left; reverse=true flips that sweep and traversal direction. A negative viewing bearing can preserve a positive camera-right sweep. When the brief explicitly permits changing the viewing side, that change is permitted; do not invent a prohibition or mislabel it as reversal. Check motion.orbit and the repair option's preservesSweep against the requested motion. A recipe height offset or reverse override can change that intent; inspect the defaults first. Do not substitute a static shot or another movement family without the creator explicitly choosing that compromise. Geometry validation is authoritative for the supplied measurements, but does not establish that the creative brief was preserved. Aim for up to three distinct feasible shots matching the brief. Use compile_candidate for each candidate and inspect its returned validation. After rejection, inspect any repairSearch options: the deterministic engine checked a bounded set of alternative bearings while retaining the recipe, source inputs, and other overrides. These suggestions are not selected candidates. Choose only an option that preserves the brief, explain the changed viewing side, and issue compile_candidate with its recipeId and overrides before finish. If no suggestion preserves the brief, give a qualified explanation instead of silently changing the move. Otherwise change a relevant allowed parameter using the observation; never repeat an identical rejected compile. You have an initial attempt and at most two repairs across invalid actions, invalid references, and rejected compiles. Never call an invalid plan safe. When finished return only candidate IDs you have compiled and validated, plus a concise explanation. An empty finish requires an actual compile check and means only that these checked candidates did not work; do not claim every possible move is impossible. At most six actions are available. For physical suggestions use hypotheses, never infer operator distance from video. Available actions:\n${JSON.stringify(z.toJSONSchema(PlanningActionSchema))}`;
export const telemetry = initializeWorkflowTelemetry;
export type ChatResult = {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
};
function distinctRecipePlans(candidates: Iterable<PlanVersion>): PlanVersion[] {
  const selected = new Map<string, PlanVersion>();
  for (const plan of candidates) {
    if (plan.validation.valid && !selected.has(plan.recipeId))
      selected.set(plan.recipeId, plan);
    if (selected.size === 3) break;
  }
  return [...selected.values()];
}
export async function chat(
  messages: PlannerMessage[],
  model: string,
  signal: AbortSignal,
): Promise<ChatResult> {
  const base =
    process.env.FLOWBLOCK_INFERENCE_URL || "https://api.inference.wandb.ai/v1";
  const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WANDB_API_KEY}`,
      "OpenAI-Project": `${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT || "flowblock"}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1600,
      temperature: 0.1,
      ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
    }),
  });
  if (!response.ok)
    throw new Error(`Inference returned HTTP ${response.status}`);
  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    },
  };
}
type PlannerOptions = {
  model?: string;
  deadlineMs?: number;
  chat?: typeof chat;
  trace?: boolean;
  workflowTrace?: WorkflowTraceContext;
};
export async function runPlanner(
  raw: PlanningInput,
  options: PlannerOptions = {},
): Promise<PlanningResult> {
  return weave.runIsolated(() => runPlannerIsolated(raw, options));
}
async function runPlannerIsolated(
  raw: PlanningInput,
  options: PlannerOptions,
): Promise<PlanningResult> {
  const started = Date.now();
  const input = PlanningInputSchema.parse(raw);
  const inputHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const scope = createDeadline(options.deadlineMs, started);
  const deadline = scope.signal;
  const base = {
    inputHash,
    plannerVersion,
    events: [] as PlannerEvent[],
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 0,
  };
  const model =
    options.model || process.env.FLOWBLOCK_MODEL || "openai/gpt-oss-20b";
  let traced = false;
  let conversation: ReturnType<typeof weave.startConversation> | undefined;
  let turn:
    | ReturnType<ReturnType<typeof weave.startConversation>["startTurn"]>
    | undefined;
  let stopReason: NonNullable<PlanningResult["stopReason"]> =
    "unexpected_error";
  let repairs = 0;
  let compileChecks = 0;
  let repairSearchCompileChecks = 0;
  const candidates = new Map<string, PlanVersion>();
  const rejectedCompiles = new Map<string, Record<string, unknown>>();
  const rejectedCandidates = new Map<string, Record<string, unknown>>();
  const eligibleCandidates = () =>
    [...candidates.values()].filter((plan) => !rejectedCandidates.has(plan.id));
  const fallback = (message: string): PlanningResult => ({
    ...base,
    plans: planShots(input.scene, input.gear, input.intent)
      .filter((p) => p.validation.valid)
      .slice(0, 3),
    source: "library",
    outcome: "fallback",
    stopReason,
    message,
    model,
    traceId: conversation?.conversationId,
    latencyMs: Date.now() - started,
  });
  const budgetResult = (
    reason: "repair_budget" | "action_budget",
  ): PlanningResult => {
    stopReason = reason;
    const plans = distinctRecipePlans(eligibleCandidates());
    const limit = reason === "repair_budget" ? "repair" : "action";
    if (!plans.length)
      return fallback(
        `The planner reached its ${limit} budget without a validated candidate. These options come from the local recipe library; they are not a completed agent plan.`,
      );
    return {
      ...base,
      plans,
      source: "forge",
      outcome: "partial",
      stopReason,
      message: `The planner reached its ${limit} budget. These earlier agent-compiled options passed validation against your supplied measurements, but the agent did not select them as its final answer. Planning is incomplete; review their movement and tradeoffs before rehearsing.`,
      model,
      traceId: conversation?.conversationId,
      latencyMs: Date.now() - started,
    };
  };
  const messages: PlannerMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: JSON.stringify({
        ...input,
        parameterUnits,
        recipes: recipeContext(input.intent),
      }),
    },
  ];
  type Tool = ReturnType<NonNullable<typeof turn>["startTool"]>;
  const record = (
    action: unknown,
    observation: unknown,
    tool?: Tool,
    rejected = false,
  ) => {
    base.events.push({ action, observation, elapsedMs: Date.now() - started });
    trace(() =>
      tool?.setAttributes({
        "flowblock.action_outcome": rejected ? "rejected" : "accepted",
      }),
    );
    trace(() => tool?.end({ result: JSON.stringify(observation) }));
    messages.push({ role: "user", content: JSON.stringify({ observation }) });
  };
  const reject = (
    action: unknown,
    detail: Record<string, unknown>,
    tool?: Tool,
  ) => {
    repairs += 1;
    const observation = {
      ...detail,
      rejected: true,
      repairBudget: {
        rejectedAttempts: repairs,
        remaining: Math.max(0, 3 - repairs),
        exhausted: repairs > 2,
      },
    };
    record(action, observation, tool, true);
    return repairs > 2 ? budgetResult("repair_budget") : undefined;
  };
  const execute = async (): Promise<PlanningResult> => {
    if (!process.env.WANDB_API_KEY && !options.chat) {
      stopReason = "not_configured";
      return fallback(
        "Using the local recipe library. Forge generation is not configured.",
      );
    }
    traced =
      options.trace !== false && (await boundedTelemetry(telemetry, deadline));
    if (deadline.aborted) throw deadline.reason;
    conversation = traced
      ? trace(() =>
          weave.startConversation({
            agentName: options.workflowTrace
              ? workflowAgentName
              : "FlowBlock planner",
            agentVersion: plannerVersion,
            model,
            conversationId: options.workflowTrace?.workflowId ?? randomUUID(),
            attributes: {
              ...(options.workflowTrace
                ? workflowAttributes(options.workflowTrace)
                : {}),
              inputHash,
              "flowblock.telemetry_version": "agent-lens-v1",
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
      if (deadline.aborted) throw deadline.reason;
      const llm = trace(() =>
        turn?.startLLM({ model, providerName: "coreweave" }),
      );
      const requestMessages = messages.map((message) => ({ ...message }));
      let response: ChatResult;
      try {
        trace(() => {
          if (llm) llm.inputMessages = requestMessages;
        });
        response = await beforeDeadline(
          () => (options.chat || chat)(requestMessages, model, deadline),
          deadline,
        );
        trace(() => {
          llm?.output(response.content);
          llm?.record({ usage: response.usage });
        });
      } catch (error) {
        stopReason = deadline.aborted ? "deadline" : "provider_error";
        trace(() =>
          llm?.setAttributes({ "flowblock.stop_reason": stopReason }),
        );
        trace(() =>
          llm?.recordError(
            error instanceof Error ? error : new Error("Inference failed"),
          ),
        );
        throw error;
      } finally {
        trace(() => llm?.end());
      }
      base.usage.inputTokens += response.usage.inputTokens;
      base.usage.outputTokens += response.usage.outputTokens;
      messages.push({ role: "assistant", content: response.content });
      let rawAction: unknown = { rawResponse: response.content };
      let action: z.infer<typeof PlanningActionSchema>;
      try {
        rawAction = JSON.parse(response.content);
        action = PlanningActionSchema.parse(rawAction);
      } catch (error) {
        const tool = trace(() =>
          turn?.startTool({
            name: "validate_action",
            args: JSON.stringify({ received: rawAction }),
          }),
        );
        const result = reject(
          rawAction,
          {
            error: "invalid_action",
            message:
              "Return one planning JSON action matching the schema. Revision actions require a saved take and are unavailable here.",
            issues:
              error instanceof z.ZodError
                ? error.issues.map(({ code, path, message }) => ({
                    code,
                    path,
                    message,
                  }))
                : [
                    {
                      code: "invalid_json",
                      path: [],
                      message: "The model response is not valid JSON.",
                    },
                  ],
          },
          tool,
        );
        if (result) return result;
        continue;
      }
      const tool = trace(() =>
        turn?.startTool({ name: action.action, args: JSON.stringify(action) }),
      );
      try {
        switch (action.action) {
          case "list_recipes":
            record(
              action,
              { recipes: recipeContext(input.intent), parameterUnits },
              tool,
            );
            break;
          case "compile_candidate": {
            const key = compileFingerprint(action.recipeId, action.overrides);
            const previous = rejectedCompiles.get(key);
            if (previous) {
              const result = reject(
                action,
                {
                  error: "no_progress",
                  message:
                    "This identical compile was already rejected. No new compile was run. Change a relevant allowed parameter while preserving the brief, or explain the checked constraint.",
                  previousRejection: previous,
                },
                tool,
              );
              if (result) return result;
              break;
            }
            const recipe = recipes.find((item) => item.id === action.recipeId)!;
            const allowed = allowedOverrides(recipe);
            const unused = Object.keys(action.overrides ?? {}).filter(
              (key) =>
                !allowed.includes(
                  key as keyof NonNullable<typeof action.overrides>,
                ),
            );
            if (unused.length) {
              const observation = {
                error: "irrelevant_override",
                recipeId: recipe.id,
                family: recipe.family,
                fields: unused.map((field) => ({
                  path: ["overrides", field],
                  message: `Remove ${field}; it does not affect this recipe.`,
                })),
                allowedOverrides: allowed,
                parameterUnits,
              };
              rejectedCompiles.set(key, observation);
              const result = reject(action, observation, tool);
              if (result) return result;
              break;
            }
            const p = compilePlan(
              input.scene,
              input.gear,
              input.intent,
              action.recipeId,
              action.overrides,
            );
            compileChecks += 1;
            candidates.set(p.id, p);
            const observation = {
              candidateId: p.id,
              recipeId: p.recipeId,
              family: p.family,
              validation: p.validation,
              framing: p.framing,
              cameraHeight: p.cameraHeight,
              durationSeconds: p.durationSeconds,
              motion: {
                kind: p.path.kind,
                arcLengthMeters: p.arcLength,
                sweepDegrees: (p.path.sweepAngle * 180) / Math.PI,
                orbit: orbitDirectionContext(p),
                start: p.path.start,
                end: p.path.end,
                startDistanceMeters: p.keyframes[0].distance,
                endDistanceMeters: p.keyframes.at(-1)!.distance,
              },
              briefCheck:
                "Geometry does not establish creative intent. Compare the actual family, direction, height, duration, and framing with the request before finishing.",
            };
            const mismatches = intentMismatches(p, input.intent);
            if (mismatches.length || !p.validation.valid) {
              const repairSearch = mismatches.length
                ? undefined
                : searchBearingRepairs(p);
              repairSearchCompileChecks += repairSearch?.compileChecks ?? 0;
              const rejected = {
                ...observation,
                error: mismatches.length
                  ? "intent_mismatch"
                  : "validation_rejected",
                ...(mismatches.length
                  ? {
                      fields: mismatches,
                      requiredOverrides: Object.fromEntries(
                        mismatches.map(({ override, requested }) => [
                          override,
                          requested,
                        ]),
                      ),
                      message:
                        "Preserve the supplied camera height and duration. Compile the same recipe with these required overrides; a recipe default offset is not permission to change the setup.",
                    }
                  : {}),
                repairGuidance: validationGuidance(p),
                ...(repairSearch ? { repairSearch } : {}),
              };
              rejectedCompiles.set(key, rejected);
              rejectedCandidates.set(p.id, rejected);
              const result = reject(action, rejected, tool);
              if (result) return result;
            } else record(action, observation, tool);
            break;
          }
          case "validate_candidate": {
            const p = candidates.get(action.candidateId);
            if (!p || !p.validation.valid || rejectedCandidates.has(p.id)) {
              const result = reject(
                action,
                {
                  error: p ? "candidate_not_valid" : "unknown_candidate",
                  candidateId: action.candidateId,
                  ...(p ? { validation: p.validation } : {}),
                  ...(p && rejectedCandidates.has(p.id)
                    ? { rejection: rejectedCandidates.get(p.id) }
                    : {}),
                  message: p
                    ? "This candidate remains invalid. Change the parameters and compile again."
                    : "Use a candidate ID returned by compile_candidate.",
                },
                tool,
              );
              if (result) return result;
            } else
              record(
                action,
                { candidateId: p.id, validation: p.validation },
                tool,
              );
            break;
          }
          case "finish": {
            const invalid = action.candidateIds.filter(
              (id) =>
                !candidates.get(id)?.validation.valid ||
                rejectedCandidates.has(id),
            );
            if (
              invalid.length ||
              (!action.candidateIds.length && !compileChecks)
            ) {
              const error = invalid.length
                ? "invalid_finish_reference"
                : "unchecked_abstention";
              const result = reject(
                action,
                {
                  error,
                  candidateIds: invalid,
                  compileChecks,
                  validCandidateIds: distinctRecipePlans(
                    eligibleCandidates(),
                  ).map((p) => p.id),
                  message: invalid.length
                    ? "Finish referenced unknown or invalid candidates. Return validated candidate IDs only."
                    : "Compile a candidate before declaring that no plan was found.",
                },
                tool,
              );
              if (result) return result;
              break;
            }
            const plans = distinctRecipePlans(
              action.candidateIds.flatMap((id) => candidates.get(id) ?? []),
            );
            const message = plans.length
              ? action.explanation
              : `No plan was selected after ${compileChecks} compile checks. These checks do not prove all possible moves infeasible. Planner explanation: ${action.explanation}`;
            stopReason = "completed";
            record(
              action,
              { accepted: plans.map((p) => p.id), compileChecks },
              tool,
            );
            return {
              ...base,
              plans,
              source: "forge",
              outcome: plans.length ? "completed" : "checked_abstention",
              stopReason,
              message,
              traceId: conversation?.conversationId,
              model,
              latencyMs: Date.now() - started,
            };
          }
        }
      } catch (error) {
        base.events.push({
          action,
          observation: {
            error: "tool_failed",
            message: error instanceof Error ? error.message : "Tool failed",
          },
          elapsedMs: Date.now() - started,
        });
        trace(() =>
          tool?.end({
            error: error instanceof Error ? error : new Error("Tool failed"),
          }),
        );
        throw error;
      }
    }
    return budgetResult("action_budget");
  };
  let result: PlanningResult;
  try {
    result = await execute();
  } catch (error) {
    if (deadline.aborted) stopReason = "deadline";
    console.warn(
      "Planner failure:",
      error instanceof Error ? error.message : "Unknown error",
    );
    trace(() =>
      turn?.recordError(
        error instanceof Error ? error : new Error("Planner failed"),
      ),
    );
    result = fallback(
      "Forge generation could not finish. Your setup is preserved; these options come from the local recipe library.",
    );
  } finally {
    try {
      trace(() => {
        if (result) {
          turn?.record({
            outputMessages: [{ role: "assistant", content: result.message }],
          });
          turn?.setAttributes({
            "flowblock.result_source": result.source,
            "flowblock.plan_count": result.plans.length,
            "flowblock.outcome": result.outcome,
            "flowblock.stop_reason": result.stopReason,
            "flowblock.rejected_actions": repairs,
            "flowblock.compile_checks": compileChecks,
            "flowblock.repair_search_compile_checks": repairSearchCompileChecks,
          });
        }
      });
      trace(() => turn?.end());
      trace(() => conversation?.end());
      if (traced && !deadline.aborted)
        await boundedTelemetry(() => weave.flushOTel(), deadline);
    } finally {
      scope.close();
    }
  }
  result.latencyMs = Date.now() - started;
  return result;
}
export function recompilePlan(raw: unknown): PlanVersion {
  const source = z
    .object({
      scene: SceneSchema,
      gear: GearSchema,
      intent: IntentSchema,
      recipeId: RecipeIdSchema,
      overrides: OverridesSchema.optional(),
    })
    .passthrough()
    .parse(raw);
  return compilePlan(
    source.scene,
    source.gear,
    source.intent,
    source.recipeId,
    source.overrides,
  );
}
