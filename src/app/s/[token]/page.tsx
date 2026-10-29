import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { recompilePlan } from "@/server/planner";
import { ShotCard } from "@/app/_shared/shot-card";
export const dynamic = "force-dynamic";
export default async function SharedPlan({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) notFound();
  const row = (
    await db().query(
      "SELECT plan FROM shares WHERE token=$1 AND revoked_at IS NULL",
      [token],
    )
  ).rows[0];
  if (!row) notFound();
  return <ShotCard plan={recompilePlan(row.plan)} label="Shared shot card" />;
}
