import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import axios from "axios";
import { BookOpen, Check, CheckCircle2, Copy, ExternalLink, RefreshCw, ShieldCheck, Trophy, X } from "lucide-react";

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
  const [rulesOpen, setRulesOpen] = useState(false);

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

  return <section className="min-w-0 space-y-6">
    <div className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl sm:p-8">
      <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8"><div className="max-w-2xl"><p className="text-[11px] font-mono font-bold uppercase tracking-[0.2em] text-emerald-400">Ambassador Program · Season 1</p><h2 className="mt-3 text-3xl font-black uppercase italic tracking-tight text-zinc-100 sm:text-4xl">$20,000 <span className="text-emerald-400">USDC</span> Prize Pool</h2><p className="mt-4 max-w-xl text-sm leading-6 text-zinc-400 sm:text-base">Every $1M in qualifying Bridge + Clean Dust volume adds another $5,000 USDC to the prize pool.</p><p className="mt-5 text-xs font-black uppercase tracking-[0.16em] text-zinc-200">Top 50 will share the final prize pool</p></div><button type="button" onClick={() => setRulesOpen(true)} className="inline-flex w-fit shrink-0 items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[11px] font-black uppercase tracking-widest text-emerald-300 transition-colors hover:border-emerald-400/60 hover:bg-emerald-500/20 hover:text-emerald-200"><BookOpen size={15} /> Rules</button></div>
    </div>

    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Leaderboard entries={entries} isLoading={isLoading} isRefreshing={isRefreshing} updatedAt={updatedAt} onRefresh={() => void loadLeaderboard(true)} />
      <ProfileCard connected={isConnected} profile={profile} isActivating={isActivating} onActivate={() => void activateWallet()} onConnectX={() => { window.location.assign("/api/auth/x/start"); }} message={message} />
    </div>
    {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}
  </section>;
}

function RulesModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/75 p-3 backdrop-blur-sm sm:items-center sm:p-6" role="presentation" onMouseDown={onClose}><section role="dialog" aria-modal="true" aria-labelledby="ambassador-x-rules" className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-3xl border border-emerald-500/25 bg-zinc-900 p-5 shadow-2xl shadow-black/60 sm:max-h-[calc(100dvh-3rem)] sm:p-7" onMouseDown={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-emerald-400">Ambassador Program</p><h3 id="ambassador-x-rules" className="mt-2 text-xl font-black uppercase italic tracking-tight text-zinc-100">How to earn X points</h3></div><button type="button" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-700 text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-300" aria-label="Close rules"><X size={17} /></button></div><ul className="mt-6 space-y-3 text-sm leading-6 text-zinc-300"><li>• Connect your verified X account.</li><li>• Post naturally about Dust Engine.</li><li>• Useful, original, genuine content earns more.</li><li>• Avoid spam, copied posts, and empty mentions.</li><li>• One post can earn once.</li><li>• Quality is automatically evaluated.</li><li>• Points are calculated automatically.</li><li>• No manual submission is required.</li></ul><div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-100">Qualifying posts are detected automatically after your X account is verified.</div><button type="button" onClick={onClose} className="mt-6 w-full rounded-xl bg-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-emerald-400">Got it</button></section></div>;
}

