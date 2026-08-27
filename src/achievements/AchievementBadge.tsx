import type {
  AchievementDefinition,
  AchievementProgress,
} from "./achievementDefinitions";

type AchievementBadgeProps = {
  achievement: AchievementDefinition;
  progress: AchievementProgress;
  unlocked: boolean;
};

export default function AchievementBadge({
  achievement,
  progress,
  unlocked,
}: AchievementBadgeProps) {
  const percentage = Math.min(
    100,
    Math.round((progress.current / progress.target) * 100),
  );

  return (
    <article
      className={[
        "group relative overflow-hidden rounded-2xl border p-4 transition-all duration-300",
        unlocked
          ? "border-emerald-500/40 bg-zinc-900 shadow-[0_0_30px_rgba(16,185,129,0.08)]"
          : "border-zinc-800 bg-zinc-950/80",
      ].join(" ")}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.04] via-transparent to-transparent pointer-events-none" />

      <div className="relative flex items-start gap-4">
        <div
          className={[
            "relative flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border",
            unlocked
              ? "border-emerald-400/50 bg-zinc-900 shadow-[0_0_25px_rgba(16,185,129,0.18)]"
              : "border-zinc-800 bg-zinc-900",
          ].join(" ")}
        >
          <div
            className={[
              "absolute inset-2 rounded-xl border",
              unlocked
                ? "border-emerald-500/30"
                : "border-zinc-800",
            ].join(" ")}
          />

          <span
            className={[
              "relative text-3xl transition-all",
              unlocked ? "grayscale-0" : "grayscale opacity-50",
            ].join(" ")}
          >
            {achievement.icon}
          </span>

          <span
            className={[
              "absolute -right-2 -top-2 rounded-full border px-2 py-0.5 text-[9px] font-black tracking-wider",
              unlocked
                ? "border-emerald-400/50 bg-emerald-500 text-zinc-950"
                : "border-zinc-700 bg-zinc-900 text-zinc-500",
            ].join(" ")}
          >
            {achievement.number}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3
              className={[
                "truncate text-sm font-black tracking-wide",
                unlocked ? "text-zinc-100" : "text-zinc-500",
              ].join(" ")}
            >
              {achievement.title}
            </h3>

            {unlocked && (
              <span className="shrink-0 text-[9px] font-black uppercase tracking-widest text-emerald-400">
                Unlocked
              </span>
            )}
          </div>

          <p className="min-h-[36px] text-xs leading-5 text-zinc-500">
            {achievement.description}
          </p>

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-[9px] font-mono uppercase tracking-wider">
              <span className="text-zinc-600">
                {achievement.unit}
              </span>

              <span
                className={
                  unlocked
                    ? "text-emerald-400"
                    : "text-zinc-600"
                }
              >
                {progress.current} / {progress.target}
              </span>
            </div>

            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={[
                  "h-full rounded-full transition-all duration-500",
                  unlocked
                    ? "bg-emerald-400"
                    : "bg-zinc-600",
                ].join(" ")}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
