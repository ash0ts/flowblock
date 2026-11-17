import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { compilePlan, recipes, type PlanVersion } from "../../../src/domain";
import type { PlannerMessage } from "../../../src/server/planner";
import { createTasks, datasetVersion, sha256 } from "./fixtures";
import { gradePlan, provenUnsupported, type Task } from "./grade";
import { initialMessages, observeCompile, actionSchema } from "./planner";
import { search } from "./search";

const root = resolve(import.meta.dirname, "../../..");
export const runtimeFiles = [
  "training/experiments/next/fixtures.ts",
  "training/experiments/next/grade.ts",
  "training/experiments/next/search.ts",
  "training/experiments/next/planner.ts",
  "src/domain/index.ts",
  "src/domain/contracts.ts",
  "src/domain/defaults.ts",
  "src/domain/geometry.ts",
  "src/domain/engine.ts",
  "src/domain/take-analysis.ts",
  "src/server/planner.ts",
  "src/server/coordinator-runtime.ts",
  "package.json",
  "bun.lock",
];
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const jsonl = (values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\n") + "\n";
const action = (value: unknown): PlannerMessage => ({
  role: "assistant",
  content: JSON.stringify(actionSchema.parse(value)),
});
const observation = (plan: PlanVersion): PlannerMessage => ({
  role: "user",
  content: JSON.stringify({ observation: observeCompile(plan) }),
});
const compileAction = (plan: PlanVersion) =>
  action({
    action: "compile_candidate",
    recipeId: plan.recipeId,
    overrides: plan.overrides,
  });
const finishAction = (plan: PlanVersion) =>
  action({
    action: "finish",
    candidateIds: [plan.id],
    explanation:
      "This checked candidate preserves the requested movement, camera height, duration and framing against the supplied measurements. Confirm the framing and operator clearance on location.",
  });

export function teacherRows(task: Task) {
  const initial = initialMessages(task.input);
  const unsupported = provenUnsupported(task);
  const matchingRecipe = recipes.find(
    (recipe) => recipe.family === task.briefSpec.family,
  )!;
  const first = compilePlan(
    task.input.scene,
    task.input.gear,
    task.input.intent,
    matchingRecipe.id,
  );
  const rows: { messages: PlannerMessage[] }[] = [];
  const labels: { taskId: string; type: string; target: string }[] = [];
  const add = (messages: PlannerMessage[], type: string) => {
    rows.push({ messages });
    labels.push({
      taskId: task.id,
      type,
      target: JSON.parse(messages.at(-1)!.content).action,
    });
  };
  if (unsupported) {
    add([...initial, compileAction(first)], "checked-constraint-initial");
    add(
      [
        ...initial,
        compileAction(first),
        observation(first),
        action({
          action: "finish",
          candidateIds: [],
          explanation: unsupported,
        }),
      ],
      "checked-constraint-finish",
    );
    return {
      rows,
      labels,
      status: "hard-constraint",
      witnesses: 0,
      unsupported,
    };
  }
  const searched = search(task.input, {
    family: task.briefSpec.family,
    maxCandidates: 128,
  });
  const witnesses = searched.plans.filter(
    (plan) => gradePlan(task, plan).productive,
  );
  const plan = witnesses[0];
  if (!plan) return { rows, labels, status: "search-unresolved", witnesses: 0 };
  add([...initial, compileAction(plan)], "productive-initial");
  add(
    [...initial, compileAction(plan), observation(plan), finishAction(plan)],
    "productive-finish",
  );
  // Invalid geometry is context for a repair label, never the training target.
  const failed = !first.validation.valid
    ? first
    : compilePlan(
        task.input.scene,
        task.input.gear,
        task.input.intent,
        matchingRecipe.id,
        { distance: 0.25, height: task.input.intent.cameraHeight },
      );
  if (!failed.validation.valid) {
    const context = [...initial, compileAction(failed), observation(failed)];
    add([...context, compileAction(plan)], "failed-compile-repair");
    add(
      [...context, compileAction(plan), observation(plan), finishAction(plan)],
      "repair-finish",
    );
  }
  return {
    rows,
    labels,
    status: "productive-witness",
    witnesses: witnesses.length,
  };
}

async function build() {
  const output = resolve(process.argv[2] ?? "training/experiments/next/data");
  await mkdir(output, { recursive: false });
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      runtimeFiles.map(async (path) => [
        path,
        sha256(await readFile(resolve(root, path))),
      ]),
    ),
  );
  const sources = Object.fromEntries(
    await Promise.all(
      runtimeFiles.map(async (path) => [
        path,
        await readFile(resolve(root, path), "utf8"),
      ]),
    ),
  );
  const protocol = {
    schemaVersion: 1,
    experimentId: "flowblock-v2",
    createdAt: new Date().toISOString(),
    datasetVersion,
    sourceHashes,
    splits: {
      train: { groups: 64, seed: 2026102901 },
      development: { groups: 12, seed: 2026102902 },
      confirmation: { groups: 30, seed: 2026102903 },
    },
    grouping:
      "Six dependent movement tasks per independently generated scene. Uncertainty resamples scene groups, never treats six tasks as independent creators.",
    arms: ["library", "gpt-oss", "llama-base", "llama-sft"],
    controls: {
      toolActions: 6,
      repairs: 2,
      deadlineMs: 30000,
      maxOutputTokens: 1600,
      temperature: 0.1,
      concurrency: 2,
      deterministicSearchCandidates: 128,
    },
    endpoints: {
      primary:
        "One valid returned plan preserves source inputs, family, requested direction, nonzero travel, duration, height and sampled framing.",
      secondary: [
        "Admitted invalid plans",
        "Protocol completion",
        "Checked hard-constraint abstention",
        "False abstention on a known witness",
        "Availability",
        "Latency",
        "Reported token usage",
      ],
    },
    selection:
      "One SFT candidate, one epoch, fixed final positive checkpoint. Development is diagnostic and used for a deploy/no-deploy decision. No checkpoint shopping or confirmation-driven changes.",
    confirmation:
      "Run once per arm after the selection receipt freezes model, prompt, runtime and fixture hashes. Preserve failed requests and unattempted tasks. No rerun to improve the score.",
    budget: {
      authorizedUsd: 200,
      maxTrainingRuns: 1,
      maxTrainingExamples: 1600,
      maxInferenceRequests: 10000,
      inferenceReserveUsd: 20,
      trainingReserveUsd: 170,
      otherReserveUsd: 10,
    },
    pricing: {
      observedAt: "2026-10-29",
      inputOutputUsdPerMillion: {
        "openai/gpt-oss-20b": [0.03, 0.13],
        "meta-llama/Llama-3.1-8B-Instruct": [0.22, 0.22],
      },
      sftUsdPerActiveGpuHour: 2.7,
      sources: [
        "https://www.coreweave.com/forge-pricing/inference-agents",
        "https://www.coreweave.com/forge-pricing/post-training",
      ],
      billingCaveat:
        "Token estimates and published training rates are not an invoice. A client timeout does not cancel a server job.",
    },
    limitations: [
      "Authored synthetic scenes, not measured rooms or human cinematography ratings.",
      "All splits share a generator and engine; new geometry is not a new real-world population.",
      "The deterministic baseline receives the structured movement family and filters against the brief checker; it is a privileged upper reference, not a natural-language parser.",
      "A finite search without a witness is unresolved, not proof of infeasibility.",
      "The product GPT-OSS baseline uses its existing coordinator. Only base and trained Llama share the research prompt/tools for a training-effect comparison.",
      "Public video measurements cannot establish whether creators get a usable take faster.",
    ],
  };
  await writeFile(resolve(output, "protocol.json"), json(protocol));
  const allHashes = new Set<string>();
  for (const split of ["train", "development", "confirmation"] as const) {
    const directory = resolve(output, split);
    await mkdir(directory);
    const tasks = createTasks(
      split,
      protocol.splits[split].groups,
      protocol.splits[split].seed,
    );
    const sceneHashes = new Set(tasks.map((task) => task.geometryHash));
    for (const hash of sceneHashes) {
      if (allHashes.has(hash))
        throw new Error("Scene geometry crosses split boundaries.");
      allHashes.add(hash);
    }
    await writeFile(resolve(directory, "tasks.json"), json(tasks));
    await writeFile(resolve(directory, "protocol.json"), json(protocol));
    await writeFile(
      resolve(directory, "runtime.json"),
      json({ sourceHashes, sources }),
    );
    const paths = [
      { path: "tasks.json", role: "scenes" },
      { path: "protocol.json", role: "protocol" },
    ];
    const counts: Record<string, number> = {
      groups: sceneHashes.size,
      tasks: tasks.length,
    };
    if (split === "train") {
      const teachers = tasks.map(teacherRows);
      const rows = teachers.flatMap((result) => result.rows);
      if (!rows.length || rows.length > 1600)
        throw new Error("SFT row budget exceeded or empty.");
      await writeFile(resolve(directory, "actions.jsonl"), jsonl(rows));
      await writeFile(
        resolve(directory, "labels.json"),
        json(teachers.flatMap((result) => result.labels)),
      );
      await writeFile(
        resolve(directory, "teacher-audit.json"),
        json(
          teachers.map((result, index) => ({
            taskId: tasks[index].id,
            status: result.status,
            witnesses: result.witnesses,
            rows: result.rows.length,
          })),
        ),
      );
      paths.push(
        { path: "actions.jsonl", role: "training_actions" },
        { path: "labels.json", role: "metadata" },
        { path: "teacher-audit.json", role: "metadata" },
      );
      counts.trainingRows = rows.length;
      for (const label of teachers.flatMap((result) => result.labels))
        counts[label.type] = (counts[label.type] ?? 0) + 1;
    }
    const files = await Promise.all(
      paths.map(async (item) => ({
        ...item,
        sha256: sha256(await readFile(resolve(directory, item.path))),
        split,
        license: {
          id: "LicenseRef-FlowBlock-Authored",
          url: "https://github.com/ash0ts/flowblock",
          redistributionAllowed: true,
        },
      })),
    );
    await writeFile(
      resolve(directory, "manifest.json"),
      json({
        schemaVersion: 1,
        datasetId: `flowblock-scenes-${split}`,
        version: "v2",
        description: `FlowBlock authored synthetic ${split} scenes and declared brief constraints. No creator data.`,
        files,
        metadata: {
          kind: "authored-synthetic",
          splitUnit: "sceneGroup",
          counts,
          limitations: protocol.limitations,
        },
      }),
    );
    console.log(
      JSON.stringify({ split, counts, directory: relative(root, directory) }),
    );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  await build();
