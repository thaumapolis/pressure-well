#!/usr/bin/env bash
# Run the headless-browser check.
#
# Playwright and its browser come from the environment when there is one to take:
# `nix develop` exports PLAYWRIGHT_ENTRY and PLAYWRIGHT_BROWSERS_PATH for the pair
# pinned in flake.nix. Where nothing is exported -- a laptop that ran `npm install`
# plus `npx playwright install chromium` -- they stay unset and Playwright resolves
# its own browser. `--no-sandbox` is passed regardless, because this container gives
# Chromium no user namespace.
#
# An empty variable is not the same as an absent one downstream: browser-check reads
# PLAYWRIGHT_ENTRY='' as a module id, so nothing is exported unless it was found, and
# an inherited value is never overwritten. Guessing on top of the flake's pinned
# Playwright would silently swap in whichever browser sorted last out of /nix/store.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  NODE_BIN="$(ls -1 /nix/store/*node*/bin/node 2>/dev/null | sort -V | tail -1)"
else
  NODE_BIN="$(command -v node)"
fi

mkdir -p .tmp/shots

if [ -z "${PLAYWRIGHT_ENTRY:-}" ]; then
  candidate="/tmp/codex"
  for dir in "$code" "$candidate"/*/source/node_modules "$candidate"/*/node_modules; do
    if [ -f "$dir/playwright/index.js" ]; then
      export PLAYWRIGHT_ENTRY="$dir/playwright/index.js"
      break
    fi
  done
fi

if [ -z "${CHROMIUM_PATH:-}" ]; then
  # The flake exports PLAYWRIGHT_BROWSERS_PATH for the browser its nixpkgs pin
  # selects. Use that, not whatever Chromium happens to be resident in the store:
  # sorting /nix/store and taking the highest chromium-<n> silently paints the
  # goldens on a different browser than CI runs, so a baseline can be recorded on
  # one build and checked on another. Locate inside the pinned registry only; fall
  # back to the store glob solely when no registry is exported (a laptop that ran
  # `npx playwright install`). The font set is pinned separately, via
  # FONTCONFIG_FILE in flake.nix -- the golden failures here were caption glyphs,
  # not the browser, so pinning only the browser would not have made them stable.
  if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    pinned_chrome="$(ls -1 "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1 || true)"
  else
    pinned_chrome=""
  fi
  store_chrome="${pinned_chrome:-$(ls -1 /nix/store/*playwright-browsers*/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1 || true)}"
  if [ -n "$store_chrome" ]; then
    export CHROMIUM_PATH="$store_chrome"
    # Only set the registry from the located binary when none was exported, so the
    # executable and the registry it came from cannot disagree in the fallback case.
    export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$(dirname "$(dirname "$(dirname "$store_chrome")")")}"
  fi
fi

echo "playwright: ${PLAYWRIGHT_ENTRY:-resolved by Playwright from its own package}"
if [ -n "${CHROMIUM_PATH:-}" ]; then
  echo "chromium:   $CHROMIUM_PATH"
else
  echo "chromium:   ${PLAYWRIGHT_BROWSERS_PATH:-resolved by Playwright from its own download}"
fi

"$NODE_BIN" tools/browser-check.mjs "${1:-.tmp/shots}"
