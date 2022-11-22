import { Client } from "@grpc/grpc-js";
import { auto, forever } from "async";
import NodeCache from "node-cache";
import { describeGraph } from "../../utils/lnd-api";
import {cacheKey, updateCacheDelayMs} from '../constants'

// Updates caches on startup and every 5 hours forever.

type Args = {
  cache: NodeCache
  lightning: Client
}
export default async function cacheGraphOnStartup({cache, lightning}: Args) {
  try {
    return (await auto({
      // Check arguments
      validate: (cbk: any) => {
        if (!cache) {
          return cbk([400, 'ExpectedNodeJsCacheGraphOnStartup']);
        }

        if (!lightning) {
          return cbk([400, 'ExpectedLightningClientToCacheGraphOnStartup']);
        }

        return cbk();
      },

      // Set cache initially
      setCache: [
        'validate',
        async () => {
          // Check if cache exists and return
          const cachedData = cache.get(cacheKey);

          if (!!cachedData) {
            return cachedData;
          }

          const result = await describeGraph(lightning);

          cache.set(cacheKey, result);

          return result;
        }
      ],

      // Update cache every 5 hours
      updateCache: [
        'setCache',
        ({}, cbk) => {
          forever(
            () => {
              const updateCache = async () => {
                const result = await describeGraph(lightning);

                cache.del(cacheKey);

                cache.set(cacheKey, result);
              };

              setInterval(updateCache, updateCacheDelayMs);
            },
            err => {
              return cbk(err);
            }
          );
          return cbk();
        },
      ],
    })).setCache;
  } catch (err: any) {
    // Delete cache on failure
    cache.del(cacheKey);
    throw new Error(err);
  }
}