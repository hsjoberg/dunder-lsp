import NodeCache from "node-cache";

const cacheTtlSeconds = 18 * 10 * 10;

const cacheCheckPeriod = 60 * 60;

export const updateCacheDelayMs = 18 * 1000 * 1000;

export const MSAT = 1000;

export const MIN_CHANNEL_SIZE_SAT = 20000;

export const MAX_CHANNEL_SIZE_SAT = 16777215;

export const cache = new NodeCache({
  checkperiod: cacheCheckPeriod,
  maxKeys: 2,
  stdTTL: cacheTtlSeconds,
  useClones: false,
});

export const cacheKey = 'graphCache';