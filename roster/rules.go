package roster

import (
	"errors"
	"fmt"
	"sort"

	"github.com/iamreal-tw/iamreal/verifier"
)

// Reason codes of an invalid record (spec/roster-rules.md, "Per record").
const (
	CodeProof           = "proof"
	CodeChallengeReused = "challenge_reused"
	CodeRoot            = "root"
	CodeDateOrder       = "date_order"
	CodeNotCurrent      = "not_current"
	CodeSwitchLimit     = "switch_limit"
)

// Kinds of a valid record (spec/roster-rules.md, "Event rules").
const (
	KindFirst    = "first"
	KindRefresh  = "refresh"
	KindSwitch   = "switch"
	KindWithdraw = "withdraw"
)

// The bounds of the rules, in days.
const (
	// A record's date is at most RootAfter days after, and at most
	// RootBefore days before, the date of the CRL behind its root
	// (spec/revocation-tree.md, "Which roots a record may use").
	RootBefore = 1
	RootAfter  = 3
	// A record's date is no earlier than DateOrderDays before the latest
	// date among the earlier valid records (check 4).
	DateOrderDays = 4
	// At most MaxSwitches switches in any SwitchWindowDays days.
	SwitchWindowDays = 365
	MaxSwitches      = 2
)

// ProofVerifier is check 1: whether a record verifies (spec/record.md,
// "Verifying a record"). *verifier.Verifier is one.
//
// VerifyRecord returns nil if the record verifies and a *verifier.Rejection
// if it does not. Any other error means the check could not be made; the
// rules then stop instead of giving the record a code.
type ProofVerifier interface {
	VerifyRecord(r *verifier.Record) error
}

// CRLArchive answers check 3 from the archive of MOICA's CRLs
// (spec/revocation-tree.md). The archive itself is outside this package.
type CRLArchive interface {
	// CRLDates returns the CRL date (thisUpdate as a date in Taiwan) of
	// every usable CRL signed by the key of issuer whose revocation tree has
	// the root smtRoot (64 lowercase hex digits, as in the record). It
	// returns no dates if there is none. An error means the archive could not
	// be read.
	CRLDates(issuer, smtRoot string) ([]verifier.Date, error)
}

// RecordResult is the outcome of one record: valid with its kind, or invalid
// with its reason code.
type RecordResult struct {
	Seq    uint64
	Valid  bool
	Kind   string // if valid
	Reason string // if invalid
	Detail string // why, for people; not part of the result
}

// Card is one card in a scope: its account now (nil for none) and the date
// of its last card proof.
type Card struct {
	ScopedID      string
	Current       *string
	LastCardProof verifier.Date
}

// AccountCard is a card whose current account is the account.
type AccountCard struct {
	ScopedID      string
	LastCardProof verifier.Date
}

// Account is an account and the cards declared to it now.
type Account struct {
	Username string
	Cards    []AccountCard
}

// ScopeState is the state of one scope.
type ScopeState struct {
	ScopeString string
	Cards       []Card
	Accounts    []Account
}

// State is the output of the rules (spec/roster-rules.md, "Output"). Every
// list is sorted by the byte values of its key; Records is in seq order.
type State struct {
	Records []RecordResult
	Scopes  []ScopeState
}

type cardKey struct{ scope, scopedID string }

type cardState struct {
	current       *string
	lastDeclared  *string
	switchDates   []verifier.Date
	lastCardProof *verifier.Date
}

// Apply applies the rules to the records of a valid roster file, in order.
func Apply(records []*verifier.Record, proofs ProofVerifier, crls CRLArchive) (*State, error) {
	st := &State{}
	cards := map[cardKey]*cardState{}
	used := map[string]bool{} // challenges of earlier records, valid or invalid
	var latestValid *verifier.Date

	for _, r := range records {
		d, err := r.Date()
		if err != nil {
			return nil, fmt.Errorf("seq %d: %w", r.Seq, err)
		}
		res := RecordResult{Seq: r.Seq}
		invalid := func(code, detail string) { res.Reason, res.Detail = code, detail }

		key := cardKey{r.ScopeString, r.ScopedID}
		cs := cards[key]
		if cs == nil {
			cs = &cardState{}
		}

		// 1. The record verifies.
		if err := proofs.VerifyRecord(r); err != nil {
			var rej *verifier.Rejection
			if !errors.As(err, &rej) {
				return nil, fmt.Errorf("seq %d: %w", r.Seq, err)
			}
			invalid(CodeProof, rej.Reason)
		} else if used[r.Challenge] {
			// 2. Its challenge appears in no earlier record.
			invalid(CodeChallengeReused, "")
		} else if ok, err := rootRecognized(crls, r, d); err != nil {
			return nil, fmt.Errorf("seq %d: %w", r.Seq, err)
		} else if !ok {
			// 3. Its root is recognized for its issuer and date.
			invalid(CodeRoot, "")
		} else if latestValid != nil && d < latestValid.AddDays(-DateOrderDays) {
			// 4. Its date is no earlier than 4 days before the latest valid date.
			invalid(CodeDateOrder, fmt.Sprintf("latest earlier valid date %s", latestValid))
		} else {
			// 5. The event rules.
			kind, code := applyEvent(cs, r.Action, r.Username, d)
			if code != "" {
				invalid(code, "")
			} else {
				res.Valid, res.Kind = true, kind
				if cs.lastCardProof == nil || d > *cs.lastCardProof {
					cs.lastCardProof = &d
				}
				if latestValid == nil || d > *latestValid {
					latestValid = &d
				}
				cards[key] = cs
			}
		}
		used[r.Challenge] = true
		st.Records = append(st.Records, res)
	}
	st.Scopes = output(cards)
	return st, nil
}

