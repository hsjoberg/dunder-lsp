--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

-- Keep the exact millisatoshi amount for new MPP accounting. Existing rows
-- only recorded whole satoshis, so preserve that recorded value on backfill.
ALTER TABLE htlcSettlement ADD COLUMN amountMsat TEXT NULL;
UPDATE htlcSettlement
SET amountMsat = CAST(amountSat * 1000 AS TEXT)
WHERE amountMsat IS NULL;

-- Only registrations created by code that knows about durable recovery enter
-- the automatic-open queue. Historical unclaimed rows remain claimable, but a
-- deployment must not unexpectedly open all of them during startup.
ALTER TABLE channelRequest
ADD COLUMN automaticOpenQueued BOOLEAN NOT NULL DEFAULT 0
CHECK (automaticOpenQueued IN (0, 1));

-- A settlement is reserved for exactly one channel-open attempt before the
-- external lnd side effect is started. The reservation is intentionally kept
-- after completion as an audit trail.
ALTER TABLE htlcSettlement ADD COLUMN channelOpenAttemptId TEXT NULL;

CREATE TABLE channelOpenAttempt (
  attemptId TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  source TEXT NOT NULL,
  requestedChannelId TEXT NULL,
  status TEXT NOT NULL,
  grossAmountSat INTEGER NOT NULL,
  feeSat INTEGER NOT NULL,
  pushAmountSat INTEGER NOT NULL,
  existingChannelPoints TEXT NOT NULL,
  channelPoint TEXT NULL,
  error TEXT NULL,
  spendUnconfirmed BOOLEAN NOT NULL,
  zeroConf BOOLEAN NOT NULL,
  taprootChannel BOOLEAN NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,

  CHECK (source IN ('AUTOMATIC', 'CLAIM', 'AUTO_HEAL')),
  CHECK (status IN ('OPENING', 'UNKNOWN', 'OPENED', 'CANCELLED')),
  CHECK (spendUnconfirmed IN (0, 1)),
  CHECK (zeroConf IN (0, 1)),
  CHECK (taprootChannel IN (0, 1))
);

-- OPENING and UNKNOWN both block another payout to the same peer. UNKNOWN is
-- deliberately non-terminal: an ambiguous OpenChannelSync result must be
-- reconciled, never blindly retried.
CREATE UNIQUE INDEX index_channelOpenAttempt_active_pubkey
ON channelOpenAttempt(pubkey)
WHERE status IN ('OPENING', 'UNKNOWN');

CREATE INDEX index_htlcSettlement_channelOpenAttemptId
ON htlcSettlement(channelOpenAttemptId);
