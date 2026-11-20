# Scope string and platforms

Status: **Draft**.

The scope string is the first of the two 31-byte messages the card signs in a
card proof. The card's signature over it gives the scoped ID
([`scoped-id.md`](scoped-id.md)). Changing a scope string after launch would
give every card a new scoped ID in that scope, so a scope string, once in
use, never changes. Its format and the reasons behind it are in ADR-0007.

The public roster is one scope, shared by every public platform (ADR-0017).
A card has one scoped ID there, and one slot on each platform. The platform
is not part of the scope string: every record carries the card's whole list
of accounts, each with its platform ([`record.md`](record.md)), and the
declaration code is computed from that list
([`declaration-code.md`](declaration-code.md)).

## Format

Scope strings of the scopes we operate are ASCII, so a byte is a character:

```
scope_string = name ":" range ":" version padding      (exactly 31 bytes)
name         = "iamreal" | "iamreal-test"
range        = 1 to 21 characters of a-z, 0-9, "-"
version      = "0" | a decimal number without leading zeros
padding      = zero or more "_", up to 31 bytes in total
```

The `range` of the public roster is `public`.

The first byte is a lowercase letter: the circuit requires a scope string to
start with `a`..`z` or `S` (ADR-0007, ADR-0013). Scopes starting with `S` are
reserved for other services and are defined separately before the first one
opens. Their scoped IDs are unrelated to the ones in the public roster, and
their results are not written to it (ADR-0017).

## Accepted scopes

A roster accepts records only in the scopes listed for it: the production
roster exactly the rows under "Production roster", a test roster exactly the
rows under "Test rosters only". A record in any other scope string, including
another spelling of a listed one (`…:00_____…`, `Public`, a different
padding), makes the line malformed ([`record.md`](record.md)).

**Production roster**

| Scope string | Last accepted `seq` |
|---|---|
| `iamreal:public:0_______________` | open |

**Test rosters only**

| Scope string | Last accepted `seq` |
|---|---|
| `iamreal-test:public:0__________` | open |

A test scope string never appears in the production roster, and a production
scope string never appears in a test roster. A test scope string produces
scoped IDs unrelated to the production ones.

### Starting over

Rows are never removed, and a row changes only once: when the scope is
retired (ADR-0007: its version is replaced), its row gets the `seq` of the
last record it accepts, and a row for the new version is added. A later
record in the retired scope makes the line malformed, so one card cannot keep
slots in both the old and the new version.

Retiring the scope voids the slots of every platform together (ADR-0017):
the new version gives every card a new scoped ID, and every cardholder
declares again on every platform. One platform cannot start over by itself.

## Platforms

A platform is the service an account is on. A roster accepts records only
for the platforms listed for it: the production roster exactly the rows under
"Production roster", a test roster those rows and the rows under "Test
rosters only". A record whose account list names anything else as a
`platform`, including another spelling of a listed ID (`Threads`,
`threads_`), makes the line malformed ([`record.md`](record.md)). The number
of rows is also the greatest length of a record's list: one account per
platform.

A platform ID contains no `:`, no `"` and no line feed. The declaration code
and the record's line rely on that.

```
platform = 1 to 21 characters of a-z, 0-9, "-"
```

**Production roster**

| `platform` | Display name | `username` format | Added |
|---|---|---|---|
| `threads` | Threads | `[a-z0-9._]{1,30}` | With the first version of this table |

**Test rosters only**

| `platform` | Display name | `username` format | Added |
|---|---|---|---|
| `test-example` | Example (no real service) | `[a-z0-9-]{1,20}` | With the first version of this table |

- The `platform` ID is a permanent identifier, not a display name: the most
  common English name of the platform when the row is added. It does not
  follow the platform when it is renamed (ADR-0007). The display name is for
  screens and may change.
- `test-example` stands for no real service. It exists so that a test roster
  has a second platform, to test lists of two accounts and the rules that
  count per platform ([`roster-rules.md`](roster-rules.md)). Its `username` format differs from
  the Threads one on purpose: `a-b` is valid only there, `a.b` only on
  Threads. It never appears in the production roster. **IDs starting with
  `test-` are never added to the production table.**
