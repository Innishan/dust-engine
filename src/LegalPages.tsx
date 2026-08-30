import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

type LegalPageProps = {
  type: "terms" | "privacy";
};

export default function LegalPages({ type }: LegalPageProps) {
  const isTerms = type === "terms";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800/70 bg-zinc-900/70">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-5">
          <a
            href="/"
            className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-zinc-100 transition-colors hover:text-emerald-400"
          >
            <ArrowLeft size={16} />
            Dust <span className="text-emerald-500">Engine</span>
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
        <p className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-emerald-400">
          Dust Engine
        </p>

        <h1 className="mt-3 text-3xl font-black uppercase tracking-tight text-zinc-100 sm:text-4xl">
          {isTerms ? "Terms of Service" : "Privacy Policy"}
        </h1>

        <p className="mt-2 text-xs text-zinc-500">
          Last updated: August 30, 2026
        </p>

        {isTerms ? <TermsContent /> : <PrivacyContent />}
      </main>
    </div>
  );
}

function TermsContent() {
  return (
    <div className="mt-10 space-y-8 text-sm leading-7 text-zinc-400">
      <Section title="1. About Dust Engine">
        Dust Engine is a decentralized application that helps users discover
        eligible token balances and consolidate supported assets through
        blockchain transactions. Additional products and features may be
        introduced over time.
      </Section>

      <Section title="2. Wallets and Blockchain Transactions">
        Dust Engine does not custody user funds or control user wallets. Users
        remain responsible for reviewing and approving blockchain transactions,
        including token approvals, signatures, swaps, and bridge transactions.
        Blockchain transactions are generally irreversible once confirmed.
      </Section>

      <Section title="3. Ambassador Program — Season 1">
        Dust Engine may operate promotional campaigns such as the Ambassador
        Program — Season 1. Participation may require an approved ambassador
        profile, wallet verification, X account verification, and qualifying
        activity.
      </Section>

      <Section title="4. Points and Leaderboard">
        Ambassador points are calculated from qualifying campaign activity,
        which may include referrals, Clean Dust activity, Bridge activity, and
        eligible social content and engagement metrics. Points are not a
        guaranteed monetary value and do not represent a token, financial
        instrument, or claim on Dust Engine.
      </Section>

      <Section title="5. Prize Pool and Rewards">
        The Ambassador Program may advertise an initial prize pool and
        additional increases based on qualifying campaign volume. The final
        prize pool and distribution are determined after the campaign ends and
        qualifying activity has been reviewed. Only the final verified
        leaderboard determines the eligible top participants.
      </Section>

      <Section title="6. Fair Participation">
        Attempts to manipulate referrals, activity, impressions, leaderboard
        data, or campaign systems may result in disqualification. Dust Engine
        may review, reject, or remove activity that it reasonably determines
        to be invalid, fraudulent, automated, duplicated, or otherwise
        inconsistent with campaign rules.
      </Section>

      <Section title="7. Third-Party Services">
        Dust Engine may integrate third-party services including blockchain
        networks, wallets, decentralized exchanges, bridge providers, data
        providers, and social platforms. Those services operate under their
        own terms and policies.
      </Section>

      <Section title="8. No Guarantee">
        Dust Engine is provided on an as-is basis. We do not guarantee that
        every token can be swapped, bridged, valued, or consolidated, or that
        any particular transaction, route, reward, or campaign outcome will be
        available.
      </Section>

      <Section title="9. Changes">
        Dust Engine may update these terms, campaign rules, features, or
        eligibility requirements when reasonably necessary. The applicable
        version published on this page will govern use of the service.
      </Section>

      <Section title="10. Contact">
        For questions regarding Dust Engine or the Ambassador Program, use the
        official Dust Engine communication channels.
      </Section>
    </div>
  );
}

function PrivacyContent() {
  return (
    <div className="mt-10 space-y-8 text-sm leading-7 text-zinc-400">
      <Section title="1. Information We Collect">
        Dust Engine may process information needed to operate the service,
        including connected wallet addresses, blockchain activity, ambassador
        profile information, referral information, and information associated
        with authenticated social accounts.
      </Section>

      <Section title="2. X Account Information">
        If you connect an X account through OAuth, Dust Engine may receive basic
        account information such as your X user ID, username, and display name.
        If required for an eligible campaign, Dust Engine may also process
        information about qualifying public X content and available engagement
        metrics for campaign verification and scoring.
      </Section>

      <Section title="3. Wallet Information">
        Dust Engine may associate a wallet address with an ambassador profile
        after the user proves control of that wallet through a cryptographic
        signature. A signature used for authentication does not itself send a
        blockchain transaction.
      </Section>

      <Section title="4. How We Use Information">
        Information may be used to provide Dust Engine features, authenticate
        users, maintain ambassador profiles, attribute referrals, verify
        qualifying campaign activity, calculate leaderboard scores, prevent
        abuse, and administer campaign rewards.
      </Section>

      <Section title="5. X API Data">
        X API data is used only for the purposes described in this policy and
        the applicable Dust Engine campaign. Dust Engine does not sell or
        resell X API data.
      </Section>

      <Section title="6. Blockchain Data">
        Blockchain networks are public by design. Wallet addresses,
        transactions, token balances, and other on-chain activity may be
        publicly visible independently of Dust Engine.
      </Section>

      <Section title="7. Third-Party Services">
        Dust Engine may rely on third-party providers for wallet connections,
        blockchain infrastructure, token pricing, swaps, bridges, analytics,
        and social authentication. Their handling of information is governed
        by their respective policies and terms.
      </Section>

      <Section title="8. Data Retention">
        We retain information for as long as reasonably necessary to operate
        Dust Engine, administer campaigns, maintain security, resolve
        disputes, and meet applicable obligations.
      </Section>

      <Section title="9. Security">
        We take reasonable measures to protect information handled by Dust
        Engine. However, no internet service or blockchain system can be
        guaranteed completely secure.
      </Section>

      <Section title="10. Changes to This Policy">
        This Privacy Policy may be updated as Dust Engine's features,
        integrations, or legal requirements change. The latest version will be
        published on this page.
      </Section>

      <Section title="11. Contact">
        For privacy questions regarding Dust Engine, use the official Dust
        Engine communication channels.
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-black uppercase tracking-wide text-zinc-200">
        {title}
      </h2>
      <p className="mt-2">{children}</p>
    </section>
  );
}
