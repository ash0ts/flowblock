import { db } from "./db";
import { deleteTake } from "./takes";

export async function cleanupMedia(): Promise<number> {
  const expired = await db().query(
    "SELECT id,owner_id FROM takes WHERE expires_at<=now() OR deleted_at IS NOT NULL ORDER BY COALESCE(cleanup_checked_at,'epoch'::timestamptz) LIMIT 500",
  );
  const failures: unknown[] = [];
  for (const take of expired.rows) {
    try {
      await deleteTake(take.id, take.owner_id);
    } catch (error) {
      failures.push(error);
    } finally {
      // Rotate attempted tombstones even when storage fails, so one broken
      // prefix cannot starve later expired takes in a bounded sweep.
      await db().query(
        "UPDATE takes SET cleanup_checked_at=now() WHERE id=$1",
        [take.id],
      );
    }
  }
  await db().query(
    "UPDATE jobs SET status='failed',error='The application stopped before planning completed. Your local draft is preserved.',updated_at=now() WHERE kind='plan' AND status='running' AND updated_at<now()-interval '2 minutes'",
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "Some media could not be removed; cleanup will retry.",
    );
  return expired.rowCount || 0;
}

const state = globalThis as unknown as {
  flowblockMaintenance?: ReturnType<typeof setInterval>;
  flowblockMaintenanceBusy?: boolean;
};
export function startMaintenance() {
  if (state.flowblockMaintenance) return;
  const sweep = async () => {
    if (state.flowblockMaintenanceBusy) return;
    state.flowblockMaintenanceBusy = true;
    try {
      await cleanupMedia();
    } catch (error) {
      console.warn(
        "Media maintenance could not finish:",
        error instanceof Error ? error.name : "UnknownError",
      );
    } finally {
      state.flowblockMaintenanceBusy = false;
    }
  };
  state.flowblockMaintenance = setInterval(sweep, 5 * 60 * 1000);
  state.flowblockMaintenance.unref();
  void sweep();
}
