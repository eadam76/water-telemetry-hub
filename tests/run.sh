#!/usr/bin/env bash
# Every automated check this project has, in one command.
#
#   ./tests/run.sh          everything
#   ./tests/run.sh cpp      firmware headers only (no browser needed)
#   ./tests/run.sh config   the meter entities' numeric contracts
#   ./tests/run.sh js       dashboard syntax + end-to-end browser tests
#
# The firmware itself can only be compiled inside ESP-IDF, which is why
# the C++ suite compiles the two headers that carry the real logic
# (include/volume.h, include/rs485_modbus.h) against small stand-ins for
# the ESPHome APIs they use - see tests/stubs. The browser suite runs
# web/dashboard.js unmodified against a mocked SSE stream and fetch().
set -euo pipefail

cd "$(dirname "$0")/.."
what="${1:-all}"
status=0

if [[ "$what" == "all" || "$what" == "cpp" ]]; then
  echo "== firmware (C++) =="
  out="$(mktemp -d)"
  g++ -std=c++17 -Wall -Wextra -Wno-unused-parameter -O1 \
      -Itests/stubs -Iinclude \
      -o "$out/test_firmware" tests/cpp/test_firmware.cpp tests/stubs/stubs.cpp
  "$out/test_firmware" || status=1
  rm -rf "$out"
fi

if [[ "$what" == "all" || "$what" == "config" ]]; then
  echo
  echo "== firmware configuration =="
  # Needs ESPHome, which the C++ and browser suites deliberately do not -
  # skipped rather than failed when it isn't installed, so the fast
  # checks stay runnable anywhere. CI always has it (see the validate job).
  if command -v esphome >/dev/null 2>&1; then
    python3 tests/check_config.py || status=1
  else
    echo "esphome not installed - skipped"
  fi
fi

if [[ "$what" == "all" || "$what" == "js" ]]; then
  echo
  echo "== dashboard (JavaScript) =="
  node --check web/dashboard.js
  echo "syntax OK"
  echo
  # Playwright may be installed globally rather than in this repo.
  if [[ -z "${NODE_PATH:-}" ]] && ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
    global_modules="$(npm root -g 2>/dev/null || true)"
    [[ -n "$global_modules" ]] && export NODE_PATH="$global_modules"
  fi
  node tests/e2e/dashboard.mjs || status=1
fi

exit $status
