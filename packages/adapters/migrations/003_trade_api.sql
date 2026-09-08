CREATE TABLE owner_agent_bindings (
  owner text PRIMARY KEY,
  agent text NOT NULL UNIQUE,
  bound_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE agent_binding_challenges (
  id text PRIMARY KEY,
  owner text NOT NULL,
  agent text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE trade_previews (
  id text PRIMARY KEY,
  preview_hash text NOT NULL UNIQUE,
  owner text NOT NULL,
  agent text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready','submitted','expired','unsafe')),
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  lifecycle_nonce text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  submitted_at timestamptz
);
CREATE INDEX trade_previews_owner_created ON trade_previews(owner, created_at DESC);

CREATE TABLE delegation_previews (
  id text PRIMARY KEY,
  preview_hash text NOT NULL UNIQUE,
  owner text NOT NULL,
  agent text NOT NULL,
  token text NOT NULL,
  max_per_order numeric(78,0) NOT NULL,
  max_per_day numeric(78,0) NOT NULL,
  valid_until timestamptz NOT NULL,
  typed_data jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE delegation_projections (
  owner text NOT NULL,
  agent text NOT NULL,
  token text NOT NULL,
  max_per_order numeric(78,0) NOT NULL,
  max_per_day numeric(78,0) NOT NULL,
  spent_today numeric(78,0) NOT NULL DEFAULT 0,
  day_number bigint NOT NULL,
  valid_until timestamptz NOT NULL,
  registration_transaction text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(owner, agent, token)
);

CREATE TABLE token_metadata (
  chain_id bigint NOT NULL,
  address text NOT NULL,
  name text NOT NULL,
  symbol text NOT NULL,
  decimals integer NOT NULL,
  code_hash text NOT NULL,
  validation jsonb NOT NULL,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY(chain_id, address)
);

CREATE TABLE subscribed_trades (
  id text PRIMARY KEY,
  owner text NOT NULL,
  watched_address text NOT NULL,
  transaction_hash text NOT NULL,
  sell_token text NOT NULL,
  buy_token text NOT NULL,
  sell_amount numeric(78,0) NOT NULL,
  buy_amount numeric(78,0) NOT NULL,
  block_number bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  raw_activity_ids jsonb NOT NULL,
  UNIQUE(owner, watched_address, transaction_hash)
);
CREATE INDEX subscribed_trades_feed ON subscribed_trades(owner, occurred_at DESC, id DESC);

CREATE TABLE x402_settlements (
  payment_identifier text PRIMARY KEY,
  preview_id text NOT NULL REFERENCES trade_previews(id),
  payer text NOT NULL,
  state text NOT NULL CHECK (state IN ('verifying','settling','pending','settled','failed')),
  payload jsonb NOT NULL,
  transaction_hash text,
  error text,
  updated_at timestamptz NOT NULL
);
