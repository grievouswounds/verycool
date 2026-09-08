CREATE TABLE webauthn_credentials (
  credential_id text PRIMARY KEY,
  owner text NOT NULL,
  public_key bytea NOT NULL,
  counter bigint NOT NULL,
  transports jsonb NOT NULL,
  aaguid text NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webauthn_credentials_owner ON webauthn_credentials(owner);

CREATE TABLE webauthn_challenges (
  id text PRIMARY KEY,
  owner text NOT NULL,
  challenge text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('registration','authentication')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges(expires_at);

CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  redirect_uris jsonb NOT NULL,
  scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  owner text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE oauth_authorization_requests (
  challenge_id text PRIMARY KEY,
  owner text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  state text NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX oauth_authorization_codes_expiry ON oauth_authorization_codes(expires_at);
CREATE TABLE oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  family_id text NOT NULL,
  owner text NOT NULL,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_refresh_tokens_family ON oauth_refresh_tokens(family_id);

CREATE TABLE agent_order_operations (
  id text PRIMARY KEY,
  owner text NOT NULL,
  agent text NOT NULL,
  vault text NOT NULL UNIQUE,
  sell_token text NOT NULL,
  buy_token text NOT NULL,
  sell_amount numeric(78,0) NOT NULL,
  funded_amount numeric(78,0) NOT NULL DEFAULT 0,
  state text NOT NULL,
  lifecycle_nonce numeric(78,0) NOT NULL,
  payment_identifier text UNIQUE,
  payment_transaction text,
  lifecycle_transaction text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX agent_order_operations_owner ON agent_order_operations(owner, updated_at DESC);
