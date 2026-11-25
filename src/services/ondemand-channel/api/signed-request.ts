import { Client } from "@grpc/grpc-js";
import config from "config";
import { createHash } from "crypto";

import { verifyMessage } from "../../../utils/lnd-api";

/**
 * Wallet requests are signed with the wallet's node key (lnd SignMessage).
 *
 * Current scheme. The body is
 *   { "message": "<json>", "signature": "<zbase32>", "pubkey"?: "<hex>" }
 * where message is the JSON text that was signed:
 *   { "endpoint": "/ondemand-channel/register",
 *     "domain": "dunder.example.com",   // host of Dunder's serverDomain
 *     "timestamp": 1731628800,          // unix seconds
 *     "nonce": "<random string>",
 *     "data": { ...request fields... } }
 * The request fields are taken from the signed `data`, so the signature covers
 * them. A message is accepted only within SIGNED_MESSAGE_MAX_AGE_SECONDS of its
 * timestamp and only once.
 *
 * Legacy scheme (kept while wallets migrate, see `allowLegacySignatures`). The
 * body is { pubkey, signature, ...fields } and the signature covers only a
 * fixed word such as "REGISTER", so it can be replayed.
 */

export const SIGNED_MESSAGE_MAX_AGE_SECONDS = 30;
const MAX_MESSAGE_LENGTH = 12 * 1024;
const MAX_SIGNATURE_LENGTH = 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

function getRateLimitPerMinute() {
  return config.has("signedRequestRateLimitPerMinute")
    ? config.get<number>("signedRequestRateLimitPerMinute")
    : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

export type SignedEndpoint =
  | "/ondemand-channel/register"
  | "/ondemand-channel/claim"
  | "/ondemand-channel/check-status";

export type SignedEnvelope =
  | {
      kind: "MESSAGE";
      message: string;
      signature: string;
      claimedPubkey: string | null;
      data: Record<string, unknown>;
    }
  | {
      kind: "LEGACY";
      legacyMessage: string;
      signature: string;
      claimedPubkey: string;
      data: Record<string, unknown>;
    };

type Result<T> = { ok: true; value: T } | { ok: false; reason: string; statusCode?: number };

const consumedMessages = new Map<string, number>();
const requestCounts = new Map<string, { windowStart: number; count: number }>();

/**
 * Every verified request adds to both maps, so they hold about a minute of
 * requests. Sweeping them on every request would cost time proportional to
 * the request rate per request; at most once a second keeps it linear.
 */
const SWEEP_INTERVAL_MS = 1000;
let lastSweepAt = -Infinity;

function sweepExpired(nowMs: number) {
  if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS && nowMs >= lastSweepAt) {
    return;
  }
  lastSweepAt = nowMs;
  for (const [digest, expiresAt] of consumedMessages) {
    if (expiresAt <= nowMs) {
      consumedMessages.delete(digest);
    }
  }
  for (const [key, entry] of requestCounts) {
    if (nowMs - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      requestCounts.delete(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function legacySignaturesAllowed() {
  return config.has("allowLegacySignatures") ? config.get<boolean>("allowLegacySignatures") : true;
}

export function getServiceDomain() {
  return new URL(config.get<string>("serverDomain")).host.toLowerCase();
}

/**
 * Parses the request body and runs every check that doesn't need lnd. Run this
 * before any lnd RPC so malformed or stale requests are rejected cheaply.
 */
export function parseSignedEnvelope(
  body: unknown,
  endpoint: SignedEndpoint,
  legacyMessage: string,
  nowMs = Date.now(),
): Result<SignedEnvelope> {
  let parsed: unknown = body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ok: false, reason: "Invalid request." };
    }
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "Invalid request." };
  }

  const { message, signature, pubkey } = parsed;
  if (
    typeof signature !== "string" ||
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_LENGTH
  ) {
    return { ok: false, reason: "Invalid request." };
  }

  if (message === undefined) {
    if (!legacySignaturesAllowed()) {
      return {
        ok: false,
        reason: "Please update your wallet. This request must use a signed message.",
      };
    }
    if (typeof pubkey !== "string" || pubkey.length === 0 || pubkey.length > 130) {
      return { ok: false, reason: "Invalid request." };
    }
    const { message: _m, signature: _s, pubkey: _p, ...data } = parsed;
    return {
      ok: true,
      value: { kind: "LEGACY", legacyMessage, signature, claimedPubkey: pubkey, data },
    };
  }

  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: "Invalid request." };
  }
  if (pubkey !== undefined && (typeof pubkey !== "string" || pubkey.length > 130)) {
    return { ok: false, reason: "Invalid request." };
  }
  // verifyMessage sends lnd one byte per character (the low byte), so two
  // different non-ASCII texts can verify with the same signature and get past
  // the replay check. Signed messages are plain JSON; only ASCII is needed.
  if (!/^[\x00-\x7f]*$/.test(message)) {
    return { ok: false, reason: "Invalid signed message." };
  }

  let signed: unknown;
  try {
    signed = JSON.parse(message);
  } catch {
    return { ok: false, reason: "Invalid signed message." };
  }
  if (!isRecord(signed)) {
    return { ok: false, reason: "Invalid signed message." };
  }
  if (signed.endpoint !== endpoint) {
    return { ok: false, reason: "The signed message is for a different endpoint." };
  }
  if (typeof signed.domain !== "string" || signed.domain.toLowerCase() !== getServiceDomain()) {
    return { ok: false, reason: "The signed message is for a different service." };
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    typeof signed.timestamp !== "number" ||
    !Number.isSafeInteger(signed.timestamp) ||
    Math.abs(nowSeconds - signed.timestamp) > SIGNED_MESSAGE_MAX_AGE_SECONDS
  ) {
    return {
      ok: false,
      reason: "The signed message is either too old or from the future. Check the device clock.",
    };
  }
  if (typeof signed.nonce !== "string" || signed.nonce.length < 8 || signed.nonce.length > 128) {
    return { ok: false, reason: "Invalid signed message." };
  }
  if (signed.data !== undefined && !isRecord(signed.data)) {
    return { ok: false, reason: "Invalid signed message." };
  }

  return {
    ok: true,
    value: {
      kind: "MESSAGE",
      message,
      signature,
      claimedPubkey: typeof pubkey === "string" ? pubkey : null,
      data: (signed.data as Record<string, unknown> | undefined) ?? {},
    },
  };
}

