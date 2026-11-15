--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

-- lnd channel IDs are unsigned 64-bit integers. They used to pass through a
-- JavaScript number (exact only up to 2^53) before reaching SQLite, so two
-- channels opened by the same funding transaction could collide. Store the
-- incoming circuit key as decimal TEXT instead. lnd alias channel IDs are also
-- above SQLite's signed 64-bit INTEGER range, so TEXT is required for those.
CREATE TABLE htlcSettlement_new (
  channelId TEXT NOT NULL,
  incomingChannelId TEXT NOT NULL,
  htlcId TEXT NOT NULL,
  amountSat INTEGER NOT NULL,
  settled BOOLEAN NOT NULL,
  claimed BOOLEAN NOT NULL,
  amountMsat TEXT NULL,
  channelOpenAttemptId TEXT NULL,

  PRIMARY KEY (channelId, incomingChannelId, htlcId),
  FOREIGN KEY (channelId) REFERENCES channelRequest(channelId),
  CHECK (settled IN (0, 1)),
  CHECK (claimed IN (0, 1))
);

-- Values that were already rounded by the old code keep their rounded value.
INSERT INTO htlcSettlement_new
  (channelId, incomingChannelId, htlcId, amountSat, settled, claimed, amountMsat, channelOpenAttemptId)
SELECT
  channelId,
  CASE WHEN typeof(incomingChannelId) = 'real'
       THEN printf('%.0f', incomingChannelId)
       ELSE CAST(incomingChannelId AS TEXT) END,
  CASE WHEN typeof(htlcId) = 'real'
       THEN printf('%.0f', htlcId)
       ELSE CAST(htlcId AS TEXT) END,
  amountSat,
  settled,
  claimed,
  amountMsat,
  channelOpenAttemptId
FROM htlcSettlement;

DROP TABLE htlcSettlement;
ALTER TABLE htlcSettlement_new RENAME TO htlcSettlement;

CREATE INDEX index_htlcSettlement_channelOpenAttemptId
ON htlcSettlement(channelOpenAttemptId);

CREATE INDEX index_htlcSettlement_circuitKey
ON htlcSettlement(incomingChannelId, htlcId);

-- How a dispatched OpenChannelSync failed:
--   LND_REJECTED: lnd answered with an error of its own (nothing was funded)
--   AMBIGUOUS:    transport error or no answer (lnd may still be funding)
ALTER TABLE channelOpenAttempt
ADD COLUMN failureKind TEXT NULL
CHECK (failureKind IS NULL OR failureKind IN ('LND_REJECTED', 'AMBIGUOUS'));

-- Closed channel points to the peer at reservation time. Lets recovery tell a
-- channel that was opened by this attempt and already closed again apart from
-- older closed channels. NULL for attempts created before this migration.
ALTER TABLE channelOpenAttempt
ADD COLUMN existingClosedChannelPoints TEXT NULL;
