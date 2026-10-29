import { expect, test } from "@playwright/test";

const origin =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.FLOWBLOCK_TEST_ORIGIN ||
  "http://127.0.0.1:3037";

test("shot edits survive switching recipes and a page reload", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(origin);
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Focal length", exact: true })
    .fill("35");
  await page
    .getByRole("button", {
      name: "Gentle push Toward the product",
      exact: true,
    })
    .click();
  await page
    .getByRole("spinbutton", { name: "Focal length", exact: true })
    .fill("70");
  await page
    .getByRole("button", {
      name: "Quarter orbit Curved camera path",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Focal length", exact: true }),
  ).toHaveValue("35");
  await page
    .getByRole("button", {
      name: "Gentle push Toward the product",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Focal length", exact: true }),
  ).toHaveValue("70");
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Gentle push." }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Focal length", exact: true }),
  ).toHaveValue("70");
  expect(browserErrors).toEqual([]);
});

test("canvas playback, obstacle controls, and invalid-path rehearsal recovery work", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole("slider", { name: "Shot time", exact: true })
          .inputValue(),
      ),
    )
    .toBeGreaterThan(0.02);
  await page
    .getByRole("button", { name: "Pause preview", exact: true })
    .click();
  await page.getByRole("button", { name: "Your space", exact: true }).click();
  await page
    .getByRole("button", { name: "Add obstacle", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Obstacle 4");
  await page
    .getByRole("spinbutton", { name: "Room depth", exact: true })
    .fill("1");
  await page.getByRole("button", { name: "2 Rehearse", exact: true }).click();
  await expect(
    page.getByText("Adjust the plan before rehearsing"),
  ).toBeVisible();
  await expect(page.getByText("Walk the path", { exact: true })).toHaveCount(0);
  await page
    .getByRole("spinbutton", { name: "Room depth", exact: true })
    .fill("8");
  await page
    .getByRole("button", { name: "Hero hold Locked composition", exact: true })
    .click();
  await expect(page.getByText("Walk the path", { exact: true })).toBeVisible();
});

test("offline generation offers only computed candidates and no invented analysis", async ({
  page,
}) => {
  await page.route("**/api/plans", (route) => route.abort());
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        inference: false,
        storage: false,
        database: false,
        auth: false,
        worker: false,
        mode: "local",
        model: "unconfigured",
        limitations: [],
        training: { status: "not_run" },
      },
    }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  const candidates = page
    .getByRole("region", { name: "Options for your brief" })
    .getByRole("button");
  await expect(candidates).toHaveCount(3);
  await expect(
    page.getByText("Built from the local move library.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "3 Review", exact: true }).click();
  await expect(
    page.getByText("Hosted analysis is not configured.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload & analyze", exact: false }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Your first take starts here." }),
  ).toBeVisible();
  await expect(page.getByText("Reliable expected frames")).toHaveCount(0);
});

