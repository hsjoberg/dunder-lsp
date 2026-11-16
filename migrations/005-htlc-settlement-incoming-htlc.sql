--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

-- The block height at which the incoming HTLC expires. Dunder force-closes the
-- incoming channel shortly before it if the payer still hasn't locked the
-- settlement in, so lnd can claim the HTLC on-chain. NULL for older rows.
ALTER TABLE htlcSettlement
ADD COLUMN incomingExpiry INTEGER NULL;

-- What the incoming HTLC actually carried (amountMsat is what it forwards to
-- the fake channel), so past settlements can be audited. NULL for older rows.
ALTER TABLE htlcSettlement
ADD COLUMN incomingAmountMsat TEXT NULL;