/**
 * Verifies the signature with lnd and returns the signer's pubkey. A message in
 * the current scheme is accepted only once.
 */
export async function verifySignedEnvelope(
  lightning: Client,
  envelope: SignedEnvelope,
  nowMs = Date.now(),
): Promise<Result<string>> {
  const signedText = envelope.kind === "MESSAGE" ? envelope.message : envelope.legacyMessage;
  const verification = await verifyMessage(lightning, signedText, envelope.signature);
  // lnd's `valid` flag is deliberately ignored: it is only true for nodes in
  // lnd's channel graph, and a new wallet has no channels yet. The recovered
  // pubkey is what proves who signed.
  const pubkey = verification.pubkey;
  if (!pubkey || (envelope.claimedPubkey !== null && envelope.claimedPubkey !== pubkey)) {
    return {
      ok: false,
      reason:
        "The Public key provided doesn't match with the public key extracted from the signature. " +
        "Either the signature is wrong or you have signed with the wrong wallet.",
    };
  }

  sweepExpired(nowMs);
  if (envelope.kind === "MESSAGE") {
    const digest = createHash("sha256")
      .update(pubkey)
      .update("\0")
      .update(envelope.message)
      .digest("hex");
    if ((consumedMessages.get(digest) ?? -Infinity) > nowMs) {
      return { ok: false, reason: "This signed message has already been used." };
    }
    // Kept until the message can no longer pass the timestamp check: its
    // timestamp may be up to 30s ahead, it stays valid 30s past that, and the
    // check compares whole seconds (so up to 1s more on each side).
    consumedMessages.set(digest, nowMs + (SIGNED_MESSAGE_MAX_AGE_SECONDS * 2 + 2) * 1000);
  }

  if (!allowRequestForPubkey(pubkey, nowMs)) {
    return { ok: false, reason: "Too many requests. Try again in a minute.", statusCode: 429 };
  }

  return { ok: true, value: pubkey };
}

function allowRequestForPubkey(pubkey: string, nowMs: number) {
  const entry = requestCounts.get(pubkey);
  // An expired window the sweep hasn't removed yet starts over.
  if (!entry || nowMs - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    requestCounts.set(pubkey, { windowStart: nowMs, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= getRateLimitPerMinute();
}

/** Test helper. */
export function __resetSignedRequestState() {
  consumedMessages.clear();
  requestCounts.clear();
  lastSweepAt = -Infinity;
}

/** Test helper. */
export function __signedRequestStateSize() {
  return { consumedMessages: consumedMessages.size, requestCounts: requestCounts.size };
}