test("narrow portrait controls and review fit without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.getByRole("button", { name: "9:16", exact: true }).click();
  await expect(page.locator(".framing-preview.portrait")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "2 Rehearse", exact: true }).click();
  await expect(
    page.getByText("Approximate camera view", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "3 Review", exact: true }).click();
  await expect(
    page.getByLabel("Choose a take", { exact: true }),
  ).toBeAttached();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a real local fixture can be annotated by keyboard and survives tab changes", async ({
  page,
}) => {
  const { existsSync } = await import("node:fs");
  const fixture =
    process.env.FLOWBLOCK_TEST_VIDEO ||
    "worker/artifacts/synthetic/synthetic-bottle.mp4";
  test.skip(
    !existsSync(fixture),
    "Generate the clearly labeled synthetic pipeline fixture to test video playback.",
  );
  await page.goto(origin);
  await page.getByRole("button", { name: "3 Review", exact: true }).click();
  await page
    .getByLabel("Choose a take", { exact: true })
    .setInputFiles(fixture);
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate(
          (element) =>
            Number.isFinite((element as HTMLVideoElement).duration) &&
            (element as HTMLVideoElement).duration >= 5,
        ),
    )
    .toBe(true);
  await page.getByText("Mark with coordinates", { exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "Annotation time", exact: true })
    .fill("2.47");
  await page
    .getByRole("spinbutton", { name: "Box left", exact: true })
    .fill("43.125");
  await page
    .getByRole("spinbutton", { name: "Box top", exact: true })
    .fill("23.889");
  await page
    .getByRole("spinbutton", { name: "Box width", exact: true })
    .fill("12.813");
  await page
    .getByRole("spinbutton", { name: "Box height", exact: true })
    .fill("55.556");
  await page
    .getByRole("button", { name: "Use box at this frame", exact: true })
    .click();
  await expect(page.getByText("Seed at 2.47 s", { exact: true })).toBeVisible();
  await expect(page.locator(".product-box")).toBeVisible();
  await expect(page.locator(".intended-box")).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Visible from", exact: true })
    .fill("0.5");
  await page
    .getByRole("spinbutton", { name: "Visible until", exact: true })
    .fill("4.8");
  await page
    .getByRole("button", {
      name: "+ Save this frame as a correction",
      exact: true,
    })
    .click();
  const source = await page.locator("video").getAttribute("src");
  await page.getByRole("button", { name: "1 Plan", exact: true }).click();
  await page.getByRole("button", { name: "3 Review", exact: true }).click();
  await expect(page.locator("video")).toHaveAttribute("src", source!);
  await expect(page.getByText("Seed at 2.47 s", { exact: true })).toBeVisible();
  await page
    .getByLabel("Choose another take", { exact: true })
    .setInputFiles(fixture);
  await page
    .getByRole("button", { name: "Take 1 Local clip", exact: true })
    .click();
  await expect(page.locator("video")).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Visible from", exact: true }),
  ).toHaveValue("0.5");
  await expect(
    page.getByRole("spinbutton", { name: "Visible until", exact: true }),
  ).toHaveValue("4.8");
  await expect(
    page.getByRole("button", { name: "Remove correction 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Take 2 Local clip", exact: true }),
  ).toBeVisible();
});

test("sync preserves a conflicting local draft and retries only by explicit choice", async ({
  page,
}) => {
  const { compilePlan, defaultScene, defaultGear, defaultIntent } =
    await import("../src/domain");
  const remotePlan = compilePlan(
    defaultScene,
    { ...defaultGear, lens: { kind: "equivalent", focalLengthMm: 70 } },
    defaultIntent,
    "quarter-orbit",
  );
  let version = "";
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          projects: version
            ? [
                {
                  id: "project-test",
                  name: "Remote shot",
                  current_version_id: version,
                  updated_at: "2026-01-01T00:00:00Z",
                  plan: remotePlan,
                },
              ]
            : [],
        },
      });
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) {
      version = "version-one";
      return route.fulfill({
        json: { projectId: "project-test", versionId: version },
      });
    }
    if (writes.length === 2) {
      version = "version-two";
      return route.fulfill({
        status: 409,
        json: { error: "A newer server version exists." },
      });
    }
    version = "version-three";
    return route.fulfill({
      json: { projectId: "project-test", versionId: version },
    });
  });
  await page.goto(origin);
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "Saved versions", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Sync current plan", exact: true })
    .click();
  await expect(page.getByText("Plan synced.", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "Sync current plan", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Two versions, both kept." }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Focal length", exact: true }),
  ).toHaveValue(String(defaultGear.lens.focalLengthMm));
  expect(writes[1].expectedVersionId).toBe("version-one");
  await page
    .getByRole("button", { name: "Sync this local draft instead", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Two versions, both kept." }),
  ).toHaveCount(0);
  expect(writes[2].expectedVersionId).toBe("version-two");
});

