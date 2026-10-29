import "./env";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  defaultScene,
  defaultGear,
  defaultIntent,
  compilePlan,
  TakeAnalysisSchema,
} from "../src/domain";
const base = process.env.APP_URL || "http://127.0.0.1:3037";
async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers: { Origin: base, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const plan = compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold");
const video = await readFile("worker/artifacts/synthetic/synthetic-bottle.mp4");
const upload = await request("uploads", {
  fileName: "synthetic-smoke-bottle.mp4",
  contentType: "video/mp4",
  sizeBytes: video.byteLength,
  plan,
});
const bytes = await fetch(upload.uploadUrl, {
  method: "PUT",
  headers: { ...upload.headers, Origin: base },
  body: video,
});
if (!bytes.ok) throw new Error(`Upload returned ${bytes.status}`);
await request(`uploads/${upload.takeId}/complete`, {});
const job = await request(`takes/${upload.takeId}/analyze`, {
  seed: {
    timeSeconds: 2.466666666666667,
    box: {
      x: 0.43125,
      y: 0.2388888888888889,
      width: 0.128125,
      height: 0.5555555555555556,
    },
  },
  expectedVisible: { startSeconds: 0, endSeconds: 5 },
});
console.log(
  JSON.stringify({
    takeId: upload.takeId,
    jobId: job.jobId,
    status: job.status,
  }),
);
for (let i = 0; i < 180; i++) {
  const state = await request(`jobs/${job.jobId}`, undefined, "GET");
  if (state.status === "failed" || state.status === "cancelled")
    throw new Error(JSON.stringify(state));
  if (state.result) {
    const analysis = TakeAnalysisSchema.parse(state.result);
    const media = await fetch(
      `${base}/api/takes/${upload.takeId}/media?artifact=proxy`,
      { headers: { Range: "bytes=0-1023" } },
    );
    await mkdir(".data", { recursive: true });
    await writeFile(
      ".data/smoke-media.json",
      JSON.stringify(
        { plan, analysis, status: state.status, mediaStatus: media.status },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {
          status: state.status,
          realInference: analysis.provenance.realInference,
          device: analysis.provenance.device,
          coverage: analysis.coverage,
          findings: analysis.findings,
          mediaStatus: media.status,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error("Timed out waiting for local analysis");
