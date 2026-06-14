const claimChannelOpenInProgress = new Set<string>();

export async function withClaimChannelOpenLock(
  pubkey: string,
  callback: () => Promise<void>,
): Promise<boolean> {
  if (claimChannelOpenInProgress.has(pubkey)) {
    return false;
  }

  claimChannelOpenInProgress.add(pubkey);
  try {
    await callback();
    return true;
  } finally {
    claimChannelOpenInProgress.delete(pubkey);
  }
}

export function clearClaimChannelOpenLocksForTests() {
  claimChannelOpenInProgress.clear();
}
