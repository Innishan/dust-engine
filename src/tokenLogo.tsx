import { CircleHelp } from "lucide-react";
import { useState } from "react";

export function tokenLogoKey(chainId: number, address: string) {
  return `${chainId}:${address.toLowerCase()}`;
}

export function resolveTokenLogoURI(
  chainId: number,
  address: string,
  embeddedLogoURI: unknown,
  addressLogos?: Record<string, unknown>,
): string | undefined {
  if (usableTokenLogoUrl(embeddedLogoURI)) return embeddedLogoURI.trim();
  if (chainId !== 8453) return undefined;
  const mappedLogoURI = addressLogos?.[address.toLowerCase()];
  return usableTokenLogoUrl(mappedLogoURI) ? mappedLogoURI.trim() : undefined;
}

export function mergeTokenLogoURI(existing: unknown, incoming: unknown): string | undefined {
  if (usableTokenLogoUrl(existing)) return existing.trim();
  return usableTokenLogoUrl(incoming) ? incoming.trim() : undefined;
}

export function tokenLogoMapFromMetadata(
  chainId: number,
  tokens: Array<{ chainId?: unknown; address?: unknown; logoURI?: unknown }>,
): Record<string, string> {
  const logos: Record<string, string> = {};
  for (const token of tokens) {
    if (token.chainId !== chainId || typeof token.address !== "string" || !/^0x[\da-fA-F]{40}$/.test(token.address)) continue;
    if (!usableTokenLogoUrl(token.logoURI)) continue;
    logos[tokenLogoKey(chainId, token.address)] = token.logoURI.trim();
  }
  return logos;
}

export function usableTokenLogoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function TokenLogo({
  chainId,
  address,
  logoURI,
  size = "md",
}: {
  chainId: number;
  address: string;
  logoURI?: string;
  size?: "sm" | "md";
}) {
  const [failedUrl, setFailedUrl] = useState("");
  const url = usableTokenLogoUrl(logoURI) ? logoURI.trim() : "";
  const classes = size === "sm" ? "h-9 w-9" : "h-11 w-11";
  const showImage = Boolean(url && failedUrl !== url);

  return (
    <span
      data-token-logo-key={tokenLogoKey(chainId, address)}
      className={`${classes} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-700/80 bg-zinc-900 text-zinc-500`}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={url}
          alt=""
          onError={() => {
            if (import.meta.env.DEV) console.info("[Token logos] Image request failed", { chainId });
            setFailedUrl(url);
          }}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <CircleHelp size={size === "sm" ? 16 : 20} strokeWidth={1.7} />
      )}
    </span>
  );
}
