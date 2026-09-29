CREATE TABLE api_keys (
  key_id      uuid PRIMARY KEY,
  name        text NOT NULL,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  scopes      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX api_keys_active_idx ON api_keys (key_id)
  WHERE revoked_at IS NULL;