- "Added" is for readers. The rules do not read it.
- The server sends its copy of this table to devices
  ([`docs/api/card-proof.md`](../docs/api/card-proof.md), `config`). That
  copy is a convenience. What a roster accepts is this table.

### Adding a platform

Adding a platform adds a row. Nothing else changes: the scope string and
every card's scoped ID stay the same, the records already in the roster keep
their meaning (none of them lists the new platform, so no card declares an
account there), and the first account a card lists on the new platform is a
`first` ([`roster-rules.md`](roster-rules.md)). The card's last card proof
date already covers the new platform.

- **Rows are never removed, and an ID is never reused** for another service.
- **One service has one row.** A second ID for a service that already has a
  row (another name, an abbreviation, the name after a rebranding) would give
  every card a second slot and a second switch allowance on that service.
- **A re-verifier needs a table at least as new as the roster.** With an
  older table, the first record that lists a platform it does not know is a
  malformed line, and the roster file is reported as broken.
- **A device does not drop what it does not know.** A record states the
  whole list, so a device that left out an account on a platform it does
  not know would withdraw it. It keeps that account in the list as it is
  ([`docs/api/card-proof.md`](../docs/api/card-proof.md)).
- A card proof cannot be made ahead with a platform that is not listed yet:
  the server rejects it, and its challenge expires after 10 minutes
  ([`challenge.md`](challenge.md)).

### The `username` format

Each platform fixes one spelling per account, so that one account is never
counted as two. An account is the pair (`platform`, `username`): the same
`username` on two platforms is two accounts. Platforms that do not
distinguish case (Threads, like Instagram) store the name in lowercase; the
screen accepts any case and lowercases it before the declaration code is
computed. A platform where `Alice` and `alice` are different accounts would
allow uppercase in its row instead.

The format of a platform is fixed when its row is added. It may be widened
later (old records stay valid), never narrowed ("Changing the tables").
If a platform narrows its own names, the row keeps its format; whether new
declarations of names the platform no longer allows are refused is a rule
of the server, not of the roster. The Threads row is
provisional: lowercase letters, digits, `.` and `_`, 1 to 30 characters,
to be confirmed against the platform's published rules before launch.

None of the formats allows `"`, `\`, a control character or a non-ASCII
character. Formats are matched against the whole value (in several
languages `^…$` also accepts a trailing line feed).

Every format is written as one character class followed by one length
range, `[…]{m,n}`: which characters, and how many. A device gets the
formats from the server as these strings and reads this one form itself, so
a row never needs more of a regular expression language than that.

## Changing the tables

The tables of this document only widen and grow: the accepted scope
strings, the platform IDs and the `username` formats. A row is added or a
format widened; nothing is narrowed or removed. Retiring a scope ("Starting
over") closes it to later records only; the records it accepted stay well
formed.

Every record already written must stay well formed whatever changes later
([`roster-rules.md`](roster-rules.md), "Changing these rules"). A record
whose scope string, platform ID or `username` a narrower table did not
accept would make its line malformed and the whole roster file broken
([`record.md`](record.md)). Lines are checked before the roster rules run,
so an effective date cannot help.

## Packing

In the proof, the scope string is the public input `scope_packed`: the 31
bytes `b[0] .. b[30]` as the field element

```
b[0] + b[1]·256 + … + b[30]·256^30
```

`b[0]` is the least significant byte. 31 bytes fit in one field element, so
the packing is one-to-one. The declaration code is packed the same way
([`declaration-code.md`](declaration-code.md)).

The platforms and accounts of a record are not public inputs. They are
bound to the proof only through the declaration code.

## Open items

- **Closing one platform to new records** (a service that shuts down) is not
  defined. Until it is, a row stays open.

## Test vectors

[`vectors/scope.json`](vectors/scope.json): the accepted scope strings with
their packed values; strings that are not accepted, with the reason;
platform IDs accepted and not accepted by each roster, the accepted ones
with their display name and `username` format; usernames valid and
invalid for the format of each platform.
