--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

-- The incoming channel's funding outpoint when the part was recorded. Once the
-- channel is closing, lnd lists it only by this outpoint, and the deadline
-- guard needs it to bump the close's fee. NULL for older rows and when lnd
-- didn't list the channel.
ALTER TABLE htlcSettlement
ADD COLUMN incomingChannelPoint TEXT NULL;
