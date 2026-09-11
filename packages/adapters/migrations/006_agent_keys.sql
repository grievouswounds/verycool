CREATE TABLE agent_keys (
  owner text PRIMARY KEY,
  agent text NOT NULL UNIQUE,
  wrapped_key bytea NOT NULL,
  wrap_scheme text NOT NULL,
  wrap_context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);
