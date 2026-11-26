//! The minimum app version (spec/min-app.md): how an app reads `min_app`
//! from the server's `config`, and whether its build may do a card proof.

use iamreal_device_checks::date::Date;

use crate::json::Json;

/// The largest `versionCode` Google Play allows; `build` is at most this.
const MAX_BUILD: f64 = 2_100_000_000.0;

/// The clients that read `min_app`: the member names of the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    Android,
    Ios,
}

impl Client {
    fn member(self) -> &'static str {
        match self {
            Client::Android => "android",
            Client::Ios => "ios",
        }
    }
}

/// "What the app does".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The app goes on as usual.
    Ok,
    /// The app goes on as usual, and says from which date this version can
    /// no longer do a card proof.
    OkUntil(Date),
    /// The app does not ask for the PIN or read the card: it must be updated.
    Stop,
    /// The field cannot be read: the app does not go on.
    Unreadable,
}

/// The entry of `client`: its `build` and its `from`, or `None` if the
/// field cannot be read ("Reading it"). Every other member is ignored.
fn entry(config: &[u8], client: Client) -> Option<(u32, Date)> {
    let body = Json::parse(config)?;
    let entry = body
        .as_object()?
        .get("min_app")?
        .as_object()?
        .get(client.member())?
        .as_object()?;
    // Only the value counts, not how it is written: `12`, `12.0` and `1.2e1` are the same build.
    let build = match entry.get("build")? {
        Json::Number(n) if n.fract() == 0.0 && (1.0..=MAX_BUILD).contains(n) => *n as u32,
        _ => return None,
    };
    let from = Date::parse(entry.get("from")?.as_str()?.as_bytes())?;
    Some((build, from))
}

/// The verdict for the app `client` whose own build is `app_build`, on the
/// date `today` in Taiwan, from the body of `config`. `Unreadable` comes
/// first: an entry that cannot be read is unreadable whatever the app's
/// build is.
pub fn verdict(config: &[u8], client: Client, app_build: u32, today: Date) -> Verdict {
    let Some((build, from)) = entry(config, client) else {
        return Verdict::Unreadable;
    };
    if app_build >= build {
        Verdict::Ok
    } else if today < from {
        Verdict::OkUntil(from)
    } else {
        Verdict::Stop
    }
}
