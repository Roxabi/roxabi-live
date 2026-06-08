#!/usr/bin/env bash
# Fail if any two pytest ``testpaths`` files resolve to the same bare module
# name under ``--import-mode=importlib``.
#
# Why: the root ``pyproject.toml`` sets ``--import-mode=importlib``. Under that
# mode pytest imports a test file via the parent chain of ``__init__.py``
# files — if an ``__init__.py`` is present, the module name is fully
# qualified (e.g. ``tests.test_health``); if it is absent, the module
# name is the file's bare basename (e.g. ``test_health``).
#
# Two bare-basename files with the same name register under the same key in
# ``sys.modules``; the second import silently reuses the first and its
# assertions never run.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

mapfile -t TESTPATHS < <(python3 -c "
import tomllib
with open('pyproject.toml', 'rb') as f:
    cfg = tomllib.load(f)
for p in cfg['tool']['pytest']['ini_options']['testpaths']:
    print(p)
")

if [ "${#TESTPATHS[@]}" -eq 0 ]; then
    echo "no testpaths found in pyproject.toml [tool.pytest.ini_options]" >&2
    exit 1
fi

for p in "${TESTPATHS[@]}"; do
    [ -d "$p" ] || { echo "testpath not found: $p" >&2; exit 1; }
done

BARE_FILES=$(
    find "${TESTPATHS[@]}" -type f -name 'test_*.py' \
        | while IFS= read -r f; do
            [ -f "$(dirname "$f")/__init__.py" ] || printf '%s\n' "$f"
          done
)

DUPES=$(
    printf '%s\n' "$BARE_FILES" \
        | awk -F/ 'NF > 0 { print $NF "\t" $0 }' \
        | sort \
        | awk -F'\t' '
            { count[$1]++; paths[$1] = paths[$1] $2 "\n" }
            END {
                for (b in count) {
                    if (count[b] > 1) {
                        printf("duplicate bare basename: %s\n%s", b, paths[b])
                    }
                }
            }
          '
)

if [ -n "$DUPES" ]; then
    echo "Duplicate bare test basenames across pytest testpaths:" >&2
    printf '%s\n' "$DUPES" >&2
    exit 1
fi

exit 0
