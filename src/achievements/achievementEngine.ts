import {
  ACHIEVEMENTS,
  type AchievementId,
} from "./achievementDefinitions";
import {
  updateAchievementState,
  type AchievementState,
} from "./achievementStorage";

export type AchievementEvent =
  | {
      type: "dust-cleanup";
      tokenCount: number;
      tokenAddresses?: string[];
      valueUsd: number;
    }
  | {
      type: "bridge-complete";
      fromChainId: number;
      toChainId: number;
      volumeUsd: number;
    };

export type AchievementUpdate = {
  state: AchievementState;
  newlyUnlocked: AchievementId[];
};

function calculateUnlocked(state: AchievementState): AchievementId[] {
  const unlocked = new Set<AchievementId>(state.unlocked);

  if (state.cleanupCount >= 1) {
    unlocked.add("first-cleanup");
  }

  if (state.cleanedTokenCount >= 10) {
    unlocked.add("dust-cleaner");
  }

  if (state.cleanedTokenCount >= 25) {
    unlocked.add("dust-hunter");
  }

  if (state.bridgeCount >= 1) {
    unlocked.add("bridge-explorer");
  }

  if (state.bridgeCount >= 10) {
    unlocked.add("bridge-runner");
  }

  if (state.bridgeChainIds.length >= 3) {
    unlocked.add("chain-hopper");
  }

  if (state.uniqueTokenAddresses.length >= 25) {
    unlocked.add("token-hunter");
  }

  if (state.bridgeChainIds.length >= 10) {
    unlocked.add("cross-chain");
  }

  if (state.bridgeCount >= 25) {
    unlocked.add("bridge-master");
  }

  if (state.totalBridgeVolumeUsd >= 1000) {
    unlocked.add("bridge-legend");
  }

  return Array.from(unlocked);
}

export function recordAchievementEvent(
  address: string,
  event: AchievementEvent,
): AchievementUpdate {
  let newlyUnlocked: AchievementId[] = [];

  const state = updateAchievementState(address, (current) => {
    const previousUnlocked = new Set(current.unlocked);

    const next: AchievementState = {
      ...current,
    };

    if (event.type === "dust-cleanup") {
      next.cleanupCount += 1;
      next.cleanedTokenCount += Math.max(0, event.tokenCount);
      next.totalCleanedUsd += Math.max(0, event.valueUsd);
      next.largestCleanupUsd = Math.max(
        next.largestCleanupUsd,
        Math.max(0, event.valueUsd),
      );

      if (event.tokenAddresses) {
        const existing = new Set(
          next.uniqueTokenAddresses.map((token) => token.toLowerCase()),
        );

        for (const tokenAddress of event.tokenAddresses) {
          if (typeof tokenAddress !== "string") continue;

          existing.add(tokenAddress.toLowerCase());
        }

        next.uniqueTokenAddresses = Array.from(existing);
      }
    }

    if (event.type === "bridge-complete") {
      next.bridgeCount += 1;
      next.totalBridgeVolumeUsd += Math.max(0, event.volumeUsd);

      const chainIds = new Set(next.bridgeChainIds);

      chainIds.add(event.fromChainId);
      chainIds.add(event.toChainId);

      next.bridgeChainIds = Array.from(chainIds);
    }

    const nextUnlocked = calculateUnlocked(next);

    newlyUnlocked = nextUnlocked.filter(
      (id) => !previousUnlocked.has(id),
    );

    next.unlocked = nextUnlocked;

    return next;
  });

  return {
    state,
    newlyUnlocked,
  };
}

export function getAchievementProgress(
  state: AchievementState,
  achievementId: AchievementId,
) {
  switch (achievementId) {
    case "first-cleanup":
      return { current: state.cleanupCount, target: 1 };

    case "dust-cleaner":
      return { current: state.cleanedTokenCount, target: 10 };

    case "dust-hunter":
      return { current: state.cleanedTokenCount, target: 25 };

    case "bridge-explorer":
      return { current: state.bridgeCount, target: 1 };

    case "bridge-runner":
      return { current: state.bridgeCount, target: 10 };

    case "chain-hopper":
      return { current: state.bridgeChainIds.length, target: 3 };

    case "token-hunter":
      return {
        current: state.uniqueTokenAddresses.length,
        target: 25,
      };

    case "cross-chain":
      return {
        current: Math.min(state.bridgeChainIds.length, 10),
        target: 10,
      };

    case "bridge-master":
      return {
        current: Math.min(state.bridgeCount, 25),
        target: 25,
      };

    case "bridge-legend":
      return {
        current: Math.min(state.totalBridgeVolumeUsd, 1000),
        target: 1000,
      };
  }
}

export function getAchievementDefinition(achievementId: AchievementId) {
  return ACHIEVEMENTS.find(
    (achievement) => achievement.id === achievementId,
  );
}
