/** Readback only: never executes a model or exports an application span. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as weave from "weave";
import { z } from "zod";

type Span = {
  span_id: string;
  trace_id: string;
  parent_span_id?: string | null;
  conversation_id: string;
  operation_name: string;
  started_at: string;
  ended_at?: string | null;
  status_code: string;
  agent_name: string;
  agent_version: string;
  request_model: string;
  provider_name: string;
  input_messages?: { role: string; content: string }[];
  output_messages?: { role: string; content: string }[];
  input_tokens: number;
  output_tokens: number;
  tool_name?: string;
  tool_call_arguments?: string;
  tool_call_result?: string;
  custom_attrs_string: Record<string, string>;
  custom_attrs_int: Record<string, number>;
};
type Attempt = {
  id: string;
  stage: string;
  attempt: number;
  status: string;
  parent_attempt_id?: string | null;
  job_id?: string | null;
  plan_id?: string | null;
  take_id?: string | null;
};
type Workflow = { id: string; attempts: Attempt[] };
type LocalResult = {
  events: { action: unknown; observation: unknown }[];
  message?: string;
  reason?: string;
  model?: string;
  plannerVersion?: string;
};
type ProxyCall = {
  index: number;
  stage: string;
  request: { body: { model: string; messages: unknown[] } };
  requestSha256: string;
  response?: {
    httpStatus: number;
    body: {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
  };
  responseSha256?: string;
};
const stringKeys = [
  "flowblock.workflow_id",
  "flowblock.stage",
  "flowblock.attempt_id",
  "flowblock.parent_attempt_id",
  "flowblock.job_id",
  "flowblock.plan_id",
  "flowblock.take_id",
  "flowblock.workflow_telemetry_version",
  "flowblock.stage_outcome",
  "flowblock.result_source",
  "flowblock.outcome",
  "flowblock.stop_reason",
  "flowblock.revised_plan_id",
  "flowblock.action_outcome",
  "inputHash",
  "parentPlanId",
  "jobId",
];
const intKeys = [
  "flowblock.attempt",
  "flowblock.queue_time_ms",
  "flowblock.job_age_at_start_ms",
  "flowblock.plan_count",
  "flowblock.rejected_actions",
  "flowblock.compile_checks",
  "flowblock.repair_search_compile_checks",
];
const spanFields: (keyof Span)[] = [
  "span_id",
  "trace_id",
  "parent_span_id",
  "conversation_id",
  "operation_name",
  "started_at",
  "ended_at",
  "status_code",
  "agent_name",
  "agent_version",
  "request_model",
  "provider_name",
  "input_messages",
  "output_messages",
  "input_tokens",
  "output_tokens",
  "tool_name",
  "tool_call_arguments",
  "tool_call_result",
  "custom_attrs_string",
  "custom_attrs_int",
];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function unwrap(
  value: unknown,
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const record = object(value);
  if (!record) return undefined;
  if (predicate(record)) return record;
  for (const key of ["result", "body", "workflow", "response"])
    if (record[key]) {
      const found = unwrap(record[key], predicate);
      if (found) return found;
    }
}
function parse(value: string | undefined): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    return undefined;
  }
}
function safe(value: unknown): unknown {
  if (typeof value === "string") {
    if (
      (process.env.WANDB_API_KEY &&
        value.includes(process.env.WANDB_API_KEY)) ||
      /(?:Bearer\s|Authorization\s*[:=]|X-Amz-Signature=|X-Goog-Signature=|[?&](?:token|signature|sig)=)/i.test(
        value,
      )
    )
      return `[redacted sha256=${hash(value)}]`;
    const decoded = parse(value);
    return object(decoded) || Array.isArray(decoded)
      ? JSON.stringify(safe(decoded))
      : value;
  }
  if (Array.isArray(value)) return value.map(safe);
  const record = object(value);
  if (record)
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        /^(?:authorization|api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|uploadUrl|downloadUrl|signedUrl|.*ObjectKey)$/i.test(
          key,
        )
          ? "[redacted]"
          : safe(item),
      ]),
    );
  return value;
}
function observedStatus(root: Span | undefined): string | undefined {
  const attrs = root?.custom_attrs_string ?? {};
  if (attrs["flowblock.stage_outcome"]) return attrs["flowblock.stage_outcome"];
  if (["completed", "revised"].includes(attrs["flowblock.outcome"]))
    return attrs["flowblock.result_source"] === "library"
      ? "needs_review"
      : "succeeded";
  if (
    ["partial", "checked_abstention", "fallback", "abstained"].includes(
      attrs["flowblock.outcome"],
    )
  )
    return "needs_review";
  return root?.status_code === "ERROR" ? "failed" : undefined;
}

export function reconcileWorkflow(
  workflow: Workflow,
  spans: Span[],
  totalCount: number,
) {
  const roots = spans.filter((span) => span.operation_name === "invoke_agent");
  const attempts = workflow.attempts.map((attempt) => {
    const group = spans.filter(
      (span) =>
        span.custom_attrs_string?.["flowblock.attempt_id"] === attempt.id,
    );
    const matchingRoots = group.filter(
      (span) => span.operation_name === "invoke_agent",
    );
    const root = matchingRoots[0];
    const ids = new Set(group.map((span) => span.span_id));
    const expected = {
      "flowblock.workflow_id": workflow.id,
      "flowblock.stage": attempt.stage,
      "flowblock.attempt_id": attempt.id,
      ...(attempt.parent_attempt_id
        ? { "flowblock.parent_attempt_id": attempt.parent_attempt_id }
        : {}),
      ...(attempt.job_id ? { "flowblock.job_id": attempt.job_id } : {}),
      ...(attempt.plan_id ? { "flowblock.plan_id": attempt.plan_id } : {}),
      ...(attempt.take_id ? { "flowblock.take_id": attempt.take_id } : {}),
    };
    const status = observedStatus(root);
    const checks = {
      oneStageRoot: matchingRoots.length === 1,
      attributesMatch:
        !!root &&
        Object.entries(expected).every(
          ([key, value]) => root.custom_attrs_string?.[key] === value,
        ),
      attemptNumberMatches:
        root?.custom_attrs_int?.["flowblock.attempt"] === attempt.attempt,
      stableAgentName: root?.agent_name === "FlowBlock workflow",
      allSpansEnded: group.length > 0 && group.every((span) => !!span.ended_at),
      parentLinks:
        !!root &&
        group
          .filter((span) => span !== root)
          .every(
            (span) =>
              span.trace_id === root.trace_id &&
              !!span.parent_span_id &&
              ids.has(span.parent_span_id),
          ),
      statusMatches:
        attempt.status === status ||
        (attempt.status === "failed" && status === "lease_lost"),
      propagatedContext:
        group.length > 0 &&
        group.every(
          (span) =>
            span.conversation_id === workflow.id &&
            span.custom_attrs_string?.["flowblock.stage"] === attempt.stage &&
            span.custom_attrs_string?.["flowblock.workflow_id"] === workflow.id,
        ),
    };
    return {
      id: attempt.id,
      stage: attempt.stage,
      attempt: attempt.attempt,
      persistedStatus: attempt.status,
      observedStatus: status ?? null,
      traceId: root?.trace_id ?? null,
      rootSpanId: root?.span_id ?? null,
      agentVersion: root?.agent_version ?? null,
      spanCount: group.length,
      modelCount: group.filter((span) => span.operation_name === "chat").length,
      toolCount: group.filter((span) => span.operation_name === "execute_tool")
        .length,
      checks,
      verified: Object.values(checks).every(Boolean),
    };
  });
  const checks = {
    conversationMatches:
      spans.length > 0 &&
      spans.every((span) => span.conversation_id === workflow.id),
    allSpansRetrieved: totalCount === spans.length,
    uniqueSpanIds:
      new Set(spans.map((span) => span.span_id)).size === spans.length,
    noUnmappedSpans: spans.every((span) =>
      workflow.attempts.some(
        (attempt) =>
          attempt.id === span.custom_attrs_string?.["flowblock.attempt_id"],
      ),
    ),
    allPersistedAttemptsMatch:
      attempts.length > 0 && attempts.every((attempt) => attempt.verified),
    noUnmappedRoots:
      roots.length === workflow.attempts.length &&
      roots.every((root) =>
        workflow.attempts.some(
          (attempt) =>
            attempt.id === root.custom_attrs_string?.["flowblock.attempt_id"],
        ),
      ),
  };
  return {
    verified: Object.values(checks).every(Boolean),
    checks,
    attempts,
    actualTraceIds: [...new Set(spans.map((span) => span.trace_id))],
  };
}

async function readCalls(directory: string): Promise<ProxyCall[]> {
  const calls: ProxyCall[] = [];
  for (const file of (await readdir(directory)).filter((file) =>
    /^\d+-request\.json$/.test(file),
  )) {
    const raw = await readFile(resolve(directory, file), "utf8");
    const request = JSON.parse(raw);
    const call: ProxyCall = {
      index: Number(file.split("-")[0]),
      stage: request.stage === "planner" ? "planning" : request.stage,
      request,
      requestSha256: hash(raw),
    };
    try {
      const response = await readFile(
        resolve(directory, file.replace("-request", "-response")),
        "utf8",
      );
      call.response = JSON.parse(response);
      call.responseSha256 = hash(response);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    calls.push(call);
  }
  return calls.sort((a, b) => a.index - b.index);
}
export function reconcileProvider(
  stage: string,
  spans: Span[],
  calls: ProxyCall[],
  local?: LocalResult,
) {
  const stageSpans = spans
    .filter((span) => span.custom_attrs_string?.["flowblock.stage"] === stage)
    .sort(
      (a, b) =>
        a.started_at.localeCompare(b.started_at) ||
        a.span_id.localeCompare(b.span_id),
    );
  const roots = stageSpans.filter(
    (span) => span.operation_name === "invoke_agent",
  );
  const models = stageSpans.filter((span) => span.operation_name === "chat");
  const tools = stageSpans.filter(
    (span) => span.operation_name === "execute_tool",
  );
  const stageCalls = calls.filter((call) => call.stage === stage);
  const callChecks = stageCalls.map((call, index) => {
    const span = models[index];
    const response = call.response;
    const checks = {
      requestModel: span?.request_model === call.request.body.model,
      inputMessages: isDeepStrictEqual(
        span?.input_messages?.map(({ role, content }) => ({ role, content })),
        call.request.body.messages,
      ),
      successfulResponse:
        !!response &&
        response.httpStatus >= 200 &&
        response.httpStatus < 300 &&
        span?.status_code !== "ERROR",
      output:
        !!response &&
        typeof response.body.choices?.[0]?.message?.content === "string" &&
        span?.output_messages?.length === 1 &&
        span.output_messages[0].content ===
          response.body.choices[0].message.content,
      inputTokens:
        typeof response?.body.usage?.prompt_tokens === "number" &&
        span?.input_tokens === response.body.usage.prompt_tokens,
      outputTokens:
        typeof response?.body.usage?.completion_tokens === "number" &&
        span?.output_tokens === response.body.usage.completion_tokens,
    };
    return {
      index: call.index,
      spanId: span?.span_id ?? null,
      requestSha256: call.requestSha256,
      responseSha256: call.responseSha256 ?? null,
      checks,
      verified: Object.values(checks).every(Boolean),
    };
  });
  const toolChecks = local?.events.map((event, index) => {
    const tool = tools[index];
    const args = parse(tool?.tool_call_arguments);
    return {
      spanId: tool?.span_id ?? null,
      argumentsMatch:
        isDeepStrictEqual(args, event.action) ||
        (tool?.tool_name?.startsWith("validate_") === true &&
          isDeepStrictEqual(object(args)?.received, event.action)),
      resultMatches: isDeepStrictEqual(
        parse(tool?.tool_call_result),
        event.observation,
      ),
      modelActionMatches: isDeepStrictEqual(
        parse(models[index]?.output_messages?.[0]?.content),
        event.action,
      ),
    };
  });
  const checks = {
    oneStageRoot: roots.length === 1,
    countMatches: stageCalls.length > 0 && stageCalls.length === models.length,
    providerMatches: models.every((span) => span.provider_name === "coreweave"),
    callsMatch: callChecks.every((call) => call.verified),
    ...(local
      ? {
          localToolCountMatches: tools.length === local.events.length,
          localToolsMatch: toolChecks!.every(
            (check) =>
              check.argumentsMatch &&
              check.resultMatches &&
              check.modelActionMatches,
          ),
          localModelMatches: roots[0]?.request_model === local.model,
          localRootOutputMatches:
            roots[0]?.output_messages?.[0]?.content ===
            (local.message ?? local.reason),
          ...(local.plannerVersion
            ? {
                plannerVersionMatches:
                  roots[0]?.agent_version === local.plannerVersion,
              }
            : {}),
        }
      : {}),
  };
  return {
    stage,
    checks,
    callChecks,
    toolChecks,
    verified: Object.values(checks).every(Boolean),
  };
}

async function main() {
  const flags = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        "--workflow",
        "--ledger",
        "--output",
        "--calls",
        "--planner",
        "--revision",
      ].includes(args[i]) ||
      !args[i + 1] ||
      flags.has(args[i])
    )
      throw new Error("Invalid arguments");
    flags.set(args[i], args[i + 1]);
  }
  const id = z.uuid().parse(flags.get("--workflow"));
  const ledgerRaw = await readFile(
    resolve(flags.get("--ledger") ?? ""),
    "utf8",
  );
  const workflow = unwrap(
    JSON.parse(ledgerRaw),
    (value) => value.id === id && Array.isArray(value.attempts),
  ) as Workflow | undefined;
  if (!workflow) throw new Error("Workflow ledger mismatch");
  const local: Record<string, LocalResult> = {};
  const sourceHashes: Record<string, string> = { ledger: hash(ledgerRaw) };
  for (const [flag, stage] of [
    ["--planner", "planning"],
    ["--revision", "revision"],
  ]) {
    const path = flags.get(flag);
    if (!path) continue;
    const raw = await readFile(resolve(path), "utf8");
    const parsed = unwrap(JSON.parse(raw), (value) =>
      Array.isArray(value.events),
    );
    if (!parsed) throw new Error("Missing local events");
    local[stage] = parsed as LocalResult;
    sourceHashes[stage] = hash(raw);
  }
  const calls = flags.has("--calls")
    ? await readCalls(resolve(flags.get("--calls")!))
    : undefined;
  if (!process.env.WANDB_API_KEY || !process.env.WANDB_ENTITY)
    throw new Error("Missing tracing configuration");
  const project = `${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT || "flowblock"}`;
  const output = resolve(
    flags.get("--output") ??
      `training/artifacts/workflow-readbacks/${id}/${new Date().toISOString().replaceAll(":", "-")}`,
  );
  await mkdir(output, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = new Date().toISOString();
  try {
    const client = await Promise.race([
      weave.init(project, { printCallLink: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Initialization timeout")),
          30_000,
        );
      }),
    ]);
    clearTimeout(timer);
    const { data, response } = await client.traceServerApi.agents.spans
      .query(
        {
          project_id: project,
          query: {
            $expr: {
              $eq: [{ $getField: "conversation_id" }, { $literal: id }],
            },
          },
          include_details: true,
          custom_attr_columns: [
            ...stringKeys.map((key) => ({
              source: "custom_attrs_string" as const,
              key,
            })),
            ...intKeys.map((key) => ({
              source: "custom_attrs_int" as const,
              key,
            })),
          ],
          sort_by: [{ field: "started_at", direction: "asc" }],
          limit: 500,
        },
        { timeout: 30_000, maxRetries: 0, signal: AbortSignal.timeout(30_000) },
      )
      .withResponse();
    const spans = data.spans.map((span) =>
      Object.fromEntries(
        spanFields
          .filter((key) => key in span)
          .map((key) => [key, span[key as keyof typeof span]]),
      ),
    ) as unknown as Span[];
    const report = reconcileWorkflow(workflow, spans, data.total_count);
    const provider = calls
      ? [...new Set(calls.map((call) => call.stage))].map((stage) =>
          reconcileProvider(stage, spans, calls, local[stage]),
        )
      : [];
    const verified =
      report.verified && provider.every((stage) => stage.verified);
    const url = `https://forge.coreweave.com/agent-lens/${project.split("/").map(encodeURIComponent).join("/")}/conversations/${id}`;
    const receipt = {
      startedAt,
      completedAt: new Date().toISOString(),
      readOnly: true,
      project,
      workflowId: id,
      status: verified ? "verified" : "needs_review",
      httpStatus: response.status,
      sourceHashes,
      ...report,
      verified,
      provider,
      modelInputsIndependentlyReconciled:
        !!calls &&
        provider.length > 0 &&
        provider.every((stage) => stage.verified),
      url,
      limitations: [
        "One persistent conversation groups separate stage traces; a shared OTel trace ID is not required.",
        "Missing or unknown-outcome spans remain discrepancies; no remote records are repaired.",
        ...(!calls
          ? [
              "Provider request/response snapshots were not supplied; model I/O is not independently reconciled.",
            ]
          : []),
      ],
    };
    await writeFile(
      resolve(output, "spans.json"),
      JSON.stringify(safe({ totalCount: data.total_count, spans }), null, 2) +
        "\n",
      { flag: "wx" },
    );
    await writeFile(
      resolve(output, "verification.json"),
      JSON.stringify(safe(receipt), null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        status: receipt.status,
        receipt: resolve(output, "verification.json"),
        spanCount: spans.length,
        attempts: report.attempts.map(({ stage, attempt, verified }) => ({
          stage,
          attempt,
          verified,
        })),
        url,
      }),
    );
    return verified ? 0 : 1;
  } catch (error) {
    const failure = {
      startedAt,
      completedAt: new Date().toISOString(),
      readOnly: true,
      status: "read_failed",
      workflowId: id,
      sourceHashes,
      errorType: error instanceof Error ? error.name : "Error",
    };
    await writeFile(
      resolve(output, "read-failure.json"),
      JSON.stringify(failure, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        status: "read_failed",
        receipt: resolve(output, "read-failure.json"),
      }),
    );
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((code) => process.exit(code))
    .catch(() => {
      console.error("Readback configuration or local receipts are invalid.");
      process.exit(1);
    });
