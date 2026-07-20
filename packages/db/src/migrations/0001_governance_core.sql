-- packages/db/src/migrations/0001_governance_core.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE pilot_studies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'preregistered', 'running', 'observation', 'complete', 'stopped')),
  preregistration_hash char(64),
  observation_window_days integer NOT NULL DEFAULT 14 CHECK (observation_window_days = 14),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL REFERENCES pilot_studies(id),
  github_repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  owner text NOT NULL,
  name text NOT NULL,
  default_branch text NOT NULL,
  policy_path text NOT NULL DEFAULT '.roadmapos/policy.yml',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pilot_id, github_repository_id),
  UNIQUE (pilot_id, owner, name)
);

CREATE TABLE repository_policy_versions (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  source_commit_sha char(40) NOT NULL,
  policy_json jsonb NOT NULL,
  policy_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, policy_hash)
);

CREATE TABLE participants (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL REFERENCES pilot_studies(id),
  github_user_id bigint NOT NULL,
  github_login text NOT NULL,
  study_role text NOT NULL CHECK (study_role IN ('maintainer', 'operator', 'auditor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pilot_id, github_user_id, study_role)
);

CREATE TABLE work_items (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  github_issue_number integer NOT NULL,
  github_issue_node_id text NOT NULL,
  title text NOT NULL,
  acceptance_criteria jsonb NOT NULL,
  expected_effort_band text NOT NULL CHECK (expected_effort_band IN ('under_30', '30_to_60', '61_to_120', 'over_120')),
  expected_governance_exposure text NOT NULL,
  condition text CHECK (condition IN ('interactive_copilot', 'governed_orchestration')),
  execution_order integer CHECK (execution_order IN (1, 2)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, github_issue_number)
);

CREATE TABLE matched_pairs (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL REFERENCES pilot_studies(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  work_item_a_id uuid NOT NULL REFERENCES work_items(id),
  work_item_b_id uuid NOT NULL REFERENCES work_items(id),
  governance_bearing boolean NOT NULL,
  matching_record jsonb NOT NULL,
  assignment_record jsonb,
  assignment_hash char(64),
  assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (work_item_a_id <> work_item_b_id),
  UNIQUE (work_item_a_id),
  UNIQUE (work_item_b_id)
);

CREATE TABLE pilot_events (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL REFERENCES pilot_studies(id),
  sequence integer NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'agent', 'maintainer', 'operator', 'auditor', 'github')),
  actor_id text NOT NULL,
  payload jsonb NOT NULL,
  previous_hash char(64),
  event_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pilot_id, sequence),
  UNIQUE (pilot_id, event_hash)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs (status, available_at, created_at);

CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % does not permit %', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER repository_policy_versions_immutable
BEFORE UPDATE OR DELETE ON repository_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER pilot_events_immutable
BEFORE UPDATE OR DELETE ON pilot_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
