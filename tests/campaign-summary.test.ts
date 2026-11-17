import { describe, expect, it } from "vitest";
import {
  CampaignSummarySchema,
  readCampaignSummary,
} from "../src/server/campaign-summary";

describe("recorded campaign snapshot", () => {
  it("loads the installed evidence without treating it as live project status", () => {
    const snapshot = readCampaignSummary();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.access).toBe("private");
    expect(snapshot?.project).toBe("wandb/flowblock");
  });

  it.each([
    "javascript:alert(1)",
    "https://forge.coreweave.com.evil.example/wandb/wandb/flowblock/runs/test",
    "https://forge.coreweave.com/wandb/another/project/runs/test",
    "https://forge.coreweave.com/wandb/wandb/flowblock/runs/test?X-Amz-Signature=secret",
  ])("rejects an unsafe or unrelated evidence link: %s", (url) => {
    const snapshot = structuredClone(readCampaignSummary()!);
    snapshot.evidence[0].url = url;
    expect(CampaignSummarySchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects impossible result denominators", () => {
    const snapshot = structuredClone(readCampaignSummary()!);
    snapshot.results[0].productive = snapshot.results[0].available + 1;
    expect(CampaignSummarySchema.safeParse(snapshot).success).toBe(false);
  });
});
