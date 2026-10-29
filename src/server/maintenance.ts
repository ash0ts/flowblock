import { db, transaction } from './db';
import { deletePrefix } from './storage';

export async function cleanupMedia(): Promise<number> {
  const expired = await db().query("SELECT id,owner_id FROM takes WHERE expires_at<=now() OR deleted_at IS NOT NULL ORDER BY COALESCE(cleanup_checked_at,'epoch'::timestamptz) LIMIT 500");
  for (const take of expired.rows) {
    await transaction(async client => {
      await client.query("UPDATE takes SET deleted_at=COALESCE(deleted_at,now()),file_name='[deleted]',plan='{}'::jsonb,training_consent=false WHERE id=$1", [take.id]);
      await client.query("UPDATE jobs SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()),lease_token=NULL,result=NULL,payload=jsonb_build_object('takeId',$2::text,'deleted',true),updated_at=now() WHERE owner_id=$1 AND payload->>'takeId'=$2", [take.owner_id, take.id]);
    });
    await deletePrefix(`owners/${take.owner_id}/takes/${take.id}/`);
    await db().query('UPDATE takes SET cleanup_checked_at=now() WHERE id=$1', [take.id]);
  }
  await db().query("UPDATE jobs SET status='failed',error='The application stopped before planning completed. Your local draft is preserved.',updated_at=now() WHERE kind='plan' AND status='running' AND updated_at<now()-interval '2 minutes'");
  return expired.rowCount || 0;
}

const state = globalThis as unknown as { flowblockMaintenance?: ReturnType<typeof setInterval>; flowblockMaintenanceBusy?: boolean };
export function startMaintenance() {
  if (state.flowblockMaintenance) return;
  const sweep = async () => {
    if (state.flowblockMaintenanceBusy) return;
    state.flowblockMaintenanceBusy = true;
    try { await cleanupMedia(); }
    catch (error) { console.warn('Media maintenance could not finish:', error instanceof Error ? error.name : 'UnknownError'); }
    finally { state.flowblockMaintenanceBusy = false; }
  };
  state.flowblockMaintenance = setInterval(sweep, 5 * 60 * 1000);
  state.flowblockMaintenance.unref();
  void sweep();
}
