import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PlannerMessage } from "../src/server/planner";
import { loadEvaluationRuntime } from "./runtime";

const {
  runtime: { plannerVersion, systemPrompt },
  domain: { AgentActionSchema, compilePlan, recipes, schemaVersion },
  fixtures: { createFixtures, digest, fixtureVersion },
} = await loadEvaluationRuntime("frozen-v1");

const directory = resolve("training/frozen");
await mkdir(directory, { recursive: true });
async function freeze(name: string, content: string) {
  const path = resolve(directory, name);
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing !== null && existing !== content)
    throw new Error(
      `Refusing to overwrite frozen ${name}. Create a new fixture version for changed inputs.`,
    );
  if (existing === null) await writeFile(path, content, { flag: "wx" });
}
const fixtures = createFixtures();
const rows: { messages: PlannerMessage[] }[] = [];
const labels: unknown[] = [];
for (const fixture of fixtures.filter((f) => f.split === "train")) {
  const messages: PlannerMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: JSON.stringify({
        ...fixture.input,
        recipes: recipes.map(({ id, family, name }) => ({ id, family, name })),
      }),
    },
  ];
  if (fixture.oracle.feasible && fixture.oracle.recipeId) {
    const action = AgentActionSchema.parse({
      action: "compile_candidate",
      recipeId: fixture.oracle.recipeId,
      overrides: fixture.oracle.overrides,
    });
    const candidate = compilePlan(
      fixture.input.scene,
      fixture.input.gear,
      fixture.input.intent,
      fixture.oracle.recipeId,
      fixture.oracle.overrides,
    );
    if (
      !candidate.validation.valid ||
      candidate.family !== fixture.expectedFamily
    )
      throw new Error(`Oracle review failed for ${fixture.id}`);
    messages.push({ role: "assistant", content: JSON.stringify(action) });
    rows.push({ messages: [...messages] });
    messages.push({
      role: "user",
      content: JSON.stringify({
        observation: {
          candidateId: candidate.id,
          recipeId: candidate.recipeId,
          validation: candidate.validation,
          framing: candidate.framing,
          durationSeconds: candidate.durationSeconds,
        },
      }),
    });
    messages.push({
      role: "assistant",
      content: JSON.stringify({
        action: "finish",
        candidateIds: [candidate.id],
        explanation: `${candidate.name} matches the requested ${fixture.expectedFamily} movement and is valid against the measured geometry. Rehearse and check unmeasured objects.${fixture.expectedFamily === "reveal" ? " Foreground occlusion timing still needs a separate visibility check." : ""}`,
      }),
    });
    rows.push({ messages: [...messages] });
    labels.push({
      fixtureId: fixture.id,
      candidateId: candidate.id,
      review: "deterministic solver reviewed, not human rated",
      valid: true,
      family: candidate.family,
    });
  } else {
    messages.push({
      role: "assistant",
      content: JSON.stringify({
        action: "finish",
        candidateIds: [],
        explanation:
          "The checked recipe options do not meet the requested movement and current constraints. Adjust the measured setup or request another movement; I have not substituted a static shot.",
      }),
    });
    rows.push({ messages });
    labels.push({
      fixtureId: fixture.id,
      candidateId: null,
      review:
        "fixed finite recipe search found no valid candidate; not proof of global infeasibility",
    });
  }
}
if (rows.length > 400)
  throw new Error("The authorized training budget is at most 400 examples.");
for (const row of rows)
  AgentActionSchema.parse(JSON.parse(row.messages.at(-1)!.content));
const serializedFixtures = `${JSON.stringify(fixtures, null, 2)}\n`;
const serializedRows = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const files = {
  "fixtures.json": serializedFixtures,
  "train.jsonl": serializedRows,
  "labels.json": `${JSON.stringify(labels, null, 2)}\n`,
  "system-prompt.txt": `${systemPrompt}\n`,
};
for (const [name, content] of Object.entries(files))
  await freeze(name, content);
const manifest = {
  fixtureVersion,
  schemaVersion,
  plannerVersion,
  splitUnit: "scene geometry",
  counts: {
    trainScenes: 24,
    devScenes: 6,
    testScenes: 12,
    trainTasks: 144,
    devTasks: 36,
    testTasks: 72,
    trainingRows: rows.length,
  },
  files: Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, digest(content)]),
  ),
  systemPromptSha256: digest(systemPrompt),
  qualificationTaskIds: fixtures
    .filter((f) => f.split === "test")
    .slice(0, 12)
    .map((f) => f.id),
  disclosure:
    "Synthetic fixtures and solver-selected labels. Test geometry groups are disjoint from train/dev. No measured training outcome is implied.",
};
await freeze("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest.counts)}\n`);
