# Minimum app version

Status: **Draft**.

The server's `config` ([`docs/api/card-proof.md`](../docs/api/card-proof.md))
gives the Android app and the iOS app each a lowest build that may still do a
card proof, and the date that bound starts on (ADR-0035). An app older than
the bound stops before it asks for the PIN or reads the card. This document
defines how an app reads the field and what it does with each value. The
web page has no minimum version and does not read the field.

The server does not look at app versions when it accepts a card proof. The
field only makes the store's app stop by itself; an app changed to ignore it
makes proofs the roster rules accept or refuse as any other.

## The field

```
"min_app": {
  "android": { "build": 12, "from": "2027-03-01" },
  "ios": { "build": 9, "from": "2027-03-01" }
}
```

- The member names are the apps' platforms: `android`, `ios`. One app reads
  only the member of its own platform.
- `build` is the store's integer version number of the lowest build that may
  still do a card proof: the `versionCode` of the Android app, the build
  number of the iOS app. The two apps count separately. It is a JSON number
  whose value is a whole number from 1 to 2,100,000,000, the largest
  `versionCode` Google Play allows
  ([Android: Version your app](https://developer.android.com/studio/publish/versioning)).
- `from` is the date in Taiwan the bound starts on, `YYYY-MM-DD`: a date
  that exists, in the years 2000 to 2049, the same form as a challenge's
  date ([`challenge.md`](challenge.md)).

## Reading it

An app reads the `config` it gets as follows. If any step fails, the field
is **unreadable**.

1. The body is a JSON object, with a member `min_app` whose value is an
   object.
2. `min_app` has a member named after the app's own platform, exactly
   (`android` or `ios`, lowercase), whose value is an object.
3. That object has a member `build` and a member `from`, each in the form
   above.

Everything else is ignored, whatever it holds: the other members of the
body, the members of `min_app` for other platforms (another app's entry that
is missing or cannot be read included), and members of the entry other than
`build` and `from`. A platform can then be added to `min_app` without the
apps already installed failing on it.

## What the app does

`today` is the date in Taiwan of the device's own clock, computed as in
[`challenge.md`](challenge.md) ("The cardholder's device"): UTC+8 from the
clock's absolute time, not the time zone set on the device.

| The app's own build | `today` | Verdict | The app |
|---|---|---|---|
| `build` or higher | any | `ok` | Goes on as usual |
| lower than `build` | before `from` | `ok_until` | Goes on as usual, and says from which date (`from`) this version can no longer do a card proof |
| lower than `build` | `from` or later | `stop` | Does not ask for the PIN or read the card. It says this version can no longer do a card proof and must be updated |
| any | any | `unreadable` (the field cannot be read) | Does not go on: it does not ask for the PIN or read the card, the same as with a platform table it cannot read |

`unreadable` comes first: an entry that cannot be read is `unreadable` even
when the app's build is higher than whatever it might mean.

A device clock that is wrong can make the app stop a day early or late
around `from`. A challenge whose date is not the device's today does not
start a card proof anyway ([`challenge.md`](challenge.md)).

## Test vectors

[`vectors/min-app.json`](vectors/min-app.json): each case is the parsed body
of `config`, the app's platform, the app's own build, the device clock's time
(`now`, seconds since the epoch, UTC), and the verdict; `from` is given with
`ok_until`. The cases cover the last second before `from` and the first
second of it in Taiwan (still the day before in UTC), equal, lower and
higher builds, the members that are ignored, and the field missing or in the
wrong form. The file is written by `protocol/test/generate/min-app.ts`, where
each expected verdict is written by hand.
