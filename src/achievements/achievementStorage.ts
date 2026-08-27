import type { AchievementId } from "./achievementDefinitions";

export type AchievementState = {
  cleanupCount: number;
  cleanedTokenCount: number;
  uniqueTokenAddresses: string[];
  totalCleanedUsd: number;
  largestCleanupUsd: number;
  bridgeCount: number;
  totalBridgeVolumeUsd: number;
  bridgeChainIds: number[];
  unlocked: AchievementId[];
};

const STORAGE_PREFIX = "dustengine:achievements:";

const emptyState = (): AchievementState => ({
  cleanupCount: 0,
  cleanedTokenCount: 0,
  uniqueTokenAddresses: [],
  totalCleanedUsd: 0,
  largestCleanupUsd: 0,
  bridgeCount: 0,
  totalBridgeVolumeUsd: 0,
  bridgeChainIds: [],
  unlocked: [],
});

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

export function loadAchievementState(address: string): AchievementState {
  if (typeof window === "undefined") {
    return emptyState();
  }

  try {
    const raw = window.localStorage.getItem(storageKey(address));

    if (!raw) {
      return emptyState();
    }

    const parsed = JSON.parse(raw) as Partial<AchievementState>;

    return {
      ...emptyState(),
      ...parsed,
      uniqueTokenAddresses: Array.isArray(parsed.uniqueTokenAddresses)
        ? parsed.uniqueTokenAddresses
        : [],
      bridgeChainIds: Array.isArray(parsed.bridgeChainIds)
        ? parsed.bridgeChainIds
        : [],
      unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked : [],
    };
  } catch {
    return emptyState();
  }
}

export function saveAchievementState(
  address: string,
  state: AchievementState,
) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    storageKey(address),
    JSON.stringify(state),
  );
}

export function updateAchievementState(
  address: string,
  updater: (state: AchievementState) => AchievementState,
) {
  const current = loadAchievementState(address);
  const updated = updater(current);

  saveAchievementState(address, updated);

  return updated;
}
