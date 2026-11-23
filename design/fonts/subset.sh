#!/bin/sh
# Writes GenRyuMin2TW-B.woff2 again: the subset of GenRyuMin2 TW Bold (源流明體 TW,
# ButTaiwan, SIL OFL 1.1) the pages use. Run it by hand after a change of
# design/copy/; nothing of a deploy or a build runs it (README.md).
#
# - The font is the B weight of the release v2.100 of
#   https://github.com/ButTaiwan/genryu-font, at the commit of that release,
#   checked against its SHA-256 before it is read.
# - The subset holds every character of every file of design/copy/ and the
#   printable ASCII, U+0020 to U+007E (an account, a date and a number are
#   not written in design/copy/).
# - It keeps the name table's records 0 to 6 (fonttools' default), 13 (the
#   licence) and 14 (the licence's URL): the OFL asks that every copy of
#   the font carries its copyright notice and licence.
# - fonttools writes WOFF2 with brotli; both are pinned to an exact version.
#
# Needs curl, shasum and uv (https://docs.astral.sh/uv/).
set -eu

COMMIT=b973b7bd3210a8651131046d9e0cfb9e1aa51b36
URL="https://raw.githubusercontent.com/ButTaiwan/genryu-font/$COMMIT/otf/TW/GenRyuMin2TW-B.otf"
SHA256=5e7d2c11cf9860c94ac7d1fba742329f6015f7042c736232e1e69eb8ab12d5da

here=$(cd "$(dirname "$0")" && pwd)
copy="$here/../copy"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/GenRyuMin2TW-B.otf" "$URL"
echo "$SHA256  $tmp/GenRyuMin2TW-B.otf" | shasum -a 256 -c -

# Every file of design/copy/, as one text: fonttools takes each character of it once.
cat "$copy"/* > "$tmp/text.txt"

uv run --no-project --isolated --with fonttools==4.68.0 --with brotli==1.2.1 \
  pyftsubset "$tmp/GenRyuMin2TW-B.otf" \
  --text-file="$tmp/text.txt" \
  --unicodes=U+0020-007E \
  --name-IDs=0,1,2,3,4,5,6,13,14 \
  --flavor=woff2 \
  --output-file="$here/GenRyuMin2TW-B.woff2"

shasum -a 256 "$here/GenRyuMin2TW-B.woff2"
echo "Copy it to worker/site/fonts/ too: cd worker && node --experimental-strip-types scripts/site-files.ts"
