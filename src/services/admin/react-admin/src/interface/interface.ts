export type ChannelRequestStatus =
  | "NOT_REGISTERED"
  | "REGISTERED"
  | "WAITING_FOR_SETTLEMENT"
  | "SETTLED"
  | "DONE";

export interface IChannelRequest {
  id: string;

  channelId: string;
  pubkey: string;
  preimage: string;
  status: ChannelRequestStatus;
  start: number;
  expire: number;
  expectedAmountSat: number;
  channelPoint: string | null;

  expired: boolean;
}

export interface IHtlcSettlement {
  id: string;

  channelId: string;
  htlcId: number;
  amountSat: number;
  settled: boolean;
  claimed: boolean;
}
