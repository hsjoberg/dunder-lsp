--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

-- Existing attempts predate explicit dispatch tracking, so treat them as if
-- their RPC may already have reached lnd. New code explicitly inserts zero and
-- flips this flag immediately before calling OpenChannelSync.
ALTER TABLE channelOpenAttempt
ADD COLUMN rpcDispatched BOOLEAN NOT NULL DEFAULT 1
CHECK (rpcDispatched IN (0, 1));

-- Keep an audit count of the preferred-mode attempt and its optional safe
-- fallback. Existing attempts conservatively count as one dispatch.
ALTER TABLE channelOpenAttempt
ADD COLUMN dispatchCount INTEGER NOT NULL DEFAULT 1
CHECK (dispatchCount >= 0);
