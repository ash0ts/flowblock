import { readFile } from "node:fs/promises";
import path from "node:path";

export { readCampaignSummary } from "./campaign-summary";

export async function readTrainingSummary(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await readFile(
        path.join(process.cwd(), "training/results/summary.json"),
        "utf8",
      ),
    );
  } catch {
    return {
      status: "not_available",
      message: "No recorded training summary is installed.",
    };
  }
}

export function weaveProjectUrl(): string | undefined {
  const entity = process.env.WANDB_ENTITY;
  if (!entity) return undefined;
  return `https://forge.coreweave.com/wandb/${encodeURIComponent(entity)}/${encodeURIComponent(process.env.WANDB_PROJECT || "flowblock")}/weave`;
}

export function forgeDashboardLinks() {
  const entity = process.env.WANDB_ENTITY;
  if (!entity) return undefined;
  const project = encodeURIComponent(process.env.WANDB_PROJECT || "flowblock");
  const organization = encodeURIComponent(entity);
  const projectUrl = `https://forge.coreweave.com/wandb/${organization}/${project}`;
  return {
    agentLens: `https://forge.coreweave.com/agent-lens/${organization}/${project}`,
    evaluations: `${projectUrl}/weave/evaluations`,
    models: `${projectUrl}/workspace`,
    inference: "https://forge.coreweave.com/wandb/inference",
  };
}
