#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f .env.dust-genesis ]]; then
  echo "Missing .env.dust-genesis. The repository setup file should already be present." >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/tsx ]]; then
  echo "Project dependencies are unavailable; this helper will not install anything." >&2
  exit 1
fi
if [[ ! -t 0 ]]; then
  echo "Run this command in a terminal so the private key can be entered without echo." >&2
  exit 1
fi

cleanup() {
  unset DUST_GENESIS_DEPLOYER_PRIVATE_KEY
}
trap cleanup EXIT HUP INT TERM

read -r -s -p "Enter the account's exported private key (0x + exactly 64 hex characters; never a seed phrase; input hidden): " DUST_GENESIS_DEPLOYER_PRIVATE_KEY
printf '\n'
if [[ -z "$DUST_GENESIS_DEPLOYER_PRIVATE_KEY" ]]; then
  echo "No deployer key entered." >&2
  exit 1
fi
export DUST_GENESIS_DEPLOYER_PRIVATE_KEY

node_modules/.bin/tsx scripts/dust-genesis-preflight.ts
