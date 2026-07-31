import { controlPlane } from "../../../../lib/control-plane";
import { CheckpointForm } from "./checkpoint-form";
import { submitClassification } from "./actions";

/**
 * Only the blind operator view is fetched. This page never requests a comparison, a reveal, or any
 * endpoint carrying the agent's committed classification.
 */
interface BlindCheckpointView {
  checkpoint: { id: string; packageHash: string; package: unknown };
}

export default async function CheckpointPage({ params }: { params: Promise<{ checkpointId: string }> }) {
  const { checkpointId } = await params;
  const view = await controlPlane<BlindCheckpointView>(`/internal/operator/checkpoints/${checkpointId}`);
  return (
    <CheckpointForm
      checkpointId={checkpointId}
      packageHash={view.checkpoint.packageHash}
      frozenPackage={view.checkpoint.package}
      action={submitClassification}
    />
  );
}
