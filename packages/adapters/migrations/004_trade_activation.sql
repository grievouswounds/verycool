ALTER TABLE agent_order_operations
  ADD COLUMN deployment_transaction text,
  ADD COLUMN action_payload jsonb,
  ADD COLUMN lifecycle_signature text,
  ADD COLUMN prerequisite_transactions jsonb NOT NULL DEFAULT '[]'::jsonb;
