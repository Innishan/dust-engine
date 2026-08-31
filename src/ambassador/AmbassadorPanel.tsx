import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import axios from "axios";
import { CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, Trophy } from "lucide-react";

interface LeaderboardEntry {
  rank: number;
  creator: string;
  xHandle?: string;
  points: number;
  referrals: number;
  coinsSwept: number;
  bridgeVolumeUsd: number;
  volumeUsd: number;
  isTop50: boolean;
}

interface AmbassadorProfile extends Omit<LeaderboardEntry, "creator" | "isTop50"> {
  displayName: string;
  referralCode: string;
  xUsername?: string;
  xVerified: boolean;
  xContentPosts: number;
}

const formatNumber = (value: number) => new Intl.NumberFormat("en-US").format(value);
const formatUsd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);

export default function AmbassadorPanel() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [profile, setProfile] = useState<AmbassadorProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const loadLeaderboard = useCallback(async (refresh = false) => {
    refresh ? setIsRefreshing(true) : setIsLoading(true);
    try {
      const response = await axios.get("/api/ambassadors/leaderboard");
      setEntries(response.data.entries ?? []);
      setUpdatedAt(response.data.updatedAt ?? null);
    } catch {
      setMessage("Leaderboard data is temporarily unavailable.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const loadProfile = useCallback(async () => {
    try {
      const response = await axios.get("/api/ambassadors/profile");
      setProfile(response.data.profile);
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    void loadLeaderboard();
    void loadProfile();
    const status = new URLSearchParams(window.location.search).get("x");
    if (status) {
      const messages: Record<string, string> = {
        linked: "X account verified and linked to your ambassador profile.",
        cancelled: "X connection was cancelled. You can try again whenever you are ready.",
        "already-linked": "This X account is already linked to another ambassador.",
        "invalid-state": "That X connection request expired or was already used. Please try again.",
        "wallet-required": "Verify your approved wallet before connecting X.",
        unavailable: "X connection is not configured right now. Please try again later.",
        failed: "X verification could not be completed. Please try again.",
      };
      setMessage(messages[status] || "X verification could not be completed.");
      window.history.replaceState({}, "", "/?section=ambassador");
      void loadProfile();
    }
    const timer = window.setInterval(() => void loadLeaderboard(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadLeaderboard, loadProfile]);

  const activateWallet = async () => {
    if (!address) return;
    setMessage(null);
    setIsActivating(true);
    try {
      const nonceResponse = await axios.post("/api/ambassadors/auth/nonce", { walletAddress: address });
      const signature = await signMessageAsync({ account: address, message: nonceResponse.data.message });
      await axios.post("/api/ambassadors/auth/activate", { walletAddress: address, nonce: nonceResponse.data.nonce, signature });
      await loadProfile();
      setMessage("Wallet ownership confirmed. No blockchain transaction was sent.");
    } catch (error) {
      if ((error as Error).message?.toLowerCase().includes("rejected")) setMessage("Signature request was cancelled. No transaction was sent.");
      else setMessage("Unable to verify this wallet. Please try again.");
    } finally {
      setIsActivating(false);
    }
  };

  return <section className="space-y-6">
    <div className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl sm:p-8">
      <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="relative max-w-2xl"><p className="text-[11px] font-mono font-bold uppercase tracking-[0.2em] text-emerald-400">Ambassador Program · Season 1</p><h2 className="mt-3 text-3xl font-black uppercase italic tracking-tight text-zinc-100 sm:text-4xl">$20,000 <span className="text-emerald-400">USDC</span> Prize Pool</h2><p className="mt-4 max-w-xl text-sm leading-6 text-zinc-400 sm:text-base">Every $1M in qualifying Bridge + Clean Dust volume adds another $5,000 USDC to the prize pool.</p><p className="mt-5 text-xs font-black uppercase tracking-[0.16em] text-zinc-200">Top 50 will share the final prize pool</p></div>
    </div>

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Leaderboard entries={entries} isLoading={isLoading} isRefreshing={isRefreshing} updatedAt={updatedAt} onRefresh={() => void loadLeaderboard(true)} />
      <ProfileCard connected={isConnected} profile={profile} isActivating={isActivating} onActivate={() => void activateWallet()} onConnectX={() => { window.location.assign("/api/auth/x/start"); }} message={message} />
    </div>
  </section>;
}

function Leaderboard({ entries, isLoading, isRefreshing, updatedAt, onRefresh }: { entries: LeaderboardEntry[]; isLoading: boolean; isRefreshing: boolean; updatedAt: string | null; onRefresh: () => void }) {
  return <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-xl"><div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4 sm:px-6"><div><h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-zinc-100"><Trophy size={17} className="text-emerald-400" /> Season 1 Leaderboard</h3><p className="mt-1 text-xs text-zinc-500">{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : "Updated —"}</p></div><button type="button" onClick={onRefresh} disabled={isRefreshing} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-700 text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-50" aria-label="Refresh leaderboard"><RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} /></button></div><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[560px] text-left text-sm"><thead className="bg-zinc-950/50 text-[10px] font-mono uppercase tracking-wider text-zinc-500"><tr><th className="px-6 py-3 font-medium">Rank</th><th className="px-3 py-3 font-medium">Creator</th><th className="px-3 py-3 text-right font-medium">Points</th><th className="px-3 py-3 text-right font-medium">Referrals</th><th className="px-6 py-3 text-right font-medium">Volume</th></tr></thead><tbody className="divide-y divide-zinc-800/80">{entries.map((entry) => <tr key={entry.rank} className="text-zinc-300"><td className="px-6 py-4 font-mono text-zinc-500">#{entry.rank} {entry.isTop50 && <Trophy className="ml-1 inline text-emerald-400" size={14} aria-label="Top 50" />}</td><td className="px-3 py-4"><p className="font-bold text-zinc-100">{entry.creator}</p>{entry.xHandle && <p className="mt-0.5 text-xs text-zinc-500">@{entry.xHandle}</p>}</td><td className="px-3 py-4 text-right font-mono font-bold text-emerald-400">{formatNumber(entry.points)}</td><td className="px-3 py-4 text-right font-mono">{formatNumber(entry.referrals)}</td><td className="px-6 py-4 text-right font-mono">{formatUsd(entry.volumeUsd)}</td></tr>)}</tbody></table></div><div className="divide-y divide-zinc-800 md:hidden">{entries.map((entry) => <article key={entry.rank} className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs text-zinc-500">#{entry.rank} {entry.isTop50 && <span className="text-emerald-400">· Top 50</span>}</p><p className="mt-1 font-bold text-zinc-100">{entry.creator}</p>{entry.xHandle && <p className="text-xs text-zinc-500">@{entry.xHandle}</p>}</div><p className="font-mono font-bold text-emerald-400">{formatNumber(entry.points)} pts</p></div><dl className="mt-4 grid grid-cols-2 gap-2 text-center text-xs"><Metric label="Refs" value={formatNumber(entry.referrals)} /><Metric label="Volume" value={formatUsd(entry.volumeUsd)} /></dl></article>)}</div><p className="px-6 py-3 text-xs text-zinc-500">Volume includes verified Bridge USD volume. Verified Clean Dust USD volume will be included when an authoritative server-side valuation source is available.</p>{isLoading && <p className="px-6 py-10 text-center text-sm text-zinc-500">Loading verified leaderboard…</p>}</div>;
}

function ProfileCard({ connected, profile, isActivating, onActivate, onConnectX, message }: { connected: boolean; profile: AmbassadorProfile | null; isActivating: boolean; onActivate: () => void; onConnectX: () => void; message: string | null }) {
  const walletVerified = Boolean(profile);
  return <aside className="h-fit rounded-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-xl"><div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"><ShieldCheck size={20} /></div><h3 className="mt-4 text-sm font-black uppercase tracking-wide text-zinc-100">{profile ? "Ambassador Profile" : "Ambassador Activation"}</h3><ol className="mt-4 space-y-2 text-xs text-zinc-500"><Step complete={connected} label="Connect wallet" /><Step complete={walletVerified} label="Verify wallet ownership" /><Step complete={Boolean(profile?.xVerified)} label="Connect X" /><Step complete={Boolean(profile?.xVerified)} label="X account verified" /></ol>{profile ? <><div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-200"><p className="font-bold">{profile.xUsername ? `@${profile.xUsername}` : profile.displayName}</p><p className="mt-1 font-mono text-[10px] uppercase">Referral code: {profile.referralCode}</p></div>{profile.xVerified ? <p className="mt-4 flex items-center gap-2 text-xs text-emerald-400"><CheckCircle2 size={15} /> X verified</p> : <button type="button" onClick={onConnectX} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-4 py-3 text-xs font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-white">Connect X <ExternalLink size={14} /></button>}<dl className="mt-4 grid grid-cols-2 gap-2 text-center text-xs"><Metric label="Points" value={formatNumber(profile.points)} /><Metric label="Referrals" value={formatNumber(profile.referrals)} /><Metric label="Clean Dust" value={`${formatNumber(profile.coinsSwept)} coins`} /><Metric label="Bridge" value={formatUsd(profile.bridgeVolumeUsd)} /><Metric label="X Content" value={`${formatNumber(profile.xContentPosts)} approved`} /></dl></> : <button type="button" onClick={onActivate} disabled={!connected || isActivating} className="mt-4 w-full rounded-xl bg-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">{isActivating ? "Confirming…" : connected ? "Verify Wallet" : "Connect Wallet to Activate"}</button>}{message && <p className="mt-3 flex gap-2 text-xs leading-5 text-zinc-400"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />{message}</p>}</aside>;
}

function Step({ complete, label }: { complete: boolean; label: string }) { return <li className={complete ? "flex items-center gap-2 text-emerald-400" : "flex items-center gap-2"}><span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px]">{complete ? "✓" : ""}</span>{label}</li>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-zinc-950/60 p-2"><dt className="text-[9px] uppercase text-zinc-500">{label}</dt><dd className="mt-1 font-mono text-zinc-200">{value}</dd></div>; }
