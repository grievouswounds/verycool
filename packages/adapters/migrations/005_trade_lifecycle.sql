ALTER TABLE agent_order_operations
  ALTER COLUMN lifecycle_nonce TYPE text USING to_char(lifecycle_nonce, 'FM999999999999999999999999999999999999999999999999999999999999999999999999999999');

CREATE TABLE trade_triggers (
  id text PRIMARY KEY,
  trade_id text NOT NULL REFERENCES agent_order_operations(id),
  owner text NOT NULL,
  agent text NOT NULL,
  vault text NOT NULL,
  sell_token text NOT NULL,
  buy_token text NOT NULL,
  kind text NOT NULL,
  role text NOT NULL,
  trigger_price text,
  trail jsonb,
  activation_price text,
  high_water text,
  size jsonb NOT NULL,
  group_nonce text NOT NULL,
  intent_hash text NOT NULL,
  action_payload jsonb NOT NULL,
  signature text NOT NULL,
  status text NOT NULL,
  fire_job_id text,
  execution_transaction text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX trade_triggers_status ON trade_triggers(status, kind);
CREATE INDEX trade_triggers_trade ON trade_triggers(trade_id);

CREATE TABLE trade_cancellations (
  id text PRIMARY KEY,
  trade_id text NOT NULL REFERENCES agent_order_operations(id),
  cancellation_hash text NOT NULL UNIQUE,
  action_payload jsonb NOT NULL,
  typed_data jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE trigger_high_water (
  id text PRIMARY KEY,
  price text NOT NULL
);
