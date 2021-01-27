--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

CREATE TABLE channelRequest (
  channelId TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  preimage TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expire INTEGER NOT NULL,
  expectedAmountSat INTEGER NULL,
  actualSettledAmountSat INTEGER NULL -- The actual amount Dunder LSP settled
);
CREATE INDEX index_channelRequest_pubkey ON channelRequest(pubkey);
