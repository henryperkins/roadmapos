-- packages/db/src/migrations/0002_execution_workflows.sql
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL REFERENCES pilot_studies(id),
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  policy_version_id uuid NOT NULL REFERENCES repository_policy_versions(id),
  condition text NOT NULL CHECK (condition IN ('interactive_copilot', 'governed_orchestration')),
  state text NOT NULL CHECK (state IN ('registered', 'planning', 'awaiting_plan_approval', 'awaiting_instruction', 'proposing_action', 'awaiting_operator_gate', 'awaiting_escalation_approval', 'executing_action', 'awaiting_review_ready', 'verifying_endpoint', 'completed', 'terminated')),
  base_sha char(40) NOT NULL,
  branch_name text NOT NULL,
  current_plan_id uuid,
  termination_reason text,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_item_id)
);

CREATE TABLE execution_plans (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  version integer NOT NULL CHECK (version > 0),
  plan_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  base_sha char(40) NOT NULL,
  supersedes_plan_id uuid REFERENCES execution_plans(id),
  change_classification text CHECK (change_classification IN ('initial', 'pending_operator_classification', 'editorial', 'material')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version),
  UNIQUE (run_id, content_hash)
);
ALTER TABLE runs ADD CONSTRAINT runs_current_plan_fk FOREIGN KEY (current_plan_id) REFERENCES execution_plans(id);

CREATE OR REPLACE FUNCTION reject_unmanaged_run_state_update() RETURNS trigger AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
     AND current_setting('roadmapos.allow_run_state_transition', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'runs.state may change only through ExecutionRepository';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER runs_state_managed
BEFORE UPDATE OF state ON runs
FOR EACH ROW EXECUTE FUNCTION reject_unmanaged_run_state_update();

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  request_type text NOT NULL CHECK (request_type IN ('execution_plan', 'escalation')),
  request_id uuid NOT NULL,
  request_version integer NOT NULL,
  request_hash char(64) NOT NULL,
  github_user_id bigint NOT NULL,
  github_login text NOT NULL,
  repository_permission text NOT NULL CHECK (repository_permission IN ('write', 'maintain', 'admin')),
  policy_version_id uuid NOT NULL REFERENCES repository_policy_versions(id),
  base_sha char(40) NOT NULL,
  github_comment_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_type, request_id, github_user_id)
);

CREATE TABLE approval_invalidations (
  id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  reason text NOT NULL,
  invalidated_by_event_id uuid NOT NULL REFERENCES pilot_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id)
);

CREATE TABLE explicit_instructions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  version integer NOT NULL CHECK (version > 0),
  instruction_text text NOT NULL,
  content_hash char(64) NOT NULL,
  github_user_id bigint NOT NULL,
  github_comment_id bigint NOT NULL,
  repository_permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version),
  UNIQUE (run_id, github_comment_id)
);

CREATE TABLE action_proposals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  action_json jsonb NOT NULL,
  action_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'authorized', 'executing', 'executed', 'rejected', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, action_hash)
);

CREATE TABLE governance_checkpoints (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  action_proposal_id uuid REFERENCES action_proposals(id),
  source text NOT NULL CHECK (source IN ('agent_detected', 'operator_detected', 'plan_revision', 'challenge')),
  package_json jsonb NOT NULL,
  package_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, package_hash)
);

CREATE TABLE judgment_classifications (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  actor_type text NOT NULL CHECK (actor_type IN ('agent', 'operator', 'auditor', 'expected')),
  sealed_payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id, actor_type)
);

CREATE TABLE judgment_comparisons (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  agent_payload jsonb NOT NULL,
  operator_payload jsonb NOT NULL,
  decision_agreement boolean NOT NULL,
  boundary_agreement boolean NOT NULL,
  unsafe_false_negative boolean NOT NULL,
  conservative_false_positive boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TABLE live_gate_decisions (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  operator_decision text NOT NULL CHECK (operator_decision IN ('continue', 'pause_and_escalate', 'stop')),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TABLE escalations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  version integer NOT NULL CHECK (version > 0),
  escalation_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version),
  UNIQUE (run_id, content_hash)
);

CREATE TABLE deviations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint_id uuid NOT NULL REFERENCES governance_checkpoints(id),
  disclosure_json jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkpoint_id)
);

CREATE TABLE draft_pull_requests (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  github_pull_request_id bigint NOT NULL,
  number integer NOT NULL,
  html_url text NOT NULL,
  head_sha char(40) NOT NULL,
  body_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id),
  UNIQUE (github_pull_request_id)
);

CREATE TABLE run_transcript_entries (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  sequence integer NOT NULL,
  role text NOT NULL CHECK (role IN ('system', 'agent', 'maintainer', 'tool', 'operator')),
  content text NOT NULL,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TABLE github_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text
);

CREATE TRIGGER execution_plans_immutable
BEFORE UPDATE OR DELETE ON execution_plans
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER approvals_immutable
BEFORE UPDATE OR DELETE ON approvals
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER explicit_instructions_immutable
BEFORE UPDATE OR DELETE ON explicit_instructions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER governance_checkpoints_immutable
BEFORE UPDATE OR DELETE ON governance_checkpoints
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER judgment_classifications_immutable
BEFORE UPDATE OR DELETE ON judgment_classifications
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER judgment_comparisons_immutable
BEFORE UPDATE OR DELETE ON judgment_comparisons
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER live_gate_decisions_immutable
BEFORE UPDATE OR DELETE ON live_gate_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER deviations_immutable
BEFORE UPDATE OR DELETE ON deviations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
