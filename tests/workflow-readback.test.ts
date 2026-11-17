import { describe, expect, it } from "vitest";
import {
  reconcileProvider,
  reconcileWorkflow,
} from "../training/read-workflow";

type Span = Parameters<typeof reconcileWorkflow>[1][number];
type Workflow = Parameters<typeof reconcileWorkflow>[0];
const workflowId = "10000000-0000-4000-8000-000000000001";
const planningId = "10000000-0000-4000-8000-000000000002";
const analysisId = "10000000-0000-4000-8000-000000000003";
function fixture() {
  const workflow: Workflow = {
    id: workflowId,
    attempts: [
      { id: planningId, stage: "planning", attempt: 1, status: "succeeded" },
      {
        id: analysisId,
        stage: "analysis",
        attempt: 1,
        status: "needs_review",
        parent_attempt_id: planningId,
      },
    ],
  };
  const spans: Span[] = workflow.attempts.flatMap((attempt, index) => {
    const root: Span = {
      span_id: `root-${index}`,
      trace_id: `trace-${index}`,
      conversation_id: workflowId,
      operation_name: "invoke_agent",
      started_at: `2026-10-30T00:00:0${index}.000Z`,
      ended_at: `2026-10-30T00:00:0${index}.100Z`,
      status_code: "OK",
      agent_name: "FlowBlock workflow",
      agent_version: "version",
      request_model: "model",
      provider_name: "coreweave",
      input_tokens: 0,
      output_tokens: 0,
      custom_attrs_string: {
        "flowblock.workflow_id": workflowId,
        "flowblock.stage": attempt.stage,
        "flowblock.attempt_id": attempt.id,
        "flowblock.stage_outcome": attempt.status,
        ...(attempt.parent_attempt_id
          ? { "flowblock.parent_attempt_id": attempt.parent_attempt_id }
          : {}),
      },
      custom_attrs_int: { "flowblock.attempt": attempt.attempt },
    };
    return [
      root,
      {
        ...root,
        span_id: `child-${index}`,
        parent_span_id: root.span_id,
        operation_name: "execute_tool",
      },
    ];
  });
  return { workflow, spans };
}

describe("read-only workflow reconciliation", () => {
  it("accepts separate real stage traces grouped in one conversation", () => {
    const { workflow, spans } = fixture();
    const result = reconcileWorkflow(workflow, spans, spans.length);
    expect(result.verified).toBe(true);
    expect(result.actualTraceIds).toEqual(["trace-0", "trace-1"]);
    expect(result.attempts.map((attempt) => attempt.observedStatus)).toEqual([
      "succeeded",
      "needs_review",
    ]);
  });

  it("does not turn missing, unfinished, or contradictory attempts into success", () => {
    for (const change of [
      (spans: Span[]) => spans.splice(2),
      (spans: Span[]) => {
        spans[2].ended_at = null;
      },
      (spans: Span[]) => {
        spans[2].custom_attrs_string["flowblock.stage_outcome"] = "succeeded";
      },
      (spans: Span[]) => {
        spans[3].parent_span_id = "absent";
      },
      (spans: Span[]) => {
        spans[3].conversation_id = "different";
      },
      (spans: Span[]) => {
        spans[3].trace_id = "incorrect";
      },
    ]) {
      const { workflow, spans } = fixture();
      change(spans);
      expect(reconcileWorkflow(workflow, spans, spans.length).verified).toBe(
        false,
      );
    }
  });

  it("rejects pagination gaps, duplicate spans, and unmatched child attempts", () => {
    const { workflow, spans } = fixture();
    expect(reconcileWorkflow(workflow, spans, spans.length + 1).verified).toBe(
      false,
    );
    expect(
      reconcileWorkflow(workflow, [...spans, spans[1]], spans.length + 1)
        .verified,
    ).toBe(false);
    const orphan = {
      ...spans[1],
      span_id: "orphan",
      custom_attrs_string: {
        ...spans[1].custom_attrs_string,
        "flowblock.attempt_id": "unknown",
      },
    };
    expect(
      reconcileWorkflow(workflow, [...spans, orphan], spans.length + 1)
        .verified,
    ).toBe(false);
  });

  it("matches provider snapshots and received wrappers for invalid typed actions", () => {
    const { spans } = fixture();
    const root = {
      ...spans[0],
      output_messages: [{ role: "assistant", content: "Inspect this outcome" }],
    };
    const input = [{ role: "user", content: "A product shot" }];
    const model: Span = {
      ...spans[1],
      span_id: "model",
      operation_name: "chat",
      input_messages: input,
      output_messages: [{ role: "assistant", content: "{}" }],
      input_tokens: 10,
      output_tokens: 2,
    };
    const tool: Span = {
      ...spans[1],
      span_id: "tool",
      tool_name: "validate_planner_action",
      tool_call_arguments: JSON.stringify({ received: {} }),
      tool_call_result: JSON.stringify({ status: "invalid" }),
    };
    const calls: Parameters<typeof reconcileProvider>[2] = [
      {
        index: 1,
        stage: "planning",
        requestSha256: "request-hash",
        responseSha256: "response-hash",
        request: { body: { model: "model", messages: input } },
        response: {
          httpStatus: 200,
          body: {
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          },
        },
      },
    ];
    const local = {
      model: "model",
      plannerVersion: "version",
      message: "Inspect this outcome",
      events: [{ action: {}, observation: { status: "invalid" } }],
    };
    expect(
      reconcileProvider("planning", [root, model, tool], calls, local).verified,
    ).toBe(true);
    const changed = structuredClone(calls);
    changed[0].request.body.messages = [
      { role: "user", content: "Mutated after send" },
    ];
    expect(
      reconcileProvider("planning", [root, model, tool], changed, local)
        .verified,
    ).toBe(false);
    const wrongUsage = structuredClone(calls);
    wrongUsage[0].response!.body.usage!.completion_tokens = 3;
    expect(
      reconcileProvider("planning", [root, model, tool], wrongUsage, local)
        .verified,
    ).toBe(false);
  });
});