test("created read-only links can be revoked from saved versions", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.route("**/api/projects", (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  await page.route("**/api/shares", (route) =>
    route.fulfill({
      json: { token: "test-token", url: `${origin}/s/test-token` },
    }),
  );
  let revoked = false;
  await page.route("**/api/shares/test-token", (route) => {
    revoked = route.request().method() === "DELETE";
    return route.fulfill({ json: { revoked: true } });
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "Export plan", exact: false }).click();
  await page
    .getByRole("button", { name: "Create read-only link", exact: true })
    .click();
  await expect(
    page.getByText("Plan link copied.", { exact: false }),
  ).toBeVisible();
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "Saved versions", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Revoke link for Quarter orbit", exact: true })
    .click();
  await expect(
    page.getByText("Read-only link revoked.", { exact: true }),
  ).toBeVisible();
  expect(revoked).toBe(true);
  await expect(
    page.getByRole("button", {
      name: "Revoke link for Quarter orbit",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("production app shell reopens offline with its saved planner state", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_PWA_TEST !== "1",
    "Set PLAYWRIGHT_PWA_TEST=1 against a production build to verify service-worker caching.",
  );
  await page.addInitScript(() => {
    const register = navigator.serviceWorker.register.bind(
      navigator.serviceWorker,
    );
    navigator.serviceWorker.register = async (...args) => {
      await caches.open("unrelated-app-cache");
      await caches.open("flowblock-shell-obsolete");
      return register(...args);
    };
  });
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await caches.keys()).includes("flowblock-shell-obsolete"),
      ),
    )
    .toBe(false);
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).includes("unrelated-app-cache"),
    ),
  ).toBe(true);
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await page
    .getByRole("spinbutton", { name: "Duration", exact: true })
    .fill("11");
  await page
    .getByRole("spinbutton", { name: "Focal length", exact: true })
    .fill("35");
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(
    page.getByRole("spinbutton", { name: "Duration", exact: true }),
  ).toHaveValue("11");
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Offline · local workspace", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Duration", exact: true }),
  ).toHaveValue("11");
  await expect(
    page.getByRole("spinbutton", { name: "Focal length", exact: true }),
  ).toHaveValue("35");
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole("slider", { name: "Shot time", exact: true })
          .inputValue(),
      ),
    )
    .toBeGreaterThan(0.02);
  await page
    .getByRole("button", { name: "Pause preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Options for your brief" })
      .getByRole("button"),
  ).toHaveCount(3);
  const cachedApi = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = (
      await Promise.all(
        names.map(async (name) => (await caches.open(name)).keys()),
      )
    ).flat();
    return requests
      .filter((request) => new URL(request.url).pathname.startsWith("/api/"))
      .map((request) => request.url);
  });
  expect(cachedApi).toEqual([]);
});

