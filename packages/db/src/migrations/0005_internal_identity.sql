-- packages/db/src/migrations/0005_internal_identity.sql
-- Binds every internal (operator/auditor) session to exactly one participant, so governance
-- evidence is attributed to an immutable identity rather than to a shared role token.
CREATE TABLE internal_access_tokens (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES participants(id),
  token_sha256 char(64) NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX internal_access_tokens_participant_idx ON internal_access_tokens (participant_id);

-- Issuance and revocation are recorded; a token row is never edited in place.
CREATE OR REPLACE FUNCTION reject_internal_token_rewrite() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'internal_access_tokens does not permit DELETE';
  END IF;
  IF NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'internal_access_tokens permits only revocation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER internal_access_tokens_revoke_only
BEFORE UPDATE OR DELETE ON internal_access_tokens
FOR EACH ROW EXECUTE FUNCTION reject_internal_token_rewrite();