func rootRecognized(crls CRLArchive, r *verifier.Record, d verifier.Date) (bool, error) {
	dates, err := crls.CRLDates(r.Issuer, r.SMTRoot)
	if err != nil {
		return false, fmt.Errorf("CRL archive: %w", err)
	}
	for _, crl := range dates {
		if crl.AddDays(-RootBefore) <= d && d <= crl.AddDays(RootAfter) {
			return true, nil
		}
	}
	return false, nil
}

// applyEvent applies one declare or withdraw to the state of its card and
// returns its kind, or the code that makes it invalid. An invalid event
// changes nothing.
func applyEvent(cs *cardState, action, u string, d verifier.Date) (kind, code string) {
	switch action {
	case verifier.Declare:
		switch {
		case cs.lastDeclared == nil:
			cs.current, cs.lastDeclared = &u, &u
			return KindFirst, ""
		case *cs.lastDeclared == u:
			cs.current = &u
			return KindRefresh, ""
		}
		recent := 0
		for _, s := range cs.switchDates {
			if s >= d.AddDays(-(SwitchWindowDays - 1)) {
				recent++
			}
		}
		if recent >= MaxSwitches {
			return "", CodeSwitchLimit
		}
		cs.current, cs.lastDeclared = &u, &u
		cs.switchDates = append(cs.switchDates, d)
		return KindSwitch, ""
	case verifier.Withdraw:
		if cs.current != nil && *cs.current == u {
			cs.current = nil
			return KindWithdraw, ""
		}
		return "", CodeNotCurrent
	}
	panic("action " + action) // ParseLine admits only the two actions
}

// output lists the state: scopes by scope string, cards by scoped_id,
// accounts by username, each sorted by byte value. Cards with no valid
// record, accounts with no card and scopes with no card are not listed.
func output(cards map[cardKey]*cardState) []ScopeState {
	byScope := map[string]*ScopeState{}
	accounts := map[string]map[string][]AccountCard{}
	for k, cs := range cards {
		if cs.lastCardProof == nil {
			continue
		}
		s := byScope[k.scope]
		if s == nil {
			s = &ScopeState{ScopeString: k.scope}
			byScope[k.scope] = s
			accounts[k.scope] = map[string][]AccountCard{}
		}
		var current *string
		if cs.current != nil {
			u := *cs.current
			current = &u
			accounts[k.scope][u] = append(accounts[k.scope][u], AccountCard{k.scopedID, *cs.lastCardProof})
		}
		s.Cards = append(s.Cards, Card{k.scopedID, current, *cs.lastCardProof})
	}
	var out []ScopeState
	for _, s := range byScope {
		sort.Slice(s.Cards, func(i, j int) bool { return s.Cards[i].ScopedID < s.Cards[j].ScopedID })
		for u, list := range accounts[s.ScopeString] {
			sort.Slice(list, func(i, j int) bool { return list[i].ScopedID < list[j].ScopedID })
			s.Accounts = append(s.Accounts, Account{u, list})
		}
		sort.Slice(s.Accounts, func(i, j int) bool { return s.Accounts[i].Username < s.Accounts[j].Username })
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ScopeString < out[j].ScopeString })
	return out
}

// Report is the result of re-verifying a roster file.
type Report struct {
	Broken  *Broken // nil if the file is valid
	Head    string  // the head of a valid file
	Records int     // the number of records of a valid file
	State   *State  // the rules applied to a valid file
}

// Check reads a roster file and, if it is valid, applies the rules to it.
func Check(data []byte, r verifier.Roster, proofs ProofVerifier, crls CRLArchive) (*Report, error) {
	records, head, broken := ReadFile(data, r)
	if broken != nil {
		return &Report{Broken: broken}, nil
	}
	st, err := Apply(records, proofs, crls)
	if err != nil {
		return nil, err
	}
	return &Report{Head: head, Records: len(records), State: st}, nil
}
