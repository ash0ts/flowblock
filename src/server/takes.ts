import { z } from "zod";
import { db, transaction } from "./db";
import { HttpError } from "./security";
import { deletePrefix } from "./storage";

export const takePrefix = (ownerId: string, takeId: string) =>
  `owners/${ownerId}/takes/${takeId}/`;

export async function getTake(id: string, ownerId: string) {
  z.string().uuid().parse(id);
  const result = await db().query(
    "SELECT * FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now()",
    [id, ownerId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Take not found.");
  return result.rows[0];
}

// Shared by explicit deletion and retention. Keep a tombstone so interrupted
// uploads/workers and failed storage deletion can be cleaned up on a later pass.
export async function deleteTake(id: string, ownerId: string) {
  z.string().uuid().parse(id);
  await transaction(async (client) => {
    const deleted = await client.query(
      "UPDATE takes SET deleted_at=COALESCE(deleted_at,now()),file_name='deleted',plan='{}'::jsonb,training_consent=false WHERE id=$1 AND owner_id=$2 RETURNING id",
      [id, ownerId],
    );
    if (!deleted.rowCount) throw new HttpError(404, "Take not found.");
    await client.query(
      "DELETE FROM revisions r USING jobs j WHERE r.owner_id=$1 AND j.owner_id=$1 AND r.provenance->>'analysisJobId'=j.id::text AND j.payload->>'takeId'=$2",
      [ownerId, id],
    );
    await client.query(
      "UPDATE jobs SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()),lease_token=NULL,result=NULL,error=NULL,payload=jsonb_build_object('takeId',$2::text,'deleted',true),updated_at=now() WHERE owner_id=$1 AND payload->>'takeId'=$2",
      [ownerId, id],
    );
  });
  await deletePrefix(takePrefix(ownerId, id));
  await db().query(
    "UPDATE takes SET cleanup_checked_at=now() WHERE id=$1 AND owner_id=$2",
    [id, ownerId],
  );
}
