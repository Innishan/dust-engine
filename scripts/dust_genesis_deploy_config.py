#!/usr/bin/env python3
"""Strict, non-evaluating parser for public Dust Genesis deployment settings."""

from __future__ import annotations

import sys
from pathlib import Path


EXPECTED_PUBLIC_VALUES = {
    "DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS": "0xEe36C3c644240302eB8121F66D4e23C068512a40",
    "DUST_GENESIS_OWNER_ADDRESS": "0xEe36C3c644240302eB8121F66D4e23C068512a40",
    "DUST_GENESIS_EXPECTED_OWNER_ADDRESS": "0xEe36C3c644240302eB8121F66D4e23C068512a40",
    "DUST_GENESIS_SIGNER_ADDRESS": "0x699C2b62196667D5D9D550C405780d3C91C84057",
    "DUST_GENESIS_EXPECTED_SIGNER_ADDRESS": "0x699C2b62196667D5D9D550C405780d3C91C84057",
    "DUST_GENESIS_METADATA_URI": "ipfs://bafkreidir2sulyf2m67bvxltfhexguovjxzfdwqrggcdtehii3e5yh4wky",
}


class PublicConfigError(ValueError):
    """Raised when the local public deployment config is not canonical."""


def parse_public_config(contents: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in contents.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if raw_line != stripped or raw_line.count("=") != 1:
            raise PublicConfigError("malformed public deployment configuration")

        name, value = raw_line.split("=", 1)
        if name not in EXPECTED_PUBLIC_VALUES:
            raise PublicConfigError("unexpected public deployment setting")
        if name in values:
            raise PublicConfigError("duplicate public deployment setting")
        if value != EXPECTED_PUBLIC_VALUES[name]:
            raise PublicConfigError("public deployment setting does not match its canonical value")
        values[name] = value

    if set(values) != set(EXPECTED_PUBLIC_VALUES):
        raise PublicConfigError("required public deployment setting is missing")
    return values


def main() -> int:
    if len(sys.argv) != 2:
        print("Public Dust Genesis configuration validation failed.", file=sys.stderr)
        return 2
    try:
        values = parse_public_config(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, PublicConfigError):
        # Do not include file contents or parsed values in diagnostics.
        print("Public Dust Genesis configuration validation failed.", file=sys.stderr)
        return 1

    # Fixed order and canonical values; caller captures this output, never evals it.
    for name in EXPECTED_PUBLIC_VALUES:
        print(values[name])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
