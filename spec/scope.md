# Scope string

Status: **Draft**.

The scope string is the first of the two 31-byte messages the card signs in a
card proof. The card's signature over it gives the scoped ID
([`scoped-id.md`](scoped-id.md)). Changing a scope string after launch would
give every card a new scoped ID in that scope, so a scope string, once in
use, never changes. Its format and the reasons behind it are in ADR-0007.

## Format

Scope strings of the scopes we operate are ASCII, so a byte is a character:

```
scope_string = name ":" platform ":" version padding      (exactly 31 bytes)
name         = "iamreal" | "iamreal-test"
platform     = 1 to 21 characters of a-z, 0-9, "-"
version      = "0" | a decimal number without leading zeros
padding      = zero or more "_", up to 31 bytes in total
```

The first byte is a lowercase letter: the circuit requires a scope string to
start with `a`..`z` or `S` (ADR-0007, ADR-0013). Scopes starting with `S` are
reserved for other services and are defined separately before the first one
opens.

## Accepted scopes

A roster accepts records only in the scopes listed for it: the production
roster exactly the rows under "Production roster", a test roster exactly the
rows under "Test rosters only". A record in any other scope string, including
another spelling of a listed one (`…:00_____…`, `Threads`, a different
padding), makes the line malformed ([`record.md`](record.md)).

Adding a scope adds a row. Rows are never removed, and a row changes only
once: when a scope is retired (ADR-0007: its version is replaced), its row
gets the `seq` of the last record it accepts. A later record in that scope
makes the line malformed, so one card cannot keep a slot in both the old and
the new version.

**Production roster**

| Scope string | Platform | `username` format | Last accepted `seq` |
|---|---|---|---|
| `iamreal:threads:0______________` | Threads | `[a-z0-9._]{1,30}` | open |

**Test rosters only**

| Scope string | Platform | `username` format | Last accepted `seq` |
|---|---|---|---|
| `iamreal-test:threads:0_________` | Threads | `[a-z0-9._]{1,30}` | open |

A test scope string never appears in the production roster, and a production
scope string never appears in a test roster. A test scope string produces
scoped IDs unrelated to the production ones.

### The `username` format

Each scope fixes one spelling per account, so that one account is never
counted as two. Platforms that do not distinguish case (Threads, like
Instagram) store the name in lowercase; the screen accepts any case and
lowercases it before the declaration code is computed. A platform where
`Alice` and `alice` are different accounts would allow uppercase in its
row instead.

The format of a scope is fixed when the scope opens. It may be widened
later (old records stay valid), never narrowed. The Threads row is
provisional: lowercase letters, digits, `.` and `_`, 1 to 30 characters,
to be confirmed against the platform's published rules before launch.

None of the formats allows `"`, `\`, a control character or a non-ASCII
character. Formats are matched against the whole value (in several
languages `^…$` also accepts a trailing line feed).

## Packing

In the proof, the scope string is the public input `scope_packed`: the 31
bytes `b[0] .. b[30]` as the field element

```
b[0] + b[1]·256 + … + b[30]·256^30
```

`b[0]` is the least significant byte. 31 bytes fit in one field element, so
the packing is one-to-one. The declaration code is packed the same way
([`declaration-code.md`](declaration-code.md)).

## Test vectors

[`vectors/scope.json`](vectors/scope.json): the accepted scope strings with
their packed values; strings that are not accepted, with the reason;
usernames valid and invalid for the Threads format.
