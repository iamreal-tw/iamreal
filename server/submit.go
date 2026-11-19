package main

import (
	"errors"
	"net/http"
	"os"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// recordKeys are the string fields of a submitted record: every field of a
// record except seq, which the server fills in, and accounts, which
// is a list (docs/api/card-proof.md).
var recordKeys = []string{"scope_string", "scoped_id", "challenge", "issuer", "smt_root", "circuit", "proof"}

// accepted is the response of a card proof that was appended.
type accepted struct {
	Seq        uint64         `json:"seq"`
	RecordHash string         `json:"record_hash"`
	Kinds      []acceptedKind `json:"kinds"`
}

// acceptedKind is what the record did on one platform: its kind and
// account, from the rules (roster.RecordResult), and AccountCards, the
// number of cards whose current account on that platform is that username
// in the record's scope once the record is applied, from the rules' state
// (roster.Rules.AccountCards). The device uses AccountCards only to say
// whether other cards declare the same account (docs/api/card-proof.md).
type acceptedKind struct {
	Platform     string `json:"platform"`
	Kind         string `json:"kind"`
	Username     string `json:"username"`
	AccountCards int    `json:"account_cards"`
}

// POST /api/v1/records: one card proof, the card's whole list of accounts.
// The checks run in the order of docs/api/card-proof.md, and the first that
// fails gives the error:
//
//  1. every field's format: scope, then platform, then malformed;
//  2. the challenge: issued by this server less than 10 minutes ago, not
//     accepted before, submitted at most 5 times (this submission counts);
//  3. the record verifies;
//  4. smt_root is the root of one of the two newest CRLs of the issuer in
//     the mirror, and the newest is at most 3 days old;
//  5. the roster rules, which say whether the record would be valid;
//  6. the server's own policy on the fourth and fifth switch of a slot,
//     if it is set (switch_restricted; none by default).
//
// If all pass, the record is appended, its challenge marked as accepted and
// the views updated (store.View) in one transaction, and the rules are
// applied to it.
func (s *Server) postRecord(r *http.Request) reply {
	now := s.cfg.Now()

	// 1. Every field's format. A body that is not one object with exactly
	// the keys of a submission, each once, the string fields strings, is
	// malformed before anything else is read from it.
	f, list, err := readObjectWithList(r.Body, "accounts", recordKeys...)
	if err != nil {
		return fail(http.StatusBadRequest, errMalformed)
	}
	scope, inRoster := verifier.LookupScope(s.cfg.Roster, f["scope_string"])
	if !inRoster {
		return fail(http.StatusBadRequest, errScope)
	}
	s.mu.RLock()
	next := s.count + 1
	s.mu.RUnlock()
	if scope.LastSeq != 0 && next > scope.LastSeq {
		return fail(http.StatusBadRequest, errScope) // the scope is retired
	}
	// The list is taken as it came: not sorted, not merged with the card's
	// current list, nothing filled in. Every entry with the two keys as
	// strings and a platform outside the table is `platform`; anything else
	// wrong with the list is `malformed`, below.
	accounts, shaped := readAccounts(list)
	if !shaped {
		return fail(http.StatusBadRequest, errMalformed)
	}
	for _, a := range accounts {
		if _, ok := verifier.LookupPlatform(s.cfg.Roster, a.Platform); !ok {
			return fail(http.StatusBadRequest, errPlatform)
		}
	}
	rec := &verifier.Record{
		ScopeString: f["scope_string"], ScopedID: f["scoped_id"], Accounts: accounts,
		Challenge: f["challenge"], Issuer: f["issuer"], SMTRoot: f["smt_root"], Circuit: f["circuit"], Proof: f["proof"],
	}
	// seq is not known yet; CheckValues needs some value for it.
	withSeq := *rec
	withSeq.Seq = next
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
	rec.Seq = s.count + 1
	if _, broken := roster.ReadLine(rec.Line(), s.cfg.Roster, int(rec.Seq)); broken != nil {
		return s.internal(r, "line", broken) // the format was checked in step 1
	}
	res, after, err := s.rules.CheckWithCard(rec)
	if err != nil {
		return s.internal(r, "rules", err)
	}
	if !res.Valid {
		return fail(http.StatusBadRequest, ruleError(res.Reason))
	}
	before := s.rules.Card(rec.ScopeString, rec.ScopedID)

	// 6. The server's policy, if it is set: a record the rules accept,
	// with a switch that would be the fourth or fifth of its slot. Never a
	// record without a switch, nor one whose switches are all among a
	// slot's first three.
	if s.cfg.RestrictLateSwitches && usesRestrictedSwitch(before, res) {
		return fail(http.StatusForbidden, errSwitchRestricted)
	}

	// Append, mark the challenge as accepted and update the views, in one
	// transaction.
	view, err := store.NewView(rec, res, before, after)
	if err != nil {
		return s.internal(r, "views", err)
	}
	switch err := s.cfg.Store.Append(rec, view); {
	case errors.Is(err, store.ErrChallengeNotOpen):
		return fail(http.StatusBadRequest, errChallengeUsed)
	case err != nil:
		return s.internal(r, "store", err)
	}
	applied, err := s.rules.Apply(rec)
	if err != nil || !applied.Equal(res) {
		// Check and Apply run the same code on the same state, under the
		// same lock; they cannot differ. If they did, the state in memory
		// would no longer match the store, so the program stops; on the
		// next start, New recomputes the state from the store.
		s.cfg.Log.Error("stopping: the rules applied the record differently from how they checked it", "seq", rec.Seq)
		os.Exit(1)
	}
	hash := rec.Hash()
	s.count, s.fingerprint = rec.Seq, roster.NextFingerprint(s.fingerprint, hash)
	out := accepted{Seq: rec.Seq, RecordHash: hash, Kinds: []acceptedKind{}}
	for _, k := range res.Kinds {
		out.Kinds = append(out.Kinds, acceptedKind{
			Platform: k.Platform, Kind: k.Kind, Username: k.Username,
			AccountCards: s.rules.AccountCards(rec.ScopeString, k.Platform, k.Username),
		})
	}
	return ok(http.StatusCreated, out)
}

// restrictedFrom is the first switch of a slot that the server's policy
// refuses when it is set: the fourth (Config.RestrictLateSwitches).
const restrictedFrom = 4

// usesRestrictedSwitch reports whether a record with result res, applied to
// a card whose state before it is card, has a switch that becomes the
// fourth or later switch of its slot.
func usesRestrictedSwitch(card roster.CardState, res roster.RecordResult) bool {
	for _, k := range res.Kinds {
		if k.Kind == roster.KindSwitch && card.Slots[k.Platform].SwitchCount+1 >= restrictedFrom {
			return true
		}
	}
	return false
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
		// root, date_order, empty, switch_limit, daily_limit: the same
		// names. switch_limit does not say which platform is blocked
		// (docs/api/card-proof.md).
		return reason
	}
}