function Leaderboard({ entries, isLoading, isRefreshing, updatedAt, onRefresh }: { entries: LeaderboardEntry[]; isLoading: boolean; isRefreshing: boolean; updatedAt: string | null; onRefresh: () => void }) {
  return <div className="min-w-0 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-xl"><div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4 sm:px-6"><div className="min-w-0"><h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-zinc-100"><Trophy size={17} className="shrink-0 text-emerald-400" /> Season 1 Leaderboard</h3><p className="mt-1 text-xs text-zinc-500">{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : "Updated —"}</p></div><button type="button" onClick={onRefresh} disabled={isRefreshing} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-700 text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-50" aria-label="Refresh leaderboard"><RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} /></button></div><div className="hidden min-w-0 md:block"><table className="w-full table-fixed text-left text-xs sm:text-sm"><colgroup><col className="w-12 sm:w-16" /><col /><col className="w-16 sm:w-20" /><col className="w-16 sm:w-20" /><col className="w-16 sm:w-20" /></colgroup><thead className="bg-zinc-950/50 text-[9px] font-mono uppercase tracking-wide text-zinc-500 sm:text-[10px] sm:tracking-wider"><tr><th className="px-2 py-3 font-medium sm:px-4">Rank</th><th className="px-2 py-3 font-medium">Creator</th><th className="whitespace-nowrap px-2 py-3 text-right font-medium">Points</th><th className="whitespace-nowrap px-2 py-3 text-right font-medium">Referrals</th><th className="whitespace-nowrap px-2 py-3 text-right font-medium sm:px-4">Volume</th></tr></thead><tbody className="divide-y divide-zinc-800/80">{entries.map((entry) => <tr key={entry.rank} className="text-zinc-300"><td className="whitespace-nowrap px-2 py-4 font-mono text-zinc-500 sm:px-4">#{entry.rank} {entry.isTop50 && <Trophy className="ml-0.5 inline text-emerald-400" size={13} aria-label="Top 50" />}</td><td className="min-w-0 px-2 py-4"><p className="truncate font-bold text-zinc-100" title={entry.creator}>{entry.creator}</p>{entry.xHandle && <p className="mt-0.5 truncate text-xs text-zinc-500" title={`@${entry.xHandle}`}>@{entry.xHandle}</p>}</td><td className="whitespace-nowrap px-2 py-4 text-right font-mono font-bold text-emerald-400">{formatNumber(entry.points)}</td><td className="whitespace-nowrap px-2 py-4 text-right font-mono">{formatNumber(entry.referrals)}</td><td className="whitespace-nowrap px-2 py-4 text-right font-mono sm:px-4">{formatUsd(entry.volumeUsd)}</td></tr>)}</tbody></table></div><div className="divide-y divide-zinc-800 md:hidden">{entries.map((entry) => <article key={entry.rank} className="min-w-0 p-4"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="font-mono text-xs text-zinc-500">#{entry.rank} {entry.isTop50 && <span className="text-emerald-400">· Top 50</span>}</p><p className="mt-1 truncate font-bold text-zinc-100" title={entry.creator}>{entry.creator}</p>{entry.xHandle && <p className="truncate text-xs text-zinc-500" title={`@${entry.xHandle}`}>@{entry.xHandle}</p>}</div><p className="shrink-0 whitespace-nowrap font-mono font-bold text-emerald-400">{formatNumber(entry.points)} pts</p></div><dl className="mt-4 grid grid-cols-2 gap-2 text-center text-xs"><Metric label="Refs" value={formatNumber(entry.referrals)} /><Metric label="Volume" value={formatUsd(entry.volumeUsd)} /></dl></article>)}</div><p className="px-6 py-3 text-xs text-zinc-500">Volume includes verified Bridge USD volume. Verified Clean Dust USD volume will be included when an authoritative server-side valuation source is available.</p>{isLoading && <p className="px-6 py-10 text-center text-sm text-zinc-500">Loading verified leaderboard…</p>}</div>;
}

