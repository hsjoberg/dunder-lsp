import { Client } from "@grpc/grpc-js";
import { auto } from "async";
import NodeCache from "node-cache";
import { describeGraph } from "../../utils/lnd-api";
import { cacheKey } from "../constants";

// Gets result from describe graph API

type Args = {
  cache: NodeCache;
  lightning: Client;
};
export default async function describeGraphApi({ cache, lightning }: Args) {
  try {
    return (
      await auto({
        // Check arguments
        validate: (cbk: any) => {
          if (!cache) {
            return cbk([400, "ExpectedNodeJsCacheToGetGraph"]);
          }

          if (!lightning) {
            return cbk([400, "ExpectedLightningClientToGetGraph"]);
          }

          return cbk();
        },

        getGraph: [
          "validate",
          async () => {
            // Check if cache exists and return
            const cachedData = cache.get(cacheKey);

            if (!!cachedData) {
              return cachedData;
            }

            const result = await describeGraph(lightning);

            cache.set(cacheKey, result);

            return result;
          },
        ],
      })
    ).getGraph;
  } catch (err: any) {
    // Delete cache on failure
    cache.del(cacheKey);
    throw new Error(err);
  }
}
