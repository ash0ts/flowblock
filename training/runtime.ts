import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const comparedPaths = [
  "src/server/planner.ts",
  "src/domain/engine.ts",
  "src/domain/contracts.ts",
  "training/evaluation.ts",
];
type SourceEntry = {
  originalPath: string;
  evaluatedPath: string;
  originalSha256: string;
  snapshotPath: string;
  snapshotSha256: string;
  importRewrites: { from: string; to: string; count: number }[];
};

export async function verifyFrozenSources() {
  const bytes = await readFile(
    resolve("training/frozen/sources-manifest.json"),
    "utf8",
  );
  const manifest = JSON.parse(bytes) as {
    originalRuntimeManifest: string;
    files: SourceEntry[];
  };
  const original = JSON.parse(
    await readFile(resolve(manifest.originalRuntimeManifest), "utf8"),
  ) as {
    snapshotPath: string;
    snapshotSha256: string;
    dependencies: Record<string, string>;
  };
  if (
    hash(await readFile(resolve(original.snapshotPath), "utf8")) !==
    original.snapshotSha256
  )
    throw new Error("Original evaluated runtime snapshot changed.");
  const hashes: Record<string, string> = {};
  for (const entry of manifest.files) {
    let source = await readFile(resolve(entry.snapshotPath), "utf8");
    if (hash(source) !== entry.snapshotSha256)
      throw new Error(`Frozen source changed: ${entry.snapshotPath}`);
    for (const rewrite of [...entry.importRewrites].reverse()) {
      if (source.split(rewrite.to).length - 1 !== rewrite.count)
        throw new Error(`Frozen import mapping changed: ${entry.snapshotPath}`);
      source = source.replaceAll(rewrite.to, rewrite.from);
    }
    const historicalHash =
      entry.evaluatedPath === "src/server/planner.ts"
        ? original.snapshotSha256
        : original.dependencies[entry.evaluatedPath];
    if (
      hash(source) !== entry.originalSha256 ||
      (historicalHash && entry.originalSha256 !== historicalHash)
    )
      throw new Error(
        `Frozen source cannot reconstruct its original bytes: ${entry.snapshotPath}`,
      );
    hashes[entry.evaluatedPath] = entry.originalSha256;
  }
  return { hashes, manifestSha256: hash(bytes) };
}

export async function loadEvaluationRuntime(selection: string) {
  if (selection !== "product" && selection !== "frozen-v1")
    throw new Error("Runtime must be product or frozen-v1.");
  const sourcePath =
    selection === "frozen-v1"
      ? "training/frozen/runtime.ts"
      : "src/server/planner.ts";
  const sourceSha256 = hash(await readFile(resolve(sourcePath), "utf8"));
  const preserved =
    selection === "frozen-v1" ? await verifyFrozenSources() : undefined;
  const [runtime, domain, checker, fixtures] =
    selection === "frozen-v1"
      ? await Promise.all([
          import("./frozen/sources/planner"),
          import("./frozen/sources/domain"),
          import("./frozen/sources/evaluation"),
          import("./frozen/sources/fixtures"),
        ])
      : await Promise.all([
          import("../src/server/planner"),
          import("../src/domain"),
          import("./evaluation"),
          import("./fixtures"),
        ]);
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      comparedPaths.map(async (path) => [
        path,
        preserved
          ? preserved.hashes[path]
          : hash(await readFile(resolve(path), "utf8")),
      ]),
    ),
  );
  return {
    runtime,
    domain,
    checker,
    fixtures,
    selection,
    sourcePath,
    sourceSha256,
    sourceHashes,
    sourceManifestSha256: preserved?.manifestSha256,
  };
}
