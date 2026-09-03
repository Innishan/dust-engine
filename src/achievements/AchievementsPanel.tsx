import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { Trophy, Lock, Sparkles } from "lucide-react";
import {
  ACHIEVEMENTS,
  type AchievementId,
} from "./achievementDefinitions";
import { emptyAchievementState, type AchievementState } from "./achievementState";
import {
  getAchievementProgress,
} from "./achievementEngine";
import AchievementBadge from "./AchievementBadge";

export default function AchievementsPanel() {
  const { address } = useAccount();

  const [showUnlockedOnly, setShowUnlockedOnly] = useState(false);

  const [state, setState] = useState<AchievementState | null>(null);

  useEffect(() => {
    if (!address) {
      setState(null);
      return;
    }
    let active = true;
    void fetch(`/api/achievements/${address}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Unable to load achievements")))
      .then((next: AchievementState) => { if (active) setState(next); })
      .catch(() => { if (active) setState(emptyAchievementState()); });
    return () => { active = false; };
  }, [address]);

  const unlocked = new Set<AchievementId>(
    state?.unlocked ?? [],
  );

  const visibleAchievements = ACHIEVEMENTS.filter(
    (achievement) =>
      !showUnlockedOnly || unlocked.has(achievement.id),
  );

  const unlockedCount = unlocked.size;

  return (
    <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl sm:p-7">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/[0.04] via-transparent to-purple-500/[0.04]" />

      <div className="relative">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
              <Trophy
                size={21}
                className="text-emerald-400"
              />
            </div>

            <div>
              <h2 className="text-lg font-black tracking-tight text-zinc-100">
                ACHIEVEMENTS
              </h2>

              <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600">
                Dust Engine progression
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-right">
              <div className="text-lg font-black text-emerald-400">
                {unlockedCount}
                <span className="text-zinc-700">
                  /{ACHIEVEMENTS.length}
                </span>
              </div>

              <div className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                unlocked
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                setShowUnlockedOnly((value) => !value)
              }
              className={[
                "rounded-xl border px-3 py-2 text-[9px] font-black uppercase tracking-wider transition-colors",
                showUnlockedOnly
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300",
              ].join(" ")}
            >
              {showUnlockedOnly ? "All Badges" : "Unlocked"}
            </button>
          </div>
        </div>

        {!address && (
          <div className="mb-5 flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <Lock
              size={17}
              className="shrink-0 text-zinc-600"
            />

            <div>
              <p className="text-sm font-bold text-zinc-400">
                Connect your wallet
              </p>

              <p className="text-xs text-zinc-600">
                Your achievements are tracked separately for each wallet.
              </p>
            </div>
          </div>
        )}

        {address && visibleAchievements.length === 0 && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
            <Sparkles
              size={22}
              className="mx-auto mb-3 text-emerald-400"
            />

            <p className="text-sm font-bold text-zinc-300">
              No achievements unlocked yet.
            </p>

            <p className="mt-1 text-xs text-zinc-600">
              Start cleaning dust to begin your progression.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {visibleAchievements.map((achievement) => {
            const progress = getAchievementProgress(
              state ?? emptyAchievementState(),
              achievement.id,
            );

            return (
              <AchievementBadge
                key={achievement.id}
                achievement={achievement}
                progress={progress}
                unlocked={unlocked.has(achievement.id)}
              />
            );
          })}
        </div>

        <div className="mt-6 border-t border-zinc-900 pt-4 text-center">
          <p className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-700">
            More achievements coming soon
          </p>
        </div>
      </div>
    </section>
  );
}
