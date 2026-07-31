-- packages/db/src/migrations/0004_authorization_carryover.sql
CREATE TABLE approval_carryovers (
  id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  from_plan_id uuid NOT NULL REFERENCES execution_plans(id),
  to_plan_id uuid NOT NULL REFERENCES execution_plans(id),
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_plan_id <> to_plan_id),
  UNIQUE (approval_id, to_plan_id)
);

CREATE TRIGGER approval_carryovers_immutable
BEFORE UPDATE OR DELETE ON approval_carryovers
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
