import Link from 'next/link';
import { headers } from 'next/headers';
import { db } from '@/server/db';
import { owner } from '@/server/security';
import { readTrainingSummary, weaveProjectUrl } from '@/server/showcase';
import styles from './showcase.module.css';

export const dynamic = 'force-dynamic';
export default async function DeveloperPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') || 'localhost';
  let ownerId: string;
  try { ownerId = await owner(new Request(`http://${host}/developer`)); }
  catch { return <main className={styles.page}><Link href="/">FlowBlock</Link><h1>Sign in to inspect your runs.</h1><Link href="/api/auth/signin">Account sign-in</Link></main>; }
  const summary = await readTrainingSummary();
  const projectUrl = weaveProjectUrl();
  let jobs: { id: string; status: string; kind: string; created_at: Date; result: Record<string, unknown> | null }[] = [];
  let databaseAvailable = false;
  try {
    const result = await db().query("SELECT id,status,kind,created_at,jsonb_build_object('source',result->'source','traceId',result->'traceId','usage',result->'usage','latencyMs',result->'latencyMs','inputHash',result->'inputHash','model',result->'model','provenance',result->'provenance','coverage',result->'coverage') AS result FROM jobs WHERE owner_id=$1 UNION ALL SELECT id,CASE WHEN accepted_at IS NULL THEN 'proposed' ELSE 'accepted' END AS status,'revision' AS kind,created_at,provenance AS result FROM revisions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 30", [ownerId]);
    jobs = result.rows; databaseAvailable = true;
  } catch { /* Local planning does not require the database. */ }
  return <main className={styles.page}>
    <header><Link href="/">← FlowBlock workspace</Link><span>Developer evidence</span></header>
    <p className={styles.eyebrow}>RUN · OBSERVE · CURATE · EVALUATE</p>
    <h1>Show the work behind the next take.</h1>
    <p className={styles.lead}>Model calls propose actions. The geometry engine decides feasibility. Product tracking contributes image measurements. Every result keeps its source and version.</p>
    <section className={styles.cards}>
      <article><span>Serving planner</span><h2>{process.env.FLOWBLOCK_MODEL || 'openai/gpt-oss-20b'}</h2><p>Six actions, two repairs, a 30-second model deadline. Validated recipes remain available when inference fails.</p></article>
      <article><span>Video measurement</span><h2>SAM 2.1 Small</h2><p>Box-prompted tracking at 15 fps. Missing and uncertain masks remain unmeasured. No metric camera-path reconstruction.</p></article>
      <article><span>Candidate promotion</span><h2>Baseline retained</h2><p>Training completion is separate from useful shot planning. Read the recorded qualification and its limitations below.</p></article>
    </section>
    <section><div className={styles.sectionTitle}><h2>Training and evaluation record</h2>{projectUrl && <a href={projectUrl} target="_blank" rel="noreferrer">Open Weave project ↗</a>}</div><p>Synthetic fixture qualification is not a creator study. A passing geometry check does not establish cinematic quality, market fit, or improved filming outcomes.</p><pre className={styles.record}>{JSON.stringify(summary, null, 2)}</pre></section>
    <section><div className={styles.sectionTitle}><h2>Your recent jobs</h2><span>{jobs.length} most recent</span></div>
      {!databaseAvailable ? <p>Database unavailable. Reconnect it to inspect job records.</p> : jobs.length === 0 ? <p>No jobs recorded for this account yet. Plan a shot or analyze a take to create one.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Job</th><th>State</th><th>Source / model</th><th>Evidence</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td><strong>{job.kind}</strong><small>{job.created_at.toISOString()}</small><code>{job.id}</code></td><td>{job.status}</td><td>{String(job.result?.source || (job.kind === 'analysis' ? 'local worker' : 'pending'))}<small>{String(job.result?.model || '')}</small></td><td><details><summary>Versions, trace and usage</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details></td></tr>)}</tbody></table></div>}
    </section>
    <footer>Raw footage and signed media URLs are excluded from model traces. This view contains only the current account’s jobs.</footer>
  </main>;
}
