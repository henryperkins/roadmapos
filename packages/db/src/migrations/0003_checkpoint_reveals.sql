-- packages/db/src/migrations/0003_checkpoint_reveals.sql
CREATE TABLE checkpoint_reveals (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  comparison_id uuid NOT NULL REFERENCES judgment_comparisons(id),
  revealed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TRIGGER checkpoint_reveals_immutable
BEFORE UPDATE OR DELETE ON checkpoint_reveals
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
