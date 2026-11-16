// Package store keeps the server's data: the roster's records and the
// challenges issued and not yet expired. Everything the server reads or
// writes goes through the Store interface; nothing else in the server writes
// SQL. Moving the proofs to object storage or replacing the database later
// changes only this package.
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

	// Append adds r as the next record and marks its challenge as accepted,
	// in one transaction: both happen or neither does. r.Seq must be the
	// number of records plus one and r.Prev the head (ErrNotNext
	// otherwise), and the challenge must be issued and not yet accepted
	// (ErrChallengeNotOpen otherwise).
	Append(r *verifier.Record) error

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
