CREATE SEQUENCE deposit_address_index_seq MINVALUE 0 START 0;

CREATE TABLE deposit_addresses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL UNIQUE,
  derivation_index integer NOT NULL UNIQUE DEFAULT nextval('deposit_address_index_seq'),
  address          text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deposits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,
  address      text NOT NULL,
  asset        text NOT NULL,
  amount       numeric(78,0) NOT NULL CHECK (amount > 0),
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,           -- -1 for native transfers
  block_number bigint NOT NULL,
  block_hash   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'orphaned')),
  confirmed_at timestamptz,
  notified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX deposits_status_idx ON deposits (status);
CREATE INDEX deposits_user_idx ON deposits (user_id);
CREATE INDEX deposits_address_idx ON deposits (address);

CREATE TABLE watcher_state (
  key   text PRIMARY KEY,
  value bigint NOT NULL
);

CREATE TABLE withdrawals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  asset           text NOT NULL,
  amount          numeric(78,0) NOT NULL CHECK (amount > 0),
  to_address      text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'broadcasting', 'broadcast', 'confirmed', 'failed')),
  idempotency_key text NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  nonce           bigint,
  gas_limit       numeric(78,0),
  max_fee         numeric(78,0),
  priority_fee    numeric(78,0),
  raw_tx          text,
  tx_hash         text,
  tx_hashes       text[] NOT NULL DEFAULT '{}',
  gas_bumps       integer NOT NULL DEFAULT 0,
  last_sent_at    timestamptz,
  block_number    bigint,
  error           text,
  notified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_status_idx ON withdrawals (status);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, asset, created_at);

CREATE TABLE sweeps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset        text NOT NULL,
  from_address text NOT NULL,
  amount       numeric(78,0) NOT NULL,
  tx_hash      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sweep', 'gas_topup')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
