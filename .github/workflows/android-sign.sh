#!/usr/bin/env bash
# Signs the bundle the build job of upload-android.yml made, with the upload
# key, for Google Play (ADR-0036: the upload key proves to Google Play that
# we sent it; the app signing key is not here). Google Play's documentation
# signs a bundle with jarsigner ("Sign your app",
# https://developer.android.com/studio/publish/app-signing); apksigner signs
# APKs, not bundles.
#
#   android-sign.sh <bundle> <signed bundle>
#
# The key is in the environment, as the environment app-test holds it (#162):
# ANDROID_UPLOAD_KEYSTORE_BASE64, a PKCS12 file in base64 with the alias
# `upload`, and ANDROID_UPLOAD_KEYSTORE_PASSWORD, the password of the file
# and of the key. The file is written to a temporary file of its own, only
# for jarsigner, and removed when the script ends. jarsigner reads the
# password from the environment (-storepass:env), not from its command line.
# JAVA_HOME is the JDK whose jarsigner signs.
#
# The bundle it was given is left as it is. After signing, the signed bundle
# must verify, and hold exactly the files of the one it was given, each
# with the same CRC-32, and the three files of the signature: what goes to
# Google Play is what the build checked (app/build.gradle.kts, checkBundle).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: android-sign.sh <bundle> <signed bundle>" >&2
  exit 1
fi
from=$1
to=$2
jarsigner="$JAVA_HOME/bin/jarsigner"

keystore=$(mktemp)
trap 'rm -f "$keystore"' EXIT
printf '%s' "$ANDROID_UPLOAD_KEYSTORE_BASE64" | base64 --decode > "$keystore"

mkdir -p "$(dirname "$to")"
cp "$from" "$to"
"$jarsigner" -keystore "$keystore" -storetype PKCS12 -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD \
  -sigalg SHA256withRSA -digestalg SHA-256 "$to" upload > /dev/null
rm -f "$keystore"

"$jarsigner" -verify "$to" | grep --quiet --line-regexp 'jar verified.'

# Each file's CRC-32 and name, as unzip -v lists them.
crcs() { unzip -v "$1" | awk '$7 ~ /^[0-9a-f]{8}$/ && NF == 8 { print $7, $8 }' | sort; }
signature='META-INF/MANIFEST.MF|META-INF/UPLOAD.SF|META-INF/UPLOAD.RSA'
added=$(comm -13 <(crcs "$from") <(crcs "$to") | awk '{ print $2 }' | sort | paste -sd '|' -)
removed=$(comm -23 <(crcs "$from") <(crcs "$to"))
if [ -n "$removed" ] || [ "$added" != "$(tr '|' '\n' <<< "$signature" | sort | paste -sd '|' -)" ]; then
  echo "the signed bundle is not the bundle it was given and the signature: added $added, changed or removed $removed" >&2
  exit 1
fi
