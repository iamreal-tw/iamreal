#!/usr/bin/env bash
# Puts a signed bundle of tw.iamreal.app on Google Play's internal testing
# track (ADR-0036, ADR-0037), with the Google Play Developer API
# (https://developers.google.com/android-publisher), by curl, openssl and
# jq alone: no action or tool besides what the runner has.
#
#   play-upload.sh <signed bundle>
#
# PLAY_SERVICE_ACCOUNT_JSON is the key of the service account (#162), as
# Google gives it (JSON). Its permissions in Play Console are the app's
# "Release apps to testing tracks", which "Does not allow users to publish
# apps to production on Google Play" (ADR-0036), and two that only read.
#
# 1. A token, for a JWT the account's key signs (Google's "Using OAuth 2.0
#    for Server to Server Applications",
#    https://developers.google.com/identity/protocols/oauth2/service-account),
#    for the API's one scope, valid for ten minutes. The key goes to openssl
#    through a pipe; the token is masked in the log and goes to curl through
#    a pipe too, as its header file (--header @file), never on a command
#    line.
# 2. An edit: the API's changes are made in one and take effect together
#    when it is committed (edits.insert ... edits.commit).
# 3. The bundle, uploaded into the edit (edits.bundles.upload). Google Play
#    answers with its versionCode.
# 4. The internal testing track gets a release of that versionCode, rolled
#    out to its testers (edits.tracks.update, status "completed").
# 5. The edit, committed.
# Any call that fails stops the script, with the API's answer in the log;
# an edit left uncommitted changes nothing and expires.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: play-upload.sh <signed bundle>" >&2
  exit 1
fi
bundle=$1
package=tw.iamreal.app
track=internal
api="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/$package"
upload_api="https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/$package"
token_url="https://oauth2.googleapis.com/token"

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# 1. The token.
# A field of a JSON text, which must be there: field <json> <filter>
field() { printf '%s' "$1" | jq --exit-status --raw-output "$2"; }
email=$(field "$PLAY_SERVICE_ACCOUNT_JSON" .client_email)
now=$(date +%s)
header=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)
claims=$(jq --null-input --compact-output --arg iss "$email" --arg aud "$token_url" --argjson now "$now" \
  '{iss: $iss, scope: "https://www.googleapis.com/auth/androidpublisher", aud: $aud, iat: $now, exp: ($now + 600)}' | base64url)
signature=$(printf '%s.%s' "$header" "$claims" |
  openssl dgst -sha256 -binary -sign <(field "$PLAY_SERVICE_ACCOUNT_JSON" .private_key) | base64url)
# curl, with what the server answered printed to the log when the call fails
# (the answers to a failed call are errors: they hold no token).
#   call <url> [curl's options...]
call() {
  local url=$1 answer
  shift
  if ! answer=$(curl --silent --show-error --fail-with-body "$@" "$url"); then
    echo "the call to $url failed: $answer" >&2
    return 1
  fi
  printf '%s' "$answer"
}

answer=$(printf 'grant_type=%s&assertion=%s.%s.%s' 'urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer' "$header" "$claims" "$signature" |
  call "$token_url" --data @-)
token=$(field "$answer" .access_token)
echo "::add-mask::$token"

# A call to the API, with the token: api <method> <url> [curl's options...]
api() {
  local method=$1 url=$2
  shift 2
  call "$url" --request "$method" --header @<(printf 'Authorization: Bearer %s\n' "$token") "$@"
}

# 2. The edit.
answer=$(api POST "$api/edits" --header 'Content-Type: application/json' --data '{}')
edit=$(field "$answer" .id)

# 3. The bundle.
answer=$(api POST "$upload_api/edits/$edit/bundles?uploadType=media" --header 'Content-Type: application/octet-stream' \
  --data-binary "@$bundle" --max-time 900)
version_code=$(field "$answer" .versionCode)

# 4. The release on the track.
release=$(jq --null-input --compact-output --arg track "$track" --arg code "$version_code" '{track: $track, releases: [{versionCodes: [$code], status: "completed"}]}')
api PUT "$api/edits/$edit/tracks/$track" --header 'Content-Type: application/json' --data "$release" > /dev/null

# 5. The commit.
# An empty body, so that curl says Content-Length: 0 for this POST.
api POST "$api/edits/$edit:commit" --data '' > /dev/null
echo "versionCode $version_code is on the $track track of $package"
