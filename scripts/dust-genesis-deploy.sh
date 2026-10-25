#!/usr/bin/env bash
set -euo pipefail

# Prevent an inherited xtrace option from echoing secret-bearing expansions.
case $- in
  *x*) set +x ;;
esac

# A caller's exported value must never substitute for the hidden prompts.
unset DUST_GENESIS_DEPLOYER_PRIVATE_KEY
DEPLOYER_KEY=""
FORGE_PID=""

terminate_forge_child() {
  if [[ -n "${FORGE_PID:-}" ]] && kill -0 "$FORGE_PID" 2>/dev/null; then
    kill -TERM "$FORGE_PID" 2>/dev/null || true
    wait "$FORGE_PID" 2>/dev/null || true
  fi
  FORGE_PID=""
}

cleanup() {
  terminate_forge_child
  unset DEPLOYER_KEY DUST_GENESIS_DEPLOYER_PRIVATE_KEY
}

handle_signal() {
  local status="$1"
  trap - INT HUP TERM
  if [[ -n "${FORGE_PID:-}" ]]; then
    echo "Cancellation requested; stopping the local Foundry process. A transaction already broadcast cannot be reversed." >&2
    terminate_forge_child
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 129' HUP
trap 'handle_signal 143' TERM

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VALIDATE_ONLY=false
if [[ $# -gt 1 ]]; then
  echo "Usage: npm run dust-genesis:deploy [-- --validate-only]" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  if [[ "$1" != "--validate-only" ]]; then
    echo "Usage: npm run dust-genesis:deploy [-- --validate-only]" >&2
    exit 2
  fi
  VALIDATE_ONLY=true
fi

if [[ ! -t 0 ]]; then
  echo "Run this command in a terminal; the deployer key is entered with input hidden." >&2
  exit 1
fi

# The existing preflight performs its own hidden prompt and clears its key on exit.
npm run dust-genesis:preflight

if [[ ! -f .env.dust-genesis ]]; then
  echo "Missing public Dust Genesis configuration file." >&2
  exit 1
fi
if ! public_config="$(python3 scripts/dust_genesis_deploy_config.py .env.dust-genesis)"; then
  echo "Public Dust Genesis configuration failed strict validation; Foundry was not invoked." >&2
  exit 1
fi

# The parser emits only six canonical values in fixed order. Read them as data;
# never eval or source the configuration file.
exec 3<<< "$public_config"
IFS= read -r DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS <&3
IFS= read -r DUST_GENESIS_OWNER_ADDRESS <&3
IFS= read -r DUST_GENESIS_EXPECTED_OWNER_ADDRESS <&3
IFS= read -r DUST_GENESIS_SIGNER_ADDRESS <&3
IFS= read -r DUST_GENESIS_EXPECTED_SIGNER_ADDRESS <&3
IFS= read -r DUST_GENESIS_METADATA_URI <&3
exec 3<&-
unset public_config
export DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS DUST_GENESIS_OWNER_ADDRESS
export DUST_GENESIS_EXPECTED_OWNER_ADDRESS DUST_GENESIS_SIGNER_ADDRESS
export DUST_GENESIS_EXPECTED_SIGNER_ADDRESS DUST_GENESIS_METADATA_URI

if [[ "$VALIDATE_ONLY" == true ]]; then
  echo "Preflight and public configuration checks passed; validation-only mode stopped before confirmation and Foundry."
  exit 0
fi

echo "Preflight and public configuration checks passed. No deployment has occurred."
read -r -p 'To continue to the Base Mainnet broadcast step, type BROADCAST BASE MAINNET: ' confirmation
if [[ "$confirmation" != "BROADCAST BASE MAINNET" ]]; then
  echo "Deployment cancelled; no transaction was submitted."
  exit 1
fi
unset confirmation

read -r -s -p "Re-enter the deployer account's exported private key (0x + 64 hex characters; never a seed phrase; input hidden): " DEPLOYER_KEY
printf '\n'
if [[ -z "$DEPLOYER_KEY" ]]; then
  echo "No deployer key entered; no deployment was attempted." >&2
  exit 1
fi

cd contracts/dust-genesis
rpc_url="${BASE_RPC_URL:-https://mainnet.base.org}"
DUST_GENESIS_DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" forge script \
  script/Deploy.s.sol:DeployDustGenesis \
  --rpc-url "$rpc_url" \
  --broadcast &
FORGE_PID=$!
if wait "$FORGE_PID"; then
  forge_status=0
else
  forge_status=$?
fi
FORGE_PID=""

# Remove the shell copy immediately after the Foundry child exits.
unset DEPLOYER_KEY
exit "$forge_status"
