#!/usr/bin/env python3
"""Test strict public-config parsing and deployment helper safety gates."""

import importlib.util
import os
import pty
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts" / "dust-genesis-deploy.sh"
PARSER = REPO_ROOT / "scripts" / "dust_genesis_deploy_config.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("dust_genesis_deploy_config", PARSER)
config_parser = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(config_parser)

CANONICAL_CONFIG = "\n".join(
    f"{name}={value}"
    for name, value in config_parser.EXPECTED_PUBLIC_VALUES.items()
)


class PublicConfigParserTests(unittest.TestCase):
    def test_accepts_all_canonical_public_values(self) -> None:
        self.assertEqual(
            config_parser.parse_public_config(CANONICAL_CONFIG),
            config_parser.EXPECTED_PUBLIC_VALUES,
        )

    def test_rejects_duplicate_setting(self) -> None:
        with self.assertRaises(config_parser.PublicConfigError):
            config_parser.parse_public_config(CANONICAL_CONFIG + "\n" + CANONICAL_CONFIG.splitlines()[0])

    def test_rejects_unexpected_setting(self) -> None:
        with self.assertRaises(config_parser.PublicConfigError):
            config_parser.parse_public_config(CANONICAL_CONFIG + "\nEXTRA=value")

    def test_rejects_malformed_lines(self) -> None:
        malformed = (
            CANONICAL_CONFIG + "\nDUST_GENESIS_OWNER_ADDRESS=unexpected=value",
            CANONICAL_CONFIG + "\n DUST_GENESIS_OWNER_ADDRESS=value",
        )
        for contents in malformed:
            with self.subTest(contents=contents[-50:]):
                with self.assertRaises(config_parser.PublicConfigError):
                    config_parser.parse_public_config(contents)

    def test_rejects_shell_expression_without_evaluating_it(self) -> None:
        contents = CANONICAL_CONFIG.replace(
            config_parser.EXPECTED_PUBLIC_VALUES["DUST_GENESIS_METADATA_URI"],
            "$(touch /tmp/dust-genesis-parser-must-not-execute)",
        )
        with self.assertRaises(config_parser.PublicConfigError):
            config_parser.parse_public_config(contents)


class DeployHelperTests(unittest.TestCase):
    def test_validate_only_clears_inherited_key_and_never_invokes_forge(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dust-genesis-helper-test-") as temp_name:
            temp = Path(temp_name)
            fake_root = temp / "repo"
            (fake_root / "scripts").mkdir(parents=True)
            (fake_root / "contracts" / "dust-genesis").mkdir(parents=True)
            shutil.copy2(HELPER, fake_root / "scripts" / HELPER.name)
            shutil.copy2(PARSER, fake_root / "scripts" / PARSER.name)
            (fake_root / ".env.dust-genesis").write_text(CANONICAL_CONFIG + "\n", encoding="utf-8")

            fake_bin = temp / "bin"
            fake_bin.mkdir()
            npm = fake_bin / "npm"
            npm.write_text(
                "#!/bin/sh\n"
                "if [ -n \"${DUST_GENESIS_DEPLOYER_PRIVATE_KEY:-}\" ]; then exit 41; fi\n"
                "printf '%s\\n' \"$*\" > \"$DUST_GENESIS_TEST_PREFLIGHT_MARKER\"\n",
                encoding="utf-8",
            )
            npm.chmod(0o755)
            forge_marker = temp / "forge-was-called"
            forge = fake_bin / "forge"
            forge.write_text(
                "#!/bin/sh\nprintf called > \"$DUST_GENESIS_TEST_FORGE_MARKER\"\n",
                encoding="utf-8",
            )
            forge.chmod(0o755)

            preflight_marker = temp / "preflight-called"
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"
            env["DUST_GENESIS_TEST_PREFLIGHT_MARKER"] = str(preflight_marker)
            env["DUST_GENESIS_TEST_FORGE_MARKER"] = str(forge_marker)
            env["DUST_GENESIS_DEPLOYER_PRIVATE_KEY"] = "harmless-inherited-test-sentinel"

            master_fd, slave_fd = pty.openpty()
            try:
                result = subprocess.run(
                    ["bash", str(fake_root / "scripts" / HELPER.name), "--validate-only"],
                    stdin=slave_fd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                    check=False,
                    text=True,
                )
            finally:
                os.close(master_fd)
                os.close(slave_fd)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(preflight_marker.read_text(encoding="utf-8").strip(), "run dust-genesis:preflight")
            self.assertFalse(forge_marker.exists(), "validation-only unexpectedly invoked Foundry")
            self.assertIn("stopped before confirmation and Foundry", result.stdout)
            self.assertNotIn("BROADCAST BASE MAINNET", result.stdout)
            self.assertNotIn("input hidden", result.stdout)
            self.assertNotIn("harmless-inherited-test-sentinel", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
