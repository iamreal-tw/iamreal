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
	Roster  verifier.Roster      // whose tables of scopes and platforms: production or test
	Store   store.Store          // the roster and the challenges
	CRLDir  string               // the CRL mirror: CRL files and index.jsonl
	Proofs  roster.ProofVerifier // verifies each submitted record; *verifier.Verifier
	Now     func() time.Time     // the clock
	Random  io.Reader            // the random bytes of challenges; crypto/rand
	Log     *slog.Logger         // the request log (see log.go)
	Version string               // the program's version, written in the log
	// RestrictLateSwitches is an operating policy on the fourth and fifth
	// switch of a slot (switch_restricted, docs/api/card-proof.md). false,
	// the default: no such policy, every record the roster rules accept is
	// accepted. true: every record that uses the fourth or fifth switch of
	// a slot is refused.
	RestrictLateSwitches bool
}

// Server answers the card proof API (docs/api/card-proof.md).
//
// The state of the roster lives in memory, computed by roster.Rules from
// every record. The views for the pages live in the store (store.View),
// written with each record. Writes are one at a time: mu is held from the checks that
// depend on the roster until the record is written and applied, so records
// are appended in the order they pass, each after the one before.
type Server struct {
	cfg Config

	mu    sync.RWMutex
	rules *roster.Rules // the rules applied to every record so far
	count uint64        // the number of records
	head  string        // the record hash of the last record
	crls  *crlIndex     // the mirror's index, read again for each card proof

	// viewsFrom is the seq of the first record whose views New wrote
	// (0: none; the views were already up to date). main logs it.
	viewsFrom uint64
	pending   []*store.View // views New computed and has not written yet
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
//
// The views (store.View) are brought up to date on the way: for every
// record after the store's ViewSeq, New writes what the record changes, as
// the rules it is applying say, in batches of one transaction each. After
// an upgrade that adds the views, or after ResetViews, this builds them
// from every record.
func New(cfg Config) (*Server, error) {
	s := &Server{cfg: cfg, head: verifier.GenesisPrev, crls: newCRLIndex(cfg.CRLDir)}
	if err := s.crls.reload(); err != nil {
		return nil, fmt.Errorf("CRL mirror: %w", err)
	}
	s.rules = roster.NewRules(cfg.Roster, alreadyVerified{}, s.crls)

	count, head, err := cfg.Store.Head()
	if err != nil {
		return nil, err
	}
	viewSeq, err := cfg.Store.ViewSeq()
	if err != nil {
		return nil, err
	}
	if viewSeq > count {
		return nil, fmt.Errorf("the views are at record %d, but the store has %d records", viewSeq, count)
	}
	const batch = 1000
	for first := uint64(1); first <= count; first += batch {
		records, err := cfg.Store.Records(first, first+batch-1)
		if err != nil {
			return nil, err
		}
		for _, r := range records {
			if err := s.load(r, r.Seq > viewSeq); err != nil {
				return nil, err
			}
		}
		if err := s.writePendingViews(); err != nil {
			return nil, err
		}
	}
	if s.count != count || s.head != head {
		return nil, fmt.Errorf("the store has %d records with head %s, but reading them gave %d with head %s", count, head, s.count, s.head)
	}
	return s, nil
}

// load applies one stored record at startup and, if withView, computes
// what it changes in the views (written by writePendingViews).
func (s *Server) load(r *verifier.Record, withView bool) error {
	if _, broken := roster.ReadLine(r.Line(), s.cfg.Roster, int(s.count+1), s.head); broken != nil {
		return fmt.Errorf("record %d: the roster is broken there: %v", s.count+1, broken)
	}
	var before roster.CardState
	if withView {
		before = s.rules.Card(r.ScopeString, r.ScopedID)
	}
	res, err := s.rules.Apply(r)
	if err != nil {
		return fmt.Errorf("record %d: %w", r.Seq, err)
	}
	if !res.Valid {
		return fmt.Errorf("record %d is invalid: %s %s", r.Seq, res.Reason, res.Detail)
	}
	if withView {
		v, err := store.NewView(r, res, before, s.rules.Card(r.ScopeString, r.ScopedID))
		if err != nil {
			return err
		}
		s.pending = append(s.pending, v)
		if s.viewsFrom == 0 {
			s.viewsFrom = r.Seq
		}
	}
	s.count, s.head = r.Seq, r.Hash()
	return nil
}

// writePendingViews writes the views load computed, in one transaction.
func (s *Server) writePendingViews() error {
	if len(s.pending) == 0 {
		return nil
	}
	if err := s.cfg.Store.AddViews(s.pending); err != nil {
		return fmt.Errorf("views of records %d to %d: %w", s.pending[0].Seq, s.pending[len(s.pending)-1].Seq, err)
	}
	s.pending = nil
	return nil
}

// deleteExpiredChallenges deletes the challenges that can no longer be
// used. main runs it every minute.
func (s *Server) deleteExpiredChallenges() (int64, error) {
	return s.cfg.Store.DeleteChallengesIssuedBefore(s.cfg.Now().Add(-challengeLifetime))
}