test("a successful empty model result keeps its explanation and the inspectable draft", async ({
  page,
}) => {
  const explanation =
    "The proposed orbit cannot fit the camera and operator footprint. Move the table or widen the usable floor area.";
  await page.route("**/api/plans", (route) =>
    route.fulfill({
      json: { plans: [], source: "forge", message: explanation },
    }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  const candidates = page.getByRole("region", {
    name: "Options for your brief",
  });
  await expect(
    candidates.getByRole("heading", { name: "No moves fit this brief" }),
  ).toBeVisible();
  await expect(
    candidates.getByText(explanation, { exact: true }),
  ).toBeVisible();
  await expect(candidates.getByRole("button")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Quarter orbit." }),
  ).toBeVisible();
  await expect(
    page.getByText("Hosted planning is unavailable", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(
    candidates.getByText(explanation, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your space", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "Room depth", exact: true })
    .fill("1");
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  await expect(
    candidates.getByRole("heading", { name: "No moves fit this brief" }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Room depth", exact: true }),
  ).toHaveValue("1");
  await expect(
    page.getByRole("heading", { name: "Quarter orbit." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "2 Rehearse", exact: true }).click();
  await expect(
    page.getByText("Adjust the plan before rehearsing"),
  ).toBeVisible();
});

async function saveBrowserState(
  page: import("@playwright/test").Page,
  key: string,
  state: unknown,
) {
  await page.evaluate(
    async ({ key, state }) => {
      const request = indexedDB.open("keyval-store", 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onupgradeneeded = () =>
          request.result.createObjectStore("keyval");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("keyval", "readwrite");
        transaction
          .objectStore("keyval")
          .put(JSON.stringify({ state, version: 0 }), key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    },
    { key, state },
  );
}

test("duration and height controls replace proposed overrides and survive reload", async ({
  page,
}) => {
  const { compilePlan, defaultScene, defaultGear, defaultIntent } =
    await import("../src/domain");
  const proposed = compilePlan(
    defaultScene,
    defaultGear,
    defaultIntent,
    "quarter-orbit",
    { durationSeconds: 5, height: 1.6 },
  );
  await page.route("**/api/plans", (route) =>
    route.fulfill({ json: { plans: [proposed], source: "forge" } }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Duration", exact: true }),
  ).toHaveValue("5");
  await expect(
    page.getByRole("spinbutton", { name: "Camera height", exact: true }),
  ).toHaveValue("1.6");
  await page
    .getByRole("spinbutton", { name: "Duration", exact: true })
    .fill("8");
  await page
    .getByRole("spinbutton", { name: "Camera height", exact: true })
    .fill("1.2");
  await expect(page.locator(".track-labels")).toContainText("/ 8.0 s");
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(
    page.getByRole("spinbutton", { name: "Camera height", exact: true }),
  ).toHaveValue("1.2");
  await expect(page.locator(".track-labels")).toContainText("/ 8.0 s");
});

test("a late planning response preserves a newly edited brief", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/plans", async (route) => {
    await gate;
    await route.fulfill({
      json: {
        plans: [],
        source: "forge",
        message: "Response to the old brief.",
      },
    });
  });
  await page.goto(origin);
  const response = page.waitForRequest("**/api/plans");
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  await response;
  const prompt = page.locator("textarea");
  await prompt.fill(
    "A new direction entered while the first request was running.",
  );
  release();
  await expect(
    page.getByText(
      "Your shot changed while planning. Kept your edits; generate again to use them.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(prompt).toHaveValue(
    "A new direction entered while the first request was running.",
  );
  await expect(
    page.getByText("Response to the old brief.", { exact: true }),
  ).toHaveCount(0);
});

test("malformed browser state recovers without crashing or restoring stored actions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await saveBrowserState(page, "flowblock-workspace-v1", {
    scene: { boundary: [] },
    recipeId: "removed-recipe",
    updateIntent: "not a function",
  });
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(
    page.getByText("Some saved browser data could not be opened.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Duration", exact: true })
    .fill("10");
  await expect(page.locator(".track-labels")).toContainText("/ 10.0 s");
  expect(errors).toEqual([]);
});

test("the framing preview uses the projected box for a wide product", async ({
  page,
}) => {
  const { compilePlan, samplePlan, defaultScene, defaultGear, defaultIntent } =
    await import("../src/domain");
  const scene = {
    ...defaultScene,
    subject: { ...defaultScene.subject, width: 0.8, depth: 0.2, height: 0.15 },
  };
  const proposed = compilePlan(
    scene,
    { ...defaultGear, aspectRatio: "square" },
    defaultIntent,
    "hero-hold",
  );
  await page.route("**/api/plans", (route) =>
    route.fulfill({ json: { plans: [proposed], source: "forge" } }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  await expect(page.getByRole("heading", { name: "Hero hold." })).toBeVisible();
  const frame = samplePlan(proposed, 0).framingBox;
  const preview = page.locator(".framing-preview .preview-subject").first();
  const size = await preview.evaluate((element) => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
  expect(size.width).toBeCloseTo(frame.width * 100, 2);
  expect(size.height).toBeCloseTo(frame.height * 100, 2);
  expect(size.width).toBeGreaterThan(size.height);
});

test("take changes stay locked while a revision or deletion is in flight", async ({
  page,
}) => {
  const { compilePlan, defaultScene, defaultGear, defaultIntent } =
    await import("../src/domain");
  const plan = compilePlan(
    defaultScene,
    defaultGear,
    defaultIntent,
    "quarter-orbit",
  );
  const analysis = {
    schemaVersion: "1.0",
    analysisSpace: "upright-normalized-image",
    jobId: "browser-test-job",
    takeId: "browser-test-take",
    planId: plan.id,
    planVersion: "1.0",
    summary: "Mock analysis for browser interaction test",
    provenance: {
      model: "SAM 2.1 Small",
      repositoryCommit: "test",
      checkpointSha256: "test",
      device: "cpu",
      realInference: true,
      rulesVersion: "framing-v1",
      generatedAt: "2026-01-01T00:00:00Z",
    },
    video: {
      durationSeconds: 5,
      sourceWidth: 640,
      sourceHeight: 360,
      rotationDegrees: 0,
      width: 640,
      height: 360,
      codec: "h264",
      fps: 15,
      sampledFrames: 75,
      sourceStartPtsSeconds: 0,
      timestampMapping: "nearest-source-presentation-timestamp",
      timeMap: [],
    },
    tracks: [],
    coverage: {
      expectedFrames: 75,
      measuredFrames: 75,
      missingFrames: 0,
      uncertainFrames: 0,
      intentionallyHiddenFrames: 0,
      measuredFraction: 1,
      needsReview: false,
    },
    findings: [
      {
        kind: "duration",
        phase: "full",
        title: "Test duration finding",
        detail: "Mock browser fixture",
        evidenceTimestamps: [],
        affectedFrames: 0,
        measuredPhaseFrames: 75,
        suggestion: "Adjust duration",
      },
    ],
    artifacts: {
      proxyObjectKey: "test",
      timestampsObjectKey: "test",
      analysisObjectKey: "test",
    },
    limitations: ["Mock data used only in this automated browser test."],
  };
  let releaseRevision!: () => void;
  let releaseDeletion!: () => void;
  const revisionGate = new Promise<void>((resolve) => {
    releaseRevision = resolve;
  });
  const deletionGate = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  await page.route("**/api/takes/*/media?*", (route) => route.abort());
  await page.route("**/api/revisions", async (route) => {
    await revisionGate;
    await route.fulfill({
      json: {
        plan,
        reason: "A proposal for take one",
        revisionId: "browser-test-revision",
      },
    });
  });
  await page.route("**/api/takes/browser-test-take", async (route) => {
    await deletionGate;
    await route.fulfill({ json: { deleted: true } });
  });
  await page.goto(origin);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  const base = {
    name: "browser-test.mp4",
    plan,
    takeId: analysis.takeId,
    duration: 5,
    ratio: 16 / 9,
    uploadComplete: true,
    analysis,
    seed: null,
    corrections: [],
    expectedStart: 0,
    expectedEnd: 5,
    revised: false,
  };
  await saveBrowserState(page, "flowblock-takes-v1", {
    attempts: [
      { ...base, id: "browser-test-one", createdAt: "2026-01-01T00:00:00Z" },
      {
        ...base,
        id: "browser-test-two",
        takeId: null,
        analysis: null,
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
  });
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await page.getByRole("button", { name: "3 Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Take 1 Analyzed", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Propose one revision", exact: true })
    .click();
  const second = page.getByRole("button", {
    name: "Take 2 Local clip",
    exact: true,
  });
  await expect(second).toBeDisabled();
  await expect(
    page.getByLabel("Choose another take", { exact: true }),
  ).toBeDisabled();
  releaseRevision();
  await expect(
    page.getByText("A proposal for take one", { exact: true }),
  ).toBeVisible();
  await expect(second).toBeEnabled();
  await page
    .getByRole("button", { name: "Delete uploaded media", exact: false })
    .click();
  await expect(second).toBeDisabled();
  releaseDeletion();
  await expect(second).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Apply this revision", exact: false }),
  ).toHaveCount(0);
  await second.click();
  await expect(
    page.getByText("A proposal for take one", { exact: true }),
  ).toHaveCount(0);
});

test("saved geometry reports are recomputed before rehearsal", async ({
  page,
}) => {
  const { compilePlan, defaultScene, defaultGear, defaultIntent } =
    await import("../src/domain");
  const original = compilePlan(
    defaultScene,
    defaultGear,
    defaultIntent,
    "quarter-orbit",
  );
  const stale = {
    ...original,
    scene: {
      ...defaultScene,
      boundary: [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 1, z: 1 },
        { x: 0, z: 1 },
      ],
    },
    validation: { ...original.validation, valid: true, violations: [] },
  };
  await page.goto(origin);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await saveBrowserState(page, "flowblock-workspace-v1", {
    scene: stale.scene,
    gear: stale.gear,
    intent: stale.intent,
    recipeId: stale.recipeId,
    drafts: { [stale.recipeId]: stale },
    history: [stale],
  });
  await expect(page.locator(".save-status")).toHaveText("Saved on this device");
  await page.reload();
  await page.getByRole("button", { name: "2 Rehearse", exact: true }).click();
  await expect(
    page.getByText("Adjust the plan before rehearsing", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Walk the path", { exact: true })).toHaveCount(0);
  await page.route("**/api/projects", (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "Saved versions", exact: false })
    .click();
  await page.locator(".local-version-row").getByRole("button").first().click();
  await expect(
    page.getByText(
      "This shot was rechecked with the current planner. Its saved version is unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open("keyval-store", 1);
    const database = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const read = database
      .transaction("keyval", "readonly")
      .objectStore("keyval")
      .get("flowblock-workspace-v1");
    const value = await new Promise<string>((resolve) => {
      read.onsuccess = () => resolve(read.result);
    });
    database.close();
    return JSON.parse(value).state;
  });
  expect(stored.history[0]).toEqual(stale);
  expect(stored.drafts[stale.recipeId].validation.valid).toBe(false);
});

test("canvas objects support button keys and dialogs restore keyboard focus", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  const object = page.locator(".scene-object").first();
  await object.focus();
  await page.keyboard.press("Enter");
  await expect(object).toHaveAttribute("aria-pressed", "true");
  const opener = page.getByRole("button", {
    name: "Open connection status",
    exact: true,
  });
  await opener.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("Saved is shown only after the browser transaction commits", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const request = indexedDB.open("keyval-store", 1);
    const database = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction("keyval", "readwrite");
    const store = transaction.objectStore("keyval");
    let hold = true;
    (
      window as Window & { releaseStorageBlock?: () => void }
    ).releaseStorageBlock = () => {
      hold = false;
    };
    transaction.oncomplete = () => database.close();
    const keepOpen = () => {
      const read = store.get("flowblock-workspace-v1");
      read.onsuccess = () => {
        if (hold) keepOpen();
      };
    };
    keepOpen();
  });
  await page
    .getByRole("spinbutton", { name: "Duration", exact: true })
    .fill("10");
  await expect(
    page.getByText("Saving on this device…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as Window & { releaseStorageBlock?: () => void }
    ).releaseStorageBlock?.(),
  );
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("spinbutton", { name: "Duration", exact: true }),
  ).toHaveValue("10");
});

test("manual framing and energy edits replace matching custom path settings", async ({
  page,
}) => {
  const { compilePlan, defaultScene, defaultGear, defaultIntent } =
    await import("../src/domain");
  const custom = compilePlan(
    defaultScene,
    defaultGear,
    {
      ...defaultIntent,
      framingTargets: { start: [0.4, 0.5], end: [0.4, 0.5] },
    },
    "quarter-orbit",
    { orbitDegrees: 20, distance: 2, durationSeconds: 11, height: 1.3 },
  );
  await page.route("**/api/plans", (route) =>
    route.fulfill({ json: { plans: [custom], source: "forge" } }),
  );
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Plan my shot", exact: false })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Duration", exact: true }),
  ).toHaveValue("11");
  const preview = page.locator(".framing-preview .preview-subject").first();
  const coverage = () =>
    preview.evaluate((element) =>
      Math.max(
        Number.parseFloat((element as HTMLElement).style.width),
        Number.parseFloat((element as HTMLElement).style.height),
      ),
    );
  await expect.poll(coverage).toBeGreaterThan(30);
  await page
    .getByRole("combobox", { name: "Framing", exact: true })
    .selectOption("wide");
  await expect.poll(coverage).toBeLessThanOrEqual(30);
  const pathLength = page.locator(".path-metric > span");
  const previousLength = await pathLength.innerText();
  await page.getByRole("button", { name: "Dynamic", exact: true }).click();
  await expect(pathLength).not.toHaveText(previousLength);
  await expect(
    page.getByRole("spinbutton", { name: "Duration", exact: true }),
  ).toHaveValue("11");
  await expect(
    page.getByRole("spinbutton", { name: "Camera height", exact: true }),
  ).toHaveValue("1.3");
});

test("a later successful write does not hide a storage failure", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      IDBObjectStore.prototype.put = original;
      throw new DOMException(
        "Browser test quota failure",
        "QuotaExceededError",
      );
    };
  });
  await page
    .getByRole("spinbutton", { name: "Duration", exact: true })
    .fill("11");
  await expect(
    page.getByText("Storage unavailable", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "Duration", exact: true })
    .fill("12");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open("keyval-store", 1);
        const database = await new Promise<IDBDatabase>((resolve) => {
          request.onsuccess = () => resolve(request.result);
        });
        const read = database
          .transaction("keyval", "readonly")
          .objectStore("keyval")
          .get("flowblock-workspace-v1");
        const value = await new Promise<string>((resolve) => {
          read.onsuccess = () => resolve(read.result);
        });
        database.close();
        return JSON.parse(value).state.intent.durationSeconds;
      }),
    )
    .toBe(12);
  await expect(
    page.getByText("Storage unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toHaveCount(0);
});
