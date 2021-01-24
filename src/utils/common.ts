import { randomBytes } from "crypto";

export const hexToUint8Array = (hexString: string) => {
  return new Uint8Array(hexString.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
};

export const stringToUint8Array = (str: string) => {
  return Uint8Array.from(str, (x) => x.charCodeAt(0));
};

export const bytesToHexString = (bytes: Buffer | Uint8Array) => {
  // console.log("inside bytesToHexString");
  // console.log(bytes);
  return bytes.reduce(function (memo, i) {
    return memo + ("0" + i.toString(16)).slice(-2); //padd with leading 0 if <16
  }, "");
};

export const generateShortChannelId = (): Promise<number> => {
  // According to https://github.com/lightningnetwork/lightning-rfc/blob/master/01-messaging.md#fundamental-types
  // `short_channel_id` is 8 byte
  return new Promise((resolve, reject) => {
    randomBytes(8, function (error, buffer) {
      if (error) {
        reject(error);
        return;
      }
      resolve(buffer.readUInt32BE());
    });
  });
};
