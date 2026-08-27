export type AchievementId =
  | "first-cleanup"
  | "dust-cleaner"
  | "dust-hunter"
  | "bridge-explorer"
  | "bridge-runner"
  | "chain-hopper"
  | "token-hunter"
  | "cross-chain"
  | "bridge-master"
  | "bridge-legend";

export type AchievementProgress = {
  current: number;
  target: number;
};

export type AchievementDefinition = {
  id: AchievementId;
  number: string;
  title: string;
  description: string;
  target: number;
  unit: string;
  icon: string;
};

export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    id: "first-cleanup",
    number: "01",
    title: "FIRST CLEANUP",
    description: "Complete your first dust cleanup.",
    target: 1,
    unit: "cleanup",
    icon: "🧹",
  },
  {
    id: "dust-cleaner",
    number: "02",
    title: "DUST CLEANER",
    description: "Clean 10 tokens.",
    target: 10,
    unit: "tokens",
    icon: "✨",
  },
  {
    id: "dust-hunter",
    number: "03",
    title: "DUST HUNTER",
    description: "Clean 25 tokens.",
    target: 25,
    unit: "tokens",
    icon: "🏆",
  },
  {
    id: "bridge-explorer",
    number: "04",
    title: "BRIDGE EXPLORER",
    description: "Complete your first cross-chain bridge.",
    target: 1,
    unit: "bridge",
    icon: "🌉",
  },
  {
    id: "bridge-runner",
    number: "05",
    title: "BRIDGE RUNNER",
    description: "Complete 10 cross-chain bridges.",
    target: 10,
    unit: "bridges",
    icon: "🚀",
  },
  {
    id: "chain-hopper",
    number: "06",
    title: "CHAIN HOPPER",
    description: "Use the bridge across 3 different chains.",
    target: 3,
    unit: "chains",
    icon: "🌐",
  },
  {
    id: "token-hunter",
    number: "07",
    title: "TOKEN HUNTER",
    description: "Clean 25 different tokens.",
    target: 25,
    unit: "unique tokens",
    icon: "🔎",
  },
  {
    id: "cross-chain",
    number: "08",
    title: "CROSS-CHAIN",
    description: "Complete bridges involving 10 different chains.",
    target: 10,
    unit: "chains",
    icon: "🔗",
  },
  {
    id: "bridge-master",
    number: "09",
    title: "BRIDGE MASTER",
    description: "Complete 25 bridges.",
    target: 25,
    unit: "bridges",
    icon: "⚡",
  },
  {
    id: "bridge-legend",
    number: "10",
    title: "BRIDGE LEGEND",
    description: "Reach $1,000 in total bridge volume.",
    target: 1000,
    unit: "USD",
    icon: "💎",
  },
];
