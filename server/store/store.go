// Package store keeps the server's data: the roster's records, the
// challenges issued and not yet expired, and the views derived from the
// records for the pages visitors read (view.go). Everything the server
// reads or writes goes through the Store interface; nothing else in the
// server writes SQL. Moving the proofs to object storage or replacing the
// database later changes only this package.
package store

import (
	"errors"
	"time"

	"github.com/iamreal-tw/iamreal/verifier"
)

// Store is the server's data.
//
// The roster is append-only: records are added one at a time, in seq order,
// each with prev equal to the record hash of the one before it, and never
// changed or removed (ADR-0005).
type Store interface {
	// Head returns the number of records and the head: the record hash of
	// the last record, or 64 zeros for an empty roster.
	Head() (count uint64, head string, err error)

	// Records returns the records with seq from first to last, both
	// included, in seq order. It returns fewer if the roster ends earlier.
	Records(first, last uint64) ([]*verifier.Record, error)

	// Append adds r as the next record, marks its challenge as accepted
	// and, if v is not nil, writes what r changes in the views (v, from
	// NewView), all in one transaction: all happen or none does. r.Seq
	// must be the number of records plus one and r.Prev the head
	// (ErrNotNext otherwise), and the challenge must be issued and not yet
	// accepted (ErrChallengeNotOpen otherwise). If v is not nil, it must be
	// for r (ErrViewMismatch otherwise) and the views must reflect every
	// earlier record (ErrViewsBehind otherwise).
	//
	// The server always passes v. A nil v appends the record alone: the
	// views then stay at the record before (ViewSeq) until AddViews brings
	// them up; tests use it to write records past the server.
	Append(r *verifier.Record, v *View) error

	// ViewSeq returns the seq of the last record the views reflect: they
	// are what the records 1 to ViewSeq make, and nothing else. 0 means
	// the views are empty.
	ViewSeq() (uint64, error)

	// AddViews writes the views of stored records, in order, in one
	// transaction. The first must be for the record after ViewSeq and each
	// for the record after the one before (ErrViewsBehind otherwise); each
	// must be for the stored record of its seq (ErrViewMismatch otherwise).
	// On an error nothing is written.
	AddViews(views []*View) error

	// ResetViews empties the views, in one transaction: ViewSeq becomes 0.
	// The records are not touched.
	ResetViews() error

	// Cards returns the cards of scope scopeString whose scoped ID starts
	// with shortID (spec/scoped-id.md, "Short ID"): none, one or more,
	// sorted by scoped ID (byte order). Only cards with a valid record are
	// listed. shortID is taken as it is: the caller maps the spelling of a
	// URL to the 10 characters of the alphabet first.
	Cards(scopeString, shortID string) ([]CardSummary, error)

	// History returns the valid records of the card (scopeString,
	// scopedID), newest first: by date, latest first, and records of the
	// same date by seq, latest first. None if the card has no valid
	// record.
	History(scopeString, scopedID string) ([]HistoryRecord, error)

	// AccountCards returns the cards of scope scopeString whose current
	// account on platform is username, sorted by the date from which each
	// gives its place to it (Since), earliest first, and records of the
	// same date by seq. The same username on another platform is another
	// account.
	AccountCards(scopeString, platform, username string) ([]AccountCard, error)

	// Recent returns at most n slots of scope scopeString on platform that
	// have an account now, latest first by the seq of the record that
	// started them giving their place to it (RecentSlot.SinceSeq). before
	// = 0 starts from the latest; otherwise only slots with SinceSeq below
	// before are returned, so passing the SinceSeq of the last slot
	// returned gives the next ones.
	Recent(scopeString, platform string, before uint64, n int) ([]RecentSlot, error)

	// Counts returns, for scope scopeString and platform: declared, the
	// number of cards whose slot on the platform has an account now; and
	// recent, how many of them have a last_card_proof no earlier than
	// RecentDays days before today (today and day 90 included). today is
	// a date in Taiwan, given by the caller.
	Counts(scopeString, platform string, today verifier.Date) (declared, recent int, err error)

	// AddChallenge stores a challenge just issued, with the time it was
	// issued.
	AddChallenge(challenge string, issued time.Time) error

	// Submit counts one submission of a card proof for challenge and returns
	// the challenge as it is after counting. found is false if the challenge
	// is not stored (never issued, or deleted after it expired); then
	// nothing is counted. A challenge already accepted is returned without
	// counting.
	Submit(challenge string) (c Challenge, found bool, err error)

	// DeleteChallengesIssuedBefore deletes every challenge issued before t
	// and returns how many it deleted.
	DeleteChallengesIssuedBefore(t time.Time) (int64, error)

	Close() error
}

// Challenge is a stored challenge.
type Challenge struct {
	Challenge   string
	Issued      time.Time
	Submissions int  // card proofs submitted for it, counting the current one
	Accepted    bool // a card proof was accepted for it
}

var (
	// ErrNotNext is returned by Append for a record whose seq or prev does
	// not continue the roster.
	ErrNotNext = errors.New("store: the record does not continue the roster")
	// ErrChallengeNotOpen is returned by Append when the record's challenge
	// is not stored or was already accepted.
	ErrChallengeNotOpen = errors.New("store: the challenge is not stored or was already accepted")
)
