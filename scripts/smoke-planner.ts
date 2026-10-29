import "./env";
import { mkdir, writeFile } from "node:fs/promises";
import { runPlanner } from "../src/server/planner";
import { defaultScene, defaultGear, defaultIntent } from "../src/domain";
const result = await runPlanner({
  scene: defaultScene,
  gear: defaultGear,
  intent: defaultIntent,
  prompt:
    "Choose one calm orbit of the product. Compile the quarter-orbit recipe, inspect validation, then finish with its candidate ID.",
});
await mkdir(".data", { recursive: true });
await writeFile(".data/smoke-planner.json", JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      source: result.source,
      plans: result.plans.map((p) => ({
        name: p.name,
        valid: p.validation.valid,
      })),
      traceId: result.traceId,
      actions: result.events.length,
      latencyMs: result.latencyMs,
      usage: result.usage,
      message: result.message,
    },
    null,
    2,
  ),
);
