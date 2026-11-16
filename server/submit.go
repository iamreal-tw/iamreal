package main

import (
	"errors"
	"net/http"
	"os"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// recordKeys are the fields of a submitted record: every field of a record
// except seq and prev, which the server fills in (docs/api/card-proof.md).
var recordKeys = []string{"scope_string", "scoped_id", "action", "username", "challenge", "issuer", "smt_root", "circuit", "proof"}

// accepted is the response of a card proof that was appended. AccountCards
// is the number of cards whose current account in the record's scope is the
// record's username once the record is applied, from the rules' state
// (roster.Rules.AccountCards); the device uses it only to choose which link
// to suggest (docs/api/card-proof.md).
type accepted struct {
	Seq          uint64 `json:"seq"`
	RecordHash   string `json:"record_hash"`
	Kind         string `json:"kind"`
	AccountCards int    `json:"account_cards"`
}

// POST /api/v1/records: one card proof. The checks run in the order of
// docs/api/card-proof.md, and the first that fails gives the error:
//
//  1. every field's format;
//  2. the challenge: issued by this server less than 10 minutes ago, not
//     accepted before, submitted at most 5 times (this submission counts);
//  3. the record verifies;
//  4. smt_root is the root of one of the two newest CRLs of the issuer in
//     the mirror, and the newest is at most 3 days old;
//  5. the roster rules, which say whether the record would be valid.
//
// If all pass, the record is appended and its challenge marked as accepted
// in one transaction, and the rules are applied to it.
func (s *Server) postRecord(r *http.Request) reply {
	now := s.cfg.Now()

	// 1. Every field's format.
	f, err := readObject(r.Body, recordKeys...)
	if err != nil {
		return fail(http.StatusBadRequest, errMalformed)
	}
	rec := &verifier.Record{
		ScopeString: f["scope_string"], ScopedID: f["scoped_id"], Action: f["action"], Username: f["username"],
		Challenge: f["challenge"], Issuer: f["issuer"], SMTRoot: f["smt_root"], Circuit: f["circuit"], Proof: f["proof"],
	}
	scope, inRoster := verifier.LookupScope(s.cfg.Roster, rec.ScopeString)
	if !inRoster {
		return fail(http.StatusBadRequest, errScope)
	}
	s.mu.RLock()
	next := s.count + 1
	s.mu.RUnlock()
	if scope.LastSeq != 0 && next > scope.LastSeq {
		return fail(http.StatusBadRequest, errScope) // the scope is retired
	}
	// seq and prev are not known yet; CheckValues needs some value for them.
	withSeq := *rec
	withSeq.Seq, withSeq.Prev = next, verifier.GenesisPrev
	if err := withSeq.CheckValues(s.cfg.Roster); err != nil {
		return fail(http.StatusBadRequest, errMalformed)
	}

	// 2. The challenge.
	c, found, err := s.cfg.Store.Submit(rec.Challenge)
	switch {
	case err != nil:
		return s.internal(r, "store", err)
	case !found || now.Sub(c.Issued) >= challengeLifetime:
		return fail(http.StatusBadRequest, errChallengeUnknown)
	case c.Accepted:
		return fail(http.StatusBadRequest, errChallengeUsed)
	case c.Submissions > maxSubmissions:
		return fail(http.StatusBadRequest, errChallengeAttempts)
	}

	// 3. The record verifies. bb runs as a child process, outside the lock,
	// so a slow proof does not hold up the others.
	if err := s.cfg.Proofs.VerifyRecord(rec); err != nil {
		var rej *verifier.Rejection
		if errors.As(err, &rej) {
			return fail(http.StatusBadRequest, errProof)
		}
		return s.internal(r, "verifier", err)
	}

	// From here on the answer depends on the roster: one record at a time.
	s.mu.Lock()
	defer s.mu.Unlock()

	// 4. The server's rule on smt_root.
	if err := s.crls.reload(); err != nil {
		return s.internal(r, "CRL mirror", err)
	}
	switch outcome, err := s.crls.checkRoot(rec.Issuer, rec.SMTRoot, taiwanDate(now)); {
	case err != nil:
		return s.internal(r, "CRL mirror", err)
	case outcome == rootStale:
		return fail(http.StatusServiceUnavailable, errCRLStale)
	case outcome == rootNotNewer:
		return fail(http.StatusBadRequest, errRoot)
	}

	// 5. The roster rules, on the record as it would be written.
	rec.Seq, rec.Prev = s.count+1, s.head
	if _, broken := roster.ReadLine(rec.Line(), s.cfg.Roster, int(rec.Seq), s.head); broken != nil {
		return s.internal(r, "line", broken) // the format was checked in step 1
	}
	res, err := s.rules.Check(rec)
	if err != nil {
		return s.internal(r, "rules", err)
	}
	if !res.Valid {
		return fail(http.StatusBadRequest, ruleError(res.Reason))
	}

	// Append and mark the challenge as accepted, in one transaction.
	switch err := s.cfg.Store.Append(rec); {
	case errors.Is(err, store.ErrChallengeNotOpen):
		return fail(http.StatusBadRequest, errChallengeUsed)
	case err != nil:
		return s.internal(r, "store", err)
	}
	applied, err := s.rules.Apply(rec)
	if err != nil || applied != res {
		// Check and Apply run the same code on the same state, under the
		// same lock; they cannot differ. If they did, the state in memory
		// would no longer match the store, so the program stops; on the
		// next start, New recomputes the state from the store.
		s.cfg.Log.Error("stopping: the rules applied the record differently from how they checked it", "seq", rec.Seq)
		os.Exit(1)
	}
	s.count, s.head = rec.Seq, rec.Hash()
	return ok(http.StatusCreated, accepted{Seq: rec.Seq, RecordHash: s.head, Kind: res.Kind, AccountCards: s.rules.AccountCards(rec.ScopeString, rec.Username)})
}

// ruleError is the API error for a record the roster rules find invalid.
func ruleError(reason string) string {
	switch reason {
	case roster.CodeChallengeReused:
		// The challenge is in an earlier record, so a card proof was
		// accepted for it. Step 2 normally finds this first; two
		// submissions of the same challenge at once reach this point.
		return errChallengeUsed
	case roster.CodeProof:
		return errProof
	default:
		// root, date_order, not_current, switch_limit, daily_limit: the
		// same names.
		return reason
	}
}
