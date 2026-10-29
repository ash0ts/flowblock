import {
  defaultScene,
  defaultGear,
  defaultIntent,
  compilePlan,
} from "@/domain";
import { ShotCard } from "@/app/_shared/shot-card";
export default function SamplePage() {
  return (
    <ShotCard
      plan={compilePlan(
        defaultScene,
        defaultGear,
        defaultIntent,
        "quarter-orbit",
      )}
      label="Sample product study"
    />
  );
}
