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

export const emptyAchievementState = (): AchievementState => ({
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