function ProfileCard({ connected, profile, isActivating, onActivate, onConnectX, message }: { connected: boolean; profile: AmbassadorProfile | null; isActivating: boolean; onActivate: () => void; onConnectX: () => void; message: string | null }) {
  const walletVerified = Boolean(profile);
  const [copiedValue, setCopiedValue] = useState<"id" | "link" | null>(null);
  const referralId = profile?.xUsername ? `@${profile.xUsername}` : profile?.displayName;
  const referralLink = profile ? `${window.location.origin}/?ref=${encodeURIComponent(profile.referralCode)}` : "";
  const copyReferralValue = async (value: string, label: "id" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(label);
      window.setTimeout(() => setCopiedValue((current) => current === label ? null : current), 1_500);
    } catch {
      // Copy support is optional and must not affect referral attribution.
    }
  };
  return <aside className="h-fit min-w-0 rounded-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-xl"><div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400"><ShieldCheck size={20} /></div><h3 className="mt-4 text-sm font-black uppercase tracking-wide text-zinc-100">{profile ? "Ambassador Profile" : "Ambassador Activation"}</h3><ol className="mt-4 space-y-2 text-xs text-zinc-500"><Step complete={connected} label="Connect wallet" /><Step complete={walletVerified} label="Verify wallet ownership" /><Step complete={Boolean(profile?.xVerified)} label="Connect X" /><Step complete={Boolean(profile?.xVerified)} label="X account verified" /></ol>{profile ? <><div className="mt-4 min-w-0 space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100"><ReferralValue label="Your Referral ID" value={referralId || profile.referralCode} copied={copiedValue === "id"} onCopy={() => void copyReferralValue(referralId || profile.referralCode, "id")} /><div className="border-t border-emerald-500/15 pt-3"><div className="flex items-center justify-between gap-2"><p className="font-mono text-[10px] uppercase tracking-wide text-emerald-300/80">Your Referral Link</p><span className="shrink-0 font-mono text-[10px] text-emerald-300/80">{profile.referralCode}</span></div><div className="mt-1 flex min-w-0 items-center gap-1"><a href={referralLink} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-100 underline decoration-emerald-400/40 underline-offset-4 transition-colors hover:text-emerald-300" title={referralLink}>{referralLink.replace(/^https?:\/\//, "")}</a><CopyButton copied={copiedValue === "link"} onClick={() => void copyReferralValue(referralLink, "link")} label="Copy referral link" /></div></div></div>{profile.xVerified ? <p className="mt-4 flex items-center gap-2 text-xs text-emerald-400"><CheckCircle2 size={15} /> X verified</p> : <button type="button" onClick={onConnectX} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-4 py-3 text-xs font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-white">Connect X <ExternalLink size={14} /></button>}<dl className="mt-4 grid grid-cols-2 gap-2 text-center text-xs"><Metric label="Points" value={formatNumber(profile.points)} /><Metric label="Referrals" value={formatNumber(profile.referrals)} /><Metric label="Clean Dust" value={`${formatNumber(profile.coinsSwept)} coins`} /><Metric label="Bridge" value={formatUsd(profile.bridgeVolumeUsd)} /><Metric label="X Content" value={`${formatNumber(profile.xContentPosts)} approved`} /></dl></> : <button type="button" onClick={onActivate} disabled={!connected || isActivating} className="mt-4 w-full rounded-xl bg-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">{isActivating ? "Confirming…" : connected ? "Verify Wallet" : "Connect Wallet to Activate"}</button>}{message && <p className="mt-3 flex gap-2 text-xs leading-5 text-zinc-400"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />{message}</p>}</aside>;
}

function Step({ complete, label }: { complete: boolean; label: string }) { return <li className={complete ? "flex items-center gap-2 text-emerald-400" : "flex items-center gap-2"}><span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px]">{complete ? "✓" : ""}</span>{label}</li>; }
function CopyButton({ copied, label, onClick }: { copied: boolean; label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 text-emerald-200 transition-colors hover:border-emerald-400/50 hover:bg-emerald-400/10" aria-label={label} title={copied ? "Copied" : label}>{copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}</button>; }
function ReferralValue({ copied, label, onCopy, value }: { copied: boolean; label: string; onCopy: () => void; value: string }) { return <div className="min-w-0"><p className="font-mono text-[10px] uppercase tracking-wide text-emerald-300/80">{label}</p><div className="mt-1 flex min-w-0 items-center gap-1"><p className="min-w-0 flex-1 truncate font-bold text-emerald-100" title={value}>{value}</p><CopyButton copied={copied} label={`Copy ${label.toLowerCase()}`} onClick={onCopy} /></div></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-lg bg-zinc-950/60 p-2"><dt className="text-[9px] uppercase text-zinc-500">{label}</dt><dd className="mt-1 truncate font-mono text-zinc-200" title={value}>{value}</dd></div>; }
