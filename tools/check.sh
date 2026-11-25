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
# Compare the committed index.html against a build from the current src/, without
# writing to it. renderStandalone() is exported for exactly this: rebuilding in
# place and `git checkout --` would make a *passing* check dirty the tree and a
# failing one depend on git state, which is the wrong way round.
if "$NODE_BIN" -e '
  import("./tools/build.mjs").then(async (m) => {
    const { readFileSync } = await import("node:fs");
    const generated = m.renderStandalone();
    let committed = null;
    try { committed = readFileSync("index.html", "utf8"); } catch {}
    if (committed === null) { console.error("index.html is missing -- run: node tools/build.mjs"); process.exit(1); }
    if (committed !== generated) { console.error("index.html differs from a fresh build of src/ -- run: node tools/build.mjs"); process.exit(1); }
  }).catch((error) => { console.error(String(error.message ?? error)); process.exit(1); });
' ; then
  echo "  ok   index.html matches a fresh build from src/"
else
  echo "  FAIL index.html is not what src/ builds to"
  status=1
fi

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
