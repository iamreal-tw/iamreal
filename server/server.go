package main

import (
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// Config is everything the server needs. main fills it in; tests replace
// the clock, the random source and the proof verifier.
type Config struct {
	Roster  verifier.Roster      // whose accepted scopes: production or test
	Store   store.Store          // the roster and the challenges
	CRLDir  string               // the CRL mirror: CRL files and index.jsonl
	Proofs  roster.ProofVerifier // verifies each submitted record; *verifier.Verifier
	Now     func() time.Time     // the clock
	Random  io.Reader            // the random bytes of challenges; crypto/rand
	Log     *slog.Logger         // the request log (see log.go)
	Version string               // the program's version, written in the log
}

// Server answers the card proof API (docs/api/card-proof.md).
//
// The state of the roster lives in memory, computed by roster.Rules from
// every record. Writes are one at a time: mu is held from the checks that
// depend on the roster until the record is written and applied, so records
// are appended in the order they pass, each after the one before.
type Server struct {
	cfg Config

	mu    sync.RWMutex
	rules *roster.Rules // the rules applied to every record so far
	count uint64        // the number of records
	head  string        // the record hash of the last record
	crls  *crlIndex     // the mirror's index, read again for each card proof
}

// alreadyVerified is the proof verifier of the server's own copy of the
// rules: the server verifies each proof before it writes the record
// (submit.go), so it does not verify it again when applying the rules, nor
// when it starts. The daily snapshot re-verifies every proof
// (snapshot.go).
type alreadyVerified struct{}

func (alreadyVerified) VerifyRecord(*verifier.Record) error { return nil }

// New starts a server on the records in cfg.Store. It reads every record
// in order and computes the state with roster.Rules, checking each line as
// a re-verifier would (roster.ReadLine) and each root against the CRL
// mirror. Proofs are not verified again. If any record is malformed,
// breaks the chain or is invalid, New returns an error naming it, and the
// server does not start.
func New(cfg Config) (*Server, error) {
	s := &Server{cfg: cfg, head: verifier.GenesisPrev, crls: newCRLIndex(cfg.CRLDir)}
	if err := s.crls.reload(); err != nil {
		return nil, fmt.Errorf("CRL mirror: %w", err)
	}
	s.rules = roster.NewRules(alreadyVerified{}, s.crls)

	count, head, err := cfg.Store.Head()
	if err != nil {
		return nil, err
	}
	const batch = 1000
	for first := uint64(1); first <= count; first += batch {
		records, err := cfg.Store.Records(first, first+batch-1)
		if err != nil {
			return nil, err
		}
		for _, r := range records {
			if err := s.load(r); err != nil {
				return nil, err
			}
		}
	}
	if s.count != count || s.head != head {
		return nil, fmt.Errorf("the store has %d records with head %s, but reading them gave %d with head %s", count, head, s.count, s.head)
	}
	return s, nil
}

// load applies one stored record at startup.
func (s *Server) load(r *verifier.Record) error {
	if _, broken := roster.ReadLine(r.Line(), s.cfg.Roster, int(s.count+1), s.head); broken != nil {
		return fmt.Errorf("record %d: the roster is broken there: %v", s.count+1, broken)
	}
	res, err := s.rules.Apply(r)
	if err != nil {
		return fmt.Errorf("record %d: %w", r.Seq, err)
	}
	if !res.Valid {
		return fmt.Errorf("record %d is invalid: %s %s", r.Seq, res.Reason, res.Detail)
	}
	s.count, s.head = r.Seq, r.Hash()
	return nil
}

// deleteExpiredChallenges deletes the challenges that can no longer be
// used. main runs it every minute.
func (s *Server) deleteExpiredChallenges() (int64, error) {
	return s.cfg.Store.DeleteChallengesIssuedBefore(s.cfg.Now().Add(-challengeLifetime))
}
