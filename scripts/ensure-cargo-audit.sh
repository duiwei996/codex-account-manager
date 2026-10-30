#!/usr/bin/env bash
set -euo pipefail

expected='cargo-audit 0.22.1'
actual="$(cargo-audit --version 2>/dev/null || true)"
if [[ "$actual" != "$expected" ]]; then
  echo "Auditor binary mismatch: expected $expected, got ${actual:-missing}; reinstalling."
  # Cargo's installation metadata may disagree with a restored cached binary.
  cargo install cargo-audit --locked --version 0.22.1 --force
fi
actual="$(cargo-audit --version)"
if [[ "$actual" != "$expected" ]]; then
  echo "Auditor installation failed verification: expected $expected, got $actual" >&2
  exit 1
fi
echo "Verified $actual"
