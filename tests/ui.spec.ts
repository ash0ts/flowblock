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
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
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
