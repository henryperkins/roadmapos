-- packages/db/src/migrations/0006_execution_attempts.sql
-- Makes an execution recoverable. A bare authorized -> executing flip left a crashed action stuck
-- forever, and a crash between a successful push and its projection left the repository and the
-- database disagreeing with no record of which was right.

CREATE TABLE execution_attempts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  proposal_id uuid NOT NULL REFERENCES action_proposals(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  action_hash char(64) NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'reconciling')),
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result_hash char(64),
  last_error text,
  UNIQUE (proposal_id, attempt)
);

CREATE INDEX execution_attempts_recovery_idx ON execution_attempts (state, lease_expires_at);
CREATE INDEX execution_attempts_run_idx ON execution_attempts (run_id);

-- One row per intended external side effect, written before the effect is attempted and confirmed
-- after. Reconciliation reads these to decide what a crashed attempt actually did.
CREATE TABLE execution_outbox (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES execution_attempts(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  effect_kind text NOT NULL CHECK (effect_kind IN ('git_commit_push', 'github_draft_pull_request', 'github_issue_comment', 'github_check')),
  idempotency_key text NOT NULL UNIQUE,
  request_json jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'dispatched', 'confirmed', 'abandoned')),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  confirmed_at timestamptz,
  last_error text
);

CREATE INDEX execution_outbox_attempt_idx ON execution_outbox (attempt_id);
CREATE INDEX execution_outbox_state_idx ON execution_outbox (state);

-- An attempt's identity and its authorization are fixed at creation; only its lifecycle moves.
CREATE OR REPLACE FUNCTION reject_execution_attempt_rewrite() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_attempts does not permit DELETE';
  END IF;
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.action_hash IS DISTINCT FROM OLD.action_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'execution_attempts permits only lifecycle updates';
  END IF;
  IF OLD.state IN ('succeeded', 'failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'execution_attempts is terminal in state %', OLD.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_attempts_lifecycle_only
BEFORE UPDATE OR DELETE ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION reject_execution_attempt_rewrite();

CREATE OR REPLACE FUNCTION reject_execution_outbox_rewrite() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_outbox does not permit DELETE';
  END IF;
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.effect_kind IS DISTINCT FROM OLD.effect_kind
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_json IS DISTINCT FROM OLD.request_json
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'execution_outbox permits only lifecycle updates';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_outbox_lifecycle_only
BEFORE UPDATE OR DELETE ON execution_outbox
FOR EACH ROW EXECUTE FUNCTION reject_execution_outbox_rewrite();
