import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/server/db";
import { owner } from "@/server/security";
import {
  forgeDashboardLinks,
  readCampaignSummary,
  readTrainingSummary,
  weaveProjectUrl,
} from "@/server/showcase";
import styles from "./showcase.module.css";

type WorkflowStage = {
  workflow_id: string;
  created_at: Date;
  id: string | null;
  stage: string | null;
  attempt: number | null;
  status: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  job_id: string | null;
  plan_id: string | null;
  take_id: string | null;
  source: string | null;
  result_plan_id: string | null;
  measured_frames: number | null;
  expected_frames: number | null;
  finding_count: number | null;
};

function timestamp(value: Date) {
  return value.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export const dynamic = "force-dynamic";
export default async function DeveloperPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost";
  let ownerId: string;
  try {
    ownerId = await owner(new Request(`http://${host}/developer`));
  } catch {
    return (
      <main className={styles.page}>
        <Link href="/">FlowBlock</Link>
        <h1>Sign in to inspect your runs.</h1>
        <Link href="/api/auth/signin">Account sign-in</Link>
      </main>
    );
  }
  const summary = await readTrainingSummary();
  const campaign = readCampaignSummary();
  const incompleteConfirmation = campaign?.results.some(
    (row) => row.cohort === "confirmation" && row.available < row.scheduled,
  );
  const projectUrl = weaveProjectUrl();
  const dashboards = forgeDashboardLinks();
  let jobs: {
    id: string;
    status: string;
    kind: string;
    created_at: Date;
    result: Record<string, unknown> | null;
  }[] = [];
  let databaseAvailable = false;
  try {
    const result = await db().query(
      "SELECT id,status,kind,created_at,jsonb_build_object('source',result->'source','traceId',result->'traceId','usage',result->'usage','latencyMs',result->'latencyMs','inputHash',result->'inputHash','model',result->'model','provenance',result->'provenance','coverage',result->'coverage') AS result FROM jobs WHERE owner_id=$1 UNION ALL SELECT id,CASE WHEN accepted_at IS NULL THEN 'proposed' ELSE 'accepted' END AS status,'revision' AS kind,created_at,provenance AS result FROM revisions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 30",
      [ownerId],
    );
    jobs = result.rows;
    databaseAvailable = true;
  } catch {
    /* Local planning does not require the database. */
  }
  let workflowRows: WorkflowStage[] = [];
  let workflowsAvailable = false;
  try {
    const result = await db().query<WorkflowStage>(
      `SELECT w.id AS workflow_id,w.created_at,a.id,a.stage,a.attempt,a.status,
        a.started_at,a.ended_at,a.job_id,a.plan_id,a.take_id,
        a.summary->>'source' AS source,a.summary->>'resultPlanId' AS result_plan_id,
        (a.summary->>'measuredFrames')::int AS measured_frames,
        (a.summary->>'expectedFrames')::int AS expected_frames,
        (a.summary->>'findingCount')::int AS finding_count
       FROM (SELECT id,created_at FROM workflows WHERE owner_id=$1
             ORDER BY created_at DESC,id LIMIT 8) w
       LEFT JOIN workflow_attempts a ON a.workflow_id=w.id
       ORDER BY w.created_at DESC,w.id,a.started_at,a.id`,
      [ownerId],
    );
    workflowRows = result.rows;
    workflowsAvailable = true;
  } catch {
    /* Existing local plans also work before the workflow migration is applied. */
  }
  const workflows = new Map<string, WorkflowStage[]>();
  for (const row of workflowRows) {
    const stages = workflows.get(row.workflow_id) ?? [];
    stages.push(row);
    workflows.set(row.workflow_id, stages);
  }
  return (
    <main className={styles.page}>
      <header>
        <Link href="/">← FlowBlock workspace</Link>
        <span>Developer evidence</span>
      </header>
      <p className={styles.eyebrow}>RUN · OBSERVE · CURATE · EVALUATE</p>
      <h1>Show the work behind the next take.</h1>
      <p className={styles.lead}>
        Model calls propose actions. The geometry engine decides feasibility.
        Product tracking contributes image measurements. Every result keeps its
        source and version.
      </p>
      <section className={styles.cards}>
        <article>
          <span>Serving planner</span>
          <h2>{process.env.FLOWBLOCK_MODEL || "openai/gpt-oss-20b"}</h2>
          <p>
            Six actions, two repairs, a 30-second model deadline. Validated
            recipes remain available when inference fails.
          </p>
        </article>
        <article>
          <span>Video measurement</span>
          <h2>SAM 2.1 Small</h2>
          <p>
            Box-prompted tracking at 15 fps. Missing and uncertain masks remain
            unmeasured. No metric camera-path reconstruction.
          </p>
        </article>
        <article>
          <span>Candidate promotion</span>
          <h2>Baseline retained</h2>
          <p>
            Training completion is separate from useful shot planning. Read the
            recorded qualification and its limitations below.
          </p>
        </article>
      </section>
      <section aria-labelledby="shot-workflows">
        <div className={styles.sectionTitle}>
          <h2 id="shot-workflows">Your shot workflows</h2>
          <span>Latest 8 · this account</span>
        </div>
        <p>
          Follow planning, measured review, and acceptance in execution order.
          Each workflow uses one Agent Lens conversation. The stages below come
          from the application database; a conversation link does not confirm
          that remote traces were delivered. Failed attempts stay visible.
        </p>
        {!workflowsAvailable ? (
          <p>
            Workflow records are unavailable. Check the database connection and
            migrations.
          </p>
        ) : workflows.size === 0 ? (
          <p>
            No recorded workflows yet. Plan a shot or upload a take to start
            one.
          </p>
        ) : (
          <div className={styles.workflows}>
            {Array.from(workflows, ([workflowId, stages]) => (
              <article className={styles.workflow} key={workflowId}>
                <div className={styles.workflowHeading}>
                  <div>
                    <h3>
                      <time dateTime={stages[0].created_at.toISOString()}>
                        {timestamp(stages[0].created_at)}
                      </time>
                    </h3>
                    <code>{workflowId}</code>
                  </div>
                  {dashboards ? (
                    <a
                      href={`${dashboards.agentLens}/conversations/${encodeURIComponent(workflowId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Agent Lens ↗
                    </a>
                  ) : (
                    <span>Configure the Forge entity to link traces.</span>
                  )}
                </div>
                {stages[0].id === null ? (
                  <p>No stages have started.</p>
                ) : (
                  <div
                    className={styles.tableWrap}
                    role="region"
                    aria-label={`Stages for workflow ${workflowId}, horizontally scrollable`}
                    tabIndex={0}
                  >
                    <table className={styles.workflowTable}>
                      <caption>
                        Recorded stages · scroll horizontally on small screens
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Stage</th>
                          <th scope="col">Status</th>
                          <th scope="col">Result</th>
                          <th scope="col">Records</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stages.map((stage) => (
                          <tr key={stage.id}>
                            <th scope="row">
                              {stage.stage}
                              <small>Attempt {stage.attempt}</small>
                            </th>
                            <td>
                              <strong>
                                {stage.status?.replaceAll("_", " ")}
                              </strong>
                              {stage.started_at && (
                                <small>{timestamp(stage.started_at)}</small>
                              )}
                              {stage.started_at && stage.ended_at && (
                                <small>
                                  {(
                                    (stage.ended_at.getTime() -
                                      stage.started_at.getTime()) /
                                    1000
                                  ).toFixed(1)}{" "}
                                  s elapsed
                                </small>
                              )}
                            </td>
                            <td>
                              {stage.source && (
                                <span>Source: {stage.source}</span>
                              )}
                              {stage.measured_frames !== null && (
                                <span>
                                  {stage.measured_frames} /{" "}
                                  {stage.expected_frames ?? "?"} measured frames
                                </span>
                              )}
                              {stage.finding_count !== null && (
                                <small>{stage.finding_count} findings</small>
                              )}
                              {!stage.source &&
                                stage.measured_frames === null &&
                                stage.finding_count === null && <span>—</span>}
                            </td>
                            <td>
                              <details>
                                <summary>Record IDs</summary>
                                <small>Attempt</small>
                                <code>{stage.id}</code>
                                {stage.job_id && (
                                  <>
                                    <small>Job</small>
                                    <code>{stage.job_id}</code>
                                  </>
                                )}
                                {stage.take_id && (
                                  <>
                                    <small>Take</small>
                                    <code>{stage.take_id}</code>
                                  </>
                                )}
                                {stage.plan_id && (
                                  <>
                                    <small>Source plan</small>
                                    <code>{stage.plan_id}</code>
                                  </>
                                )}
                                {stage.result_plan_id && (
                                  <>
                                    <small>Result plan</small>
                                    <code>{stage.result_plan_id}</code>
                                  </>
                                )}
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="research-campaign">
        <h2 id="research-campaign">Current research campaign</h2>
        {!campaign ? (
          <p>
            The recorded campaign summary is unavailable or did not pass
            validation.
          </p>
        ) : (
          <>
            <p>
              Recorded snapshot of the private{" "}
              <strong>{campaign.project}</strong> project, updated{" "}
              <time dateTime={campaign.recordedAt}>
                {new Date(campaign.recordedAt)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19)}{" "}
                UTC
              </time>
              . This is saved evidence, not a live service status or results for
              your configured project.
            </p>
            <p id="campaign-table-help">
              Can the planner return a feasible move that preserves the authored
              brief? On narrow screens, scroll the table horizontally; keyboard
              users can focus it and use the arrow keys.
            </p>
            <div
              className={styles.tableWrap}
              role="region"
              aria-label="Planner campaign results, horizontally scrollable"
              aria-describedby="campaign-table-help"
              tabIndex={0}
            >
              <table>
                <caption style={{ textAlign: "left" }}>
                  Recorded planner results
                </caption>
                <thead>
                  <tr>
                    <th scope="col">System</th>
                    <th scope="col">Cohort</th>
                    <th scope="col">Scheduled</th>
                    <th scope="col">Available</th>
                    <th scope="col">Productive / available</th>
                    <th scope="col">Invalid plans admitted</th>
                  </tr>
                </thead>
                <tbody>
                  {campaign.results.map((row) => (
                    <tr key={row.attemptId}>
                      <th scope="row">{row.label}</th>
                      <td>
                        {row.cohort}
                        <small>{row.sceneGroups} scene groups</small>
                      </td>
                      <td>{row.scheduled}</td>
                      <td>
                        {row.available}
                        {row.attempted > row.available && (
                          <small>
                            {row.attempted - row.available} attempted,
                            unavailable
                          </small>
                        )}
                        {row.scheduled > row.attempted && (
                          <small>
                            {row.scheduled - row.attempted} not attempted
                          </small>
                        )}
                      </td>
                      <td>
                        {row.available === 0
                          ? "Unavailable"
                          : `${row.productive} / ${row.available} (${((100 * row.productive) / row.available).toFixed(1)}%)`}
                        {row.available < row.scheduled && (
                          <small>
                            {row.productive} / {row.scheduled} scheduled tasks
                            delivered a productive plan
                          </small>
                        )}
                      </td>
                      <td>
                        {row.available === 0
                          ? "Unmeasured"
                          : row.invalidAdmissions}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Productive means a result passed the recorded geometry and brief
              checks. Unavailable outcomes have no quality score. The library
              receives structured constraints; GPT-OSS uses the product
              coordinator. Their comparisons describe different systems. Tasks
              share scene groups and authored room templates.
            </p>
            <p>
              The analysis also preserves{" "}
              {campaign.omittedAttempts.initialPilot} initial pilot and{" "}
              {campaign.omittedAttempts.zeroCallTransport} zero-call transport
              attempts separately. They are not pooled into the rows above.
            </p>
            {campaign.matchedComparisons.map((pair) => (
              <p key={`${pair.baseAttemptId}/${pair.trainedAttemptId}`}>
                <strong>Matched base / trained Llama · {pair.cohort}:</strong>{" "}
                {pair.difference === null
                  ? "No paired quality estimate is available."
                  : `${pair.difference >= 0 ? "+" : ""}${(100 * pair.difference).toFixed(1)} percentage points: base ${pair.baseProductive}/${pair.pairedAvailable}, trained ${pair.trainedProductive}/${pair.pairedAvailable} on the same available tasks.`}
                {pair.interval95 &&
                  ` The 95% scene-group bootstrap interval is ${(100 * pair.interval95[0]).toFixed(1)} to ${(100 * pair.interval95[1]).toFixed(1)} points (${pair.sceneGroups} groups with paired outcomes; ${pair.iterations.toLocaleString("en-US")} replicates).`}{" "}
                This estimate is conditional on paired availability; outages can
                select which tasks are measured. Its uncertainty concerns the
                authored scene groups, not creator outcomes.
              </p>
            ))}
            <div className={styles.cards}>
              <article>
                <span>Planner candidate</span>
                <h3>Training record</h3>
                <p>
                  Last recorded state:{" "}
                  <strong>{campaign.training.state}</strong>.{" "}
                  {campaign.training.examples.toLocaleString("en-US")} examples,{" "}
                  {campaign.training.completedSteps === null
                    ? `${campaign.training.plannedSteps} planned optimizer steps. Completion is not yet independently verified.`
                    : `${campaign.training.completedSteps} gradient updates with independently verified completion.`}{" "}
                  Evaluation is separate from training. The serving baseline
                  remains in place.
                </p>
              </article>
              <article>
                <span>Confirmation</span>
                <h3>
                  {campaign.confirmation.state === "unused"
                    ? "Not evaluated"
                    : campaign.confirmation.state === "completed"
                      ? incompleteConfirmation
                        ? "Closed with incomplete coverage"
                        : "Recorded evaluation complete"
                      : "Evaluation in progress"}
                </h3>
                <p>
                  {campaign.confirmation.tasks} frozen tasks across{" "}
                  {campaign.confirmation.sceneGroups} scene groups.
                  {campaign.confirmation.state === "unused"
                    ? " This set remains unused. Development scores are not fresh confirmation evidence."
                    : incompleteConfirmation
                      ? " Outages left tasks without model outcomes. Coverage is shown above; these frozen attempts are not rerun. Development and confirmation remain separate."
                      : " Read confirmation rows separately from development; the two cohorts are never pooled."}
                </p>
              </article>
              <article>
                <span>Creator outcome</span>
                <h3>Study not started</h3>
                <p>
                  {campaign.creatorStudy.participants} creators studied. Faster
                  time to a usable take remains untested. It requires a
                  counterbalanced study with a practice control and reviewers
                  blind to the workflow.
                </p>
              </article>
            </div>
            <h3>Real product footage: a tracking diagnostic</h3>
            <p>
              SAM 2.1 Small ran locally on {campaign.objectron.completed} of{" "}
              {campaign.objectron.selected} selected Objectron clips.{" "}
              {campaign.objectron.heuristicAcceptedSamples} of{" "}
              {campaign.objectron.nonSeedSamples} non-seed samples passed the
              worker’s tracking heuristics. Assistant inspection still found
              apparent mask errors. The mean per-video mask-centroid to
              projected 3D-center discrepancy was{" "}
              {campaign.objectron.meanProjectionDiscrepancy.toFixed(5)} frame
              diagonals. Projected boxes are not silhouette labels; this is a
              proxy, not mask accuracy or creator benefit.
            </p>
            <h3>Verified native evidence</h3>
            <p>
              These links require access to the private recorded project.
              Dataset, result and model readbacks are preserved with the
              snapshot.
            </p>
            <ul>
              {campaign.evidence.map((item) => (
                <li key={item.url}>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.label} ↗
                  </a>
                </li>
              ))}
            </ul>
            <p>
              Objectron Models publication:{" "}
              <strong>{campaign.objectron.modelsPublication}</strong>.
              {campaign.objectron.modelsPublication === "failed" &&
                " Its producer has no uploaded artifacts or result consumer. The separate Weave evaluation is verified."}
            </p>
            <details>
              <summary>Attempt IDs and source hashes</summary>
              <pre className={styles.record}>
                {JSON.stringify(
                  {
                    experimentId: campaign.experimentId,
                    analysis: campaign.analysis,
                    attempts: campaign.results.map(({ attemptId, cohort }) => ({
                      attemptId,
                      cohort,
                    })),
                    matchedComparisons: campaign.matchedComparisons,
                    training: campaign.training,
                    confirmation: campaign.confirmation,
                    objectronSource: campaign.objectron.source,
                    evidence: campaign.evidence,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        )}
      </section>
      <section aria-labelledby="forge-dashboards">
        <h2 id="forge-dashboards">Forge dashboards</h2>
        <p>
          Open the configured project in Forge. These services record different
          parts of the experiment; a successful training run does not establish
          a useful planner.
        </p>
        {dashboards ? (
          <div className={`${styles.cards} ${styles.dashboards}`}>
            <article>
              <span>Execution</span>
              <h3>
                <a href={dashboards.agentLens} target="_blank" rel="noreferrer">
                  Agent Lens ↗
                </a>
              </h3>
              <p>
                Planner and revision conversations, model calls, tools, errors,
                and token usage. Automated Insights requires a separate service
                run; conversation ingestion alone does not produce it.
              </p>
            </article>
            <article>
              <span>Qualification</span>
              <h3>
                <a
                  href={dashboards.evaluations}
                  target="_blank"
                  rel="noreferrer"
                >
                  Weave evaluations ↗
                </a>
              </h3>
              <p>
                Native evaluations of recorded planner and tracking outcomes.
                Imported rows retain the original availability, scores and
                runtime provenance. Import duration is not inference or worker
                latency.
              </p>
            </article>
            <article>
              <span>Training</span>
              <h3>
                <a href={dashboards.models} target="_blank" rel="noreferrer">
                  W&B Models ↗
                </a>
              </h3>
              <p>
                Versioned datasets, input lineage, result tables, optimizer
                metrics and checkpoint artifacts. Run state, artifact
                verification and candidate quality are separate checks.
              </p>
            </article>
            <article>
              <span>Serving</span>
              <h3>
                <a href={dashboards.inference} target="_blank" rel="noreferrer">
                  W&B Inference ↗
                </a>
              </h3>
              <p>
                Catalog model calls for planning and development checks. Trained
                candidates use checkpoint inference through the training
                adapter. The app, database, private media and video worker run
                locally.
              </p>
            </article>
          </div>
        ) : (
          <p>
            Configure WANDB_ENTITY and WANDB_PROJECT on the server to link your
            dashboards.
          </p>
        )}
        <p>
          Historical experiment records below describe the recorded FlowBlock
          campaign. They are not live status checks for a newly configured
          project.
        </p>
      </section>
      <section>
        <div className={styles.sectionTitle}>
          <h2>Original training and evaluation record</h2>
          {projectUrl && (
            <a href={projectUrl} target="_blank" rel="noreferrer">
              Open Weave project ↗
            </a>
          )}
        </div>
        <p>
          The original twelve inspected tasks remain a separate historical
          experiment, preserved with their evaluated runtime. Synthetic fixture
          qualification is not a creator study. A passing geometry check does
          not establish cinematic quality, market fit, or improved filming
          outcomes.
        </p>
        <details>
          <summary>Read the original experiment record</summary>
          <pre className={styles.record}>
            {JSON.stringify(summary, null, 2)}
          </pre>
        </details>
      </section>
      <section>
        <div className={styles.sectionTitle}>
          <h2>Your recent jobs</h2>
          <span>{jobs.length} most recent</span>
        </div>
        {!databaseAvailable ? (
          <p>Database unavailable. Reconnect it to inspect job records.</p>
        ) : jobs.length === 0 ? (
          <p>
            No jobs recorded for this account yet. Plan a shot or analyze a take
            to create one.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>State</th>
                  <th>Source / model</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <strong>{job.kind}</strong>
                      <small>{job.created_at.toISOString()}</small>
                      <code>{job.id}</code>
                    </td>
                    <td>{job.status}</td>
                    <td>
                      {String(
                        job.result?.source ||
                          (job.kind === "analysis"
                            ? "local worker"
                            : "pending"),
                      )}
                      <small>{String(job.result?.model || "")}</small>
                    </td>
                    <td>
                      <details>
                        <summary>Versions, trace and usage</summary>
                        <pre>{JSON.stringify(job.result, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <footer>
        Raw footage and signed media URLs are excluded from model traces. This
        recent-jobs list contains only the current account’s jobs. Research
        records describe the fixed private FlowBlock campaign.
      </footer>
    </main>
  );
}
