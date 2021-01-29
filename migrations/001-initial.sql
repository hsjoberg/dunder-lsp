--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

CREATE TABLE channelRequest (
  channelId TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  preimage TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expire INTEGER NOT NULL,
  expectedAmountSat INTEGER NOT NULL,
  channelPoint TEXT NULL
);
CREATE INDEX index_channelRequest_pubkey ON channelRequest(pubkey);


CREATE TABLE htlcSettlement (
  channelId TEXT NOT NULL,
  htlcId INTEGER NOT NULL,
  amountSat INTEGER NOT NULL,
  settled BOOLEAN NOT NULL,

  CONSTRAINT primarykey_htlcSettlement PRIMARY KEY (channelId, htlcId)
  -- TODO foreign key channelId
);
