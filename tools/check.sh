#!/usr/bin/env bash
#
# The whole acceptance checklist, in one command.
#
#   tools/check.sh            syntax, generated-page freshness, unit/behaviour tests
#   tools/check.sh --browser  also run the headless-browser page check
#
# Everything is local: no network is used and nothing is downloaded. Node comes
# from PATH or the Nix store; the two libraries the tests import (esbuild, jsdom)
# come from NODE_PATH, which the flake sets. A layer whose library is genuinely
# missing prints SKIP rather than failing -- which is right on a bare-Node laptop,
# and is turned into a hard error by the flake, so a SKIP can never read as green
# in a build where the libraries are pinned by package-lock.json.
set -uo pipefail
cd "$(dirname "$0")/.."

status=0
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN="$(ls -1 /nix/store/*node*/bin/node 2>/dev/null | sort -V | tail -1)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "FAIL: no Node runtime found on PATH or in /nix/store." >&2
  echo "      Every check here needs Node; the app itself needs only a browser." >&2
  exit 1
fi
echo "node: $($NODE_BIN --version)"

# Where the generated page goes. The project root, normally, which is what a
# developer wants to open. But inside a Nix build the source tree is a read-only
# store path and writing index.html there fails with EACCES, so fall back to a
# temporary file -- the freshness comparison and the browser check both work from it.
HTML_OUT="index.html"
if ! (touch index.html 2>/dev/null && rm -f index.html); then
  HTML_OUT="$(mktemp -t pressure-well-index-XXXXXX.html)"
fi
export HTML_OUT

# Build before anything reads the page. index.html is generated and deliberately not
# committed, so a fresh checkout -- and every CI runner -- has no page to open or
# compare. Building is always correct: the freshness comparison below is what proves
# the result matches src/, which is why the artifact need not be committed.
if ! "$NODE_BIN" tools/build.mjs "$HTML_OUT"; then
  echo "FAIL: tools/build.mjs did not run; nothing below can check the generated page." >&2
  exit 1
fi

echo
echo "== syntax (node --check) =="
for file in src/*.js tests/*.mjs tools/*.mjs; do
  if "$NODE_BIN" --check "$file" 2>/dev/null; then
    echo "  ok   $file"
  else
    echo "  FAIL $file"
    "$NODE_BIN" --check "$file" 2>&1 | sed 's/^/       /'
    status=1
  fi
done

echo
echo "== generated index.html is current =="
# Compare the file just built against the index.html on disk. In a checkout these
# are the same path, so this catches "you edited src/ and did not rebuild" -- the
# artifact a preview or Pages serves would otherwise be someone else's code.
#
# A writable tree with no index.html is a real failure: the artifact is gone. A
# read-only tree -- a Nix build, where the source lives in the store and nothing can
# be written there -- is not comparable, so the check reports SKIP. The flake turns
# any SKIP into a build failure, but this is the one case where a skip is the
# correct outcome, so the build sets ALLOW_SKIP to say so rather than the check
# guessing from the environment.
# Exit codes from the comparison below: 0 fresh, 3 sanctioned skip, anything else
# is a failure. The status is captured into a variable before it is examined --
# `$?` immediately after `if cmd; then ... elif` refers to the last command run in
# the then-branch, not to cmd, so an `elif [ $? -eq 3 ]` would read the wrong code.
"$NODE_BIN" -e '
  const { readFileSync } = require("node:fs");
  const fresh = readFileSync(process.env.HTML_OUT, "utf8");
  let onDisk = null;
  try { onDisk = readFileSync("index.html", "utf8"); } catch {}
  if (onDisk === null) {
    if (process.env.ALLOW_SKIP === "1") process.exit(3);
    console.error("index.html is missing -- run: node tools/build.mjs"); process.exit(1);
  }
  if (onDisk !== fresh) { console.error("index.html differs from a fresh build of src/ -- run: node tools/build.mjs"); process.exit(1); }
  ' && fresh_code=0 || fresh_code=$?
case "$fresh_code" in
  0) echo "  ok   index.html matches a fresh build from src/" ;;
  3) echo "  SKIP no index.html to compare against (read-only source tree)" ;;
  *) echo "  FAIL index.html is not what src/ builds to"; status=1 ;;
esac

echo
echo "== tests =="
for test_file in tests/*.test.mjs; do
  # The `if` is load-bearing: errexit would otherwise abort the loop the moment a
  # test fails, before the code can be recorded, and a real failure would look like
  # a script that died for nothing.
  if output="$("$NODE_BIN" "$test_file" 2>&1)"; then
    code=0
  else
    code=$?
  fi
  if [ $code -eq 0 ]; then
    if printf '%s' "$output" | grep -q '^SKIP'; then
      echo "  SKIP $test_file"
      printf '%s\n' "$output" | sed 's/^/       /'
    else
      echo "  ok   $test_file  $(printf '%s' "$output" | tail -1)"
    fi
  else
    echo "  FAIL $test_file"
    printf '%s\n' "$output" | sed 's/^/       /'
    status=1
  fi
done

if [ "${1:-}" = "--browser" ]; then
  echo
  echo "== headless browser page check =="
  if bash tools/run-browser-check.sh; then
    echo "  ok   browser check"
  else
    echo "  FAIL browser check (screenshots in .tmp/shots)"
    status=1
  fi
fi

echo
if [ $status -eq 0 ]; then echo "PASS"; else echo "FAIL"; fi
exit $status
