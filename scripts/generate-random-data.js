const Long = require("long");
const getDb = require("../dist/db/db").default;

const { createChannelRequest, createHtlcSettlement } = require("../dist/db/ondemand-channel");
const {
  bytesToHexString,
  generateShortChannelId,
  generateBytes,
  randomIntegerRange,
} = require("../dist/utils/common");

const { getUnixTime, subDays } = require("date-fns");

(async () => {
  const db = await getDb();

  const numChannelRequests = 1000;

  const lastDay = new Date();
  const lastMonthDays = Array.from({ length: 30 }, (_, i) => subDays(lastDay, i));

  for (let i = 0; i < numChannelRequests; i++) {
    const channelId = Long.fromValue(await generateShortChannelId());
    const pubkey = bytesToHexString(await generateBytes(32));
    const preimage = bytesToHexString(await generateBytes(32));

    const expectedAmountSat = randomIntegerRange(100, 100000);

    await createChannelRequest(db, {
      channelId: channelId.toString(),
      expectedAmountSat,
      expire: 600,
      start: getUnixTime(lastMonthDays[randomIntegerRange(0, 29)]),
      pubkey,
      status: "DONE",
      preimage,
      // channelPoint,
    });

    const htlcTmp = randomIntegerRange(0, 10);
    for (let j = 0; j < randomIntegerRange(1, 2); j++) {
      await createHtlcSettlement(db, {
        channelId: channelId.toString(),
        amountSat: expectedAmountSat / (j + 1),
        claimed: true,
        settled: true,
        htlcId: htlcTmp + j,
      });
    }
  }

  console.log("Done");
})();
