package roster

import (
	"errors"
	"fmt"
	"sort"

	"github.com/iamreal-tw/iamreal/verifier"
)

// RulesVersion is the version number of the rules this package implements
// (spec/roster-rules.md, "The version number"). The TypeScript
// implementation has the same constant (protocol/'s RULES_VERSION). When it
// goes up is written there: with every change to the rules, and when an
// implementation is corrected for a result or a state the rules do not give
// and states computed by it may be stored. Nothing stored is computed by
// this package, so correcting an error here alone does not change the
// number; a new version of the re-verification command starts the
// re-verification from the first record (ADR-0025).
const RulesVersion = 1

// Reason codes of an invalid record (spec/roster-rules.md, "Per record").
const (
	CodeProof           = "proof"
	CodeChallengeReused = "challenge_reused"
	CodeRoot            = "root"
	CodeDateOrder       = "date_order"
	CodeEmpty           = "empty"
	CodeSwitchLimit     = "switch_limit"
	CodeDailyLimit      = "daily_limit"
)

// Kinds of a valid record on one platform (spec/roster-rules.md, "Event
// rules").
const (
	KindFirst      = "first"
	KindRefresh    = "refresh"
	KindCorrection = "correction"
	KindSwitch     = "switch"
	KindWithdraw   = "withdraw"
)

// The bounds of the rules, in days.
const (
	// A record's date is at most RootAfter days after, and at most
	// RootBefore days before, the date of the CRL behind its root
	// (spec/revocation-tree.md, "Which roots a record may use").
	RootBefore = 1
	RootAfter  = 3
	// A record's date is no earlier than DateOrderDays before the latest
	// date among the earlier valid records, of any card (check 4).
	DateOrderDays = 4
	// At most MaxSwitches switches on each platform, for good ("Switches
	// and corrections"). A correction is not counted.
	MaxSwitches = 5
	// At most MaxPerDate valid records of a card have the same date
	// (check 6).
	MaxPerDate = 3
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

// PlatformKind is what a valid record did on one platform.
type PlatformKind struct {
	Platform string
	Kind     string
	// Username is the account: the one the list has for the platform, or
	// for KindWithdraw the one withdrawn. The rules' output is the
	// (platform, kind) pair; the server also reports the account.
	Username string
}

// RecordResult is the outcome of one record: valid with its kinds, or
// invalid with its reason code.
type RecordResult struct {
	Seq   uint64
	Valid bool
	// Kinds, if valid: one for every platform on which the record has a
	// kind, in ascending order of platform; at least one.
	Kinds  []PlatformKind
	Reason string // if invalid
	Detail string // why, for people; not part of the result
}

// Equal reports whether a and b are the same result, Detail included.
func (a RecordResult) Equal(b RecordResult) bool {
	if a.Seq != b.Seq || a.Valid != b.Valid || a.Reason != b.Reason || a.Detail != b.Detail || len(a.Kinds) != len(b.Kinds) {
		return false
	}
	for i := range a.Kinds {
		if a.Kinds[i] != b.Kinds[i] {
			return false
		}
	}
	return true
}

// Card is one card of the output: the date of its last card proof and its
// current list, in ascending order of platform. A card that withdrew
// everything has an empty list.
type Card struct {
	ScopedID      string
	LastCardProof verifier.Date
	Accounts      []verifier.Account
}

// AccountCard is a card whose current account on the platform is the
// account.
type AccountCard struct {
	ScopedID      string
	LastCardProof verifier.Date
}

// Account is an account, (platform, username), and the cards whose current
// account on that platform it is.
type Account struct {
	Platform string
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

type accountKey struct{ scope, platform, username string }

type slotState struct {
	current      *string
	lastDeclared *string
	switchCount  int
	// correctionDate is the date of the slot's last valid first or switch;
	// nil before the first.
	correctionDate *verifier.Date
}

// cardState holds exactly the items of the State table of
// spec/roster-rules.md: the card's own two, and one slot per platform.
type cardState struct {
	slots         map[string]*slotState // one per platform of the table
	lastCardProof *verifier.Date
	// proofsOnLastDate is the number of valid records dated lastCardProof.
	// A card's dates do not go back (check 4), so it is the only count check
	// 6 can ask for.
	proofsOnLastDate int
	// lastSeq is the seq of the card's last valid record, 0 before the
	// first. It is not an item of the State table: the card state file
	// writes it beside the state.
	lastSeq uint64
}

func (cs *cardState) clone() *cardState {
	c := &cardState{
		slots:            make(map[string]*slotState, len(cs.slots)),
		lastCardProof:    cs.lastCardProof,
		proofsOnLastDate: cs.proofsOnLastDate,
		lastSeq:          cs.lastSeq,
	}
	for p, s := range cs.slots {
		ns := *s
		c.slots[p] = &ns
	}
	return c
}

// onDate returns the number of valid records of the card dated d, for a d
// that check 4 accepts (not before lastCardProof): proofsOnLastDate if d is
// lastCardProof, 0 if it is later.
func (cs *cardState) onDate(d verifier.Date) int {
	if cs.lastCardProof != nil && *cs.lastCardProof == d {
		return cs.proofsOnLastDate
	}
	return 0
}

// Rules applies the rules to one record at a time, in seq order, and keeps
// the state they compute. Apply (a whole roster file) is a loop over it, and
// the server uses it for each record it appends, so both run the same code.
//
// Rules does not check the file as a whole (well-formed lines, seq);
// ReadFile and ReadLine do.
type Rules struct {
	roster      verifier.Roster
	platforms   []verifier.Platform // the roster's table, in ascending order of ID
	proofs      ProofVerifier
	crls        CRLArchive
	cards       map[cardKey]*cardState
	accounts    map[accountKey]int // the number of cards whose current account it is
	used        map[string]bool    // challenges of earlier records, valid or invalid
	latestValid *verifier.Date
	results     []RecordResult
}

// NewRules returns the rules before any record, for a roster whose platform
// table is that of r.
func NewRules(r verifier.Roster, proofs ProofVerifier, crls CRLArchive) *Rules {
	return &Rules{
		roster: r, platforms: verifier.Platforms(r), proofs: proofs, crls: crls,
		cards: map[cardKey]*cardState{}, accounts: map[accountKey]int{}, used: map[string]bool{},
	}
}

func (x *Rules) newCard() *cardState {
	cs := &cardState{slots: map[string]*slotState{}}
	for _, p := range x.platforms {
		cs.slots[p.ID] = &slotState{}
	}
	return cs
}

// Check returns the result r would have as the next record, without
// applying it: nothing changes.
func (x *Rules) Check(r *verifier.Record) (RecordResult, error) {
	res, _, err := x.check(r)
	return res, err
}

// CheckWithCard returns what Check returns and, for a valid record, the
// state its card would have after it: what Card would return once r is
// applied. For an invalid record the state is the zero CardState. Nothing
// changes.
func (x *Rules) CheckWithCard(r *verifier.Record) (RecordResult, CardState, error) {
	res, next, err := x.check(r)
	if err != nil || !res.Valid {
		return res, CardState{}, err
	}
	return res, cardStateOf(next), nil
}

// Apply applies r as the next record and returns its result. A valid record
// changes the state of its card, on every platform at once; an invalid one
// changes nothing but marks its challenge as used (check 2). On an error
// nothing changes.
func (x *Rules) Apply(r *verifier.Record) (RecordResult, error) {
	res, next, err := x.check(r)
	if err != nil {
		return res, err
	}
	if res.Valid {
		key := cardKey{r.ScopeString, r.ScopedID}
		x.countAccounts(key, x.cards[key], -1)
		x.cards[key] = next
		x.countAccounts(key, next, +1)
		d := *next.lastCardProof
		if x.latestValid == nil || d > *x.latestValid {
			x.latestValid = &d
		}
	}
	x.used[r.Challenge] = true
	x.results = append(x.results, res)
	return res, nil
}

// countAccounts adds n to the count of every account that is current on a
// slot of cs.
func (x *Rules) countAccounts(key cardKey, cs *cardState, n int) {
	if cs == nil {
		return
	}
	for p, s := range cs.slots {
		if s.current == nil {
			continue
		}
		k := accountKey{key.scope, p, *s.current}
		x.accounts[k] += n
		if x.accounts[k] == 0 {
			delete(x.accounts, k)
		}
	}
}

// check runs the checks of "Per record" on r, in order; the first that
// fails gives the reason code. For a valid record it also returns the state
// its card has after it. It changes nothing.
func (x *Rules) check(r *verifier.Record) (RecordResult, *cardState, error) {
	res := RecordResult{Seq: r.Seq}
	d, err := r.Date()
	if err != nil {
		return res, nil, fmt.Errorf("seq %d: %w", r.Seq, err)
	}
	// The rules only ever see lists of the table, at most one account per
	// platform: anything else is a malformed line (spec/record.md), which
	// ReadLine rejects before the rules run.
	if err := verifier.CheckAccounts(x.roster, r.Accounts); err != nil {
		return res, nil, fmt.Errorf("seq %d: %w", r.Seq, err)
	}
	invalid := func(code, detail string) (RecordResult, *cardState, error) {
		res.Reason, res.Detail = code, detail
		return res, nil, nil
	}

	// 1. The record verifies.
	if err := x.proofs.VerifyRecord(r); err != nil {
		var rej *verifier.Rejection
		if !errors.As(err, &rej) {
			return res, nil, fmt.Errorf("seq %d: %w", r.Seq, err)
		}
		return invalid(CodeProof, rej.Reason)
	}
	// 2. Its challenge appears in no earlier record.
	if x.used[r.Challenge] {
		return invalid(CodeChallengeReused, "")
	}
	// 3. Its root is recognized for its issuer and date.
	ok, err := rootRecognized(x.crls, r, d)
	if err != nil {
		return res, nil, fmt.Errorf("seq %d: %w", r.Seq, err)
	}
	if !ok {
		return invalid(CodeRoot, "")
	}
	// 4. Its date is no earlier than 4 days before the latest valid date,
	// and no earlier than its card's last card proof.
	if x.latestValid != nil && d < x.latestValid.AddDays(-DateOrderDays) {
		return invalid(CodeDateOrder, fmt.Sprintf("latest earlier valid date %s", x.latestValid))
	}
	cs := x.cards[cardKey{r.ScopeString, r.ScopedID}]
	if cs != nil && cs.lastCardProof != nil && d < *cs.lastCardProof {
		return invalid(CodeDateOrder, fmt.Sprintf("last card proof %s", cs.lastCardProof))
	}
	// 5. The event rules, on every platform of the table, on a copy of the
	// card's state. One blocked platform blocks the record.
	next := x.newCard()
	if cs != nil {
		next = cs.clone()
	}
	var kinds []PlatformKind
	for _, p := range x.platforms {
		u, listed := verifier.AccountOn(r.Accounts, p.ID)
		kind, account, blocked := applyEntry(next.slots[p.ID], listed, u, d)
		if blocked {
			return invalid(CodeSwitchLimit, "platform "+p.ID)
		}
		if kind != "" {
			kinds = append(kinds, PlatformKind{Platform: p.ID, Kind: kind, Username: account})
		}
	}
	if len(kinds) == 0 {
		return invalid(CodeEmpty, "")
	}
	// 6. Fewer than 3 earlier valid records of its card have its date. The
	// effects of the event rules (on the copy) are dropped.
	n := next.onDate(d)
	if n >= MaxPerDate {
		return invalid(CodeDailyLimit, fmt.Sprintf("%d valid records dated %s", n, d))
	}
	// Check 4 made d no earlier than last_card_proof.
	next.lastCardProof, next.proofsOnLastDate, next.lastSeq = &d, n+1, r.Seq
	res.Valid, res.Kinds = true, kinds
	return res, next, nil
}

// applyEntry applies a record's entry for one platform to the slot of its
// card on that platform (spec/roster-rules.md, "Event rules"): listed says
// whether the list has an account u there. The first row of the table that
// applies gives the kind: first, refresh, correction, switch, or blocked. It
// returns the kind and its account, no kind, or blocked. When blocked, the
// slot is left in some state; the caller drops the whole copy.
func applyEntry(s *slotState, listed bool, u string, d verifier.Date) (kind, account string, blocked bool) {
	if !listed {
		if s.current == nil {
			return "", "", false
		}
		old := *s.current
		s.current = nil
		return KindWithdraw, old, false
	}
	switch {
	case s.lastDeclared == nil:
		s.current, s.lastDeclared, s.correctionDate = &u, &u, &d
		return KindFirst, u, false
	case *s.lastDeclared == u:
		s.current = &u
		return KindRefresh, u, false
	case s.correctionDate != nil && *s.correctionDate == d:
		s.current, s.lastDeclared = &u, &u
		return KindCorrection, u, false
	case s.switchCount < MaxSwitches:
		s.current, s.lastDeclared, s.correctionDate = &u, &u, &d
		s.switchCount++
		return KindSwitch, u, false
	}
	return "", "", true
}

// Count returns the number of records applied.
func (x *Rules) Count() int { return len(x.results) }

// State returns the output of the rules for the records applied so far.
func (x *Rules) State() *State {
	return &State{Records: append([]RecordResult(nil), x.results...), Scopes: x.output()}
}

// Slot is the state of a card's slot on one platform (spec/roster-rules.md,
// "State"). A slot never used has every pointer nil and SwitchCount 0.
type Slot struct {
	Current      *string
	LastDeclared *string
	// SwitchCount is the number of valid switches, 0 to MaxSwitches. It
	// never decreases.
	SwitchCount int
	// CorrectionDate is the date of the slot's last valid first or switch:
	// a change of account dated that date is a correction.
	CorrectionDate *verifier.Date
}

// CardState is the state of one card (spec/roster-rules.md, "State"): the
// card's own items and one slot per platform of the table. A card with no
// valid record has LastCardProof nil, ProofsOnLastDate 0 and every slot
// never used.
type CardState struct {
	LastCardProof *verifier.Date
	// ProofsOnLastDate is the number of valid records dated LastCardProof
	// (0 if there is none).
	ProofsOnLastDate int
	// Slots has one entry for every platform of the roster's table, keyed
	// by platform ID.
	Slots map[string]Slot
}

// Card returns the state of the card scopedID in the scope scopeString. The
// values are copies.
func (x *Rules) Card(scopeString, scopedID string) CardState {
	cs := x.cards[cardKey{scopeString, scopedID}]
	if cs == nil {
		cs = x.newCard()
	}
	return cardStateOf(cs)
}

// cardStateOf copies cs into a CardState.
func cardStateOf(cs *cardState) CardState {
	out := CardState{Slots: map[string]Slot{}}
	for p, s := range cs.slots {
		slot := Slot{SwitchCount: s.switchCount}
		if s.correctionDate != nil {
			d := *s.correctionDate
			slot.CorrectionDate = &d
		}
		if s.current != nil {
			u := *s.current
			slot.Current = &u
		}
		if s.lastDeclared != nil {
			u := *s.lastDeclared
			slot.LastDeclared = &u
		}
		out.Slots[p] = slot
	}
	if cs.lastCardProof != nil {
		d := *cs.lastCardProof
		out.LastCardProof = &d
		out.ProofsOnLastDate = cs.proofsOnLastDate
	}
	return out
}

// CardRows returns every card with a valid record among the records
// applied, with its state and the seq of its last valid record, in the
// order of a card state file (spec/roster-rules.md, "The card state file"):
// the rows a re-verifier compares with the file. The values are copies.
func (x *Rules) CardRows() []CardRow {
	var rows []CardRow
	for k, cs := range x.cards {
		if cs.lastCardProof == nil {
			continue
		}
		rows = append(rows, CardRow{ScopeString: k.scope, ScopedID: k.scopedID, LastSeq: cs.lastSeq, State: cardStateOf(cs)})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].before(rows[j]) })
	return rows
}

// AccountCards returns the number of cards in the scope scopeString whose
// current account on platform is username: the cards the output lists
// under that account ("Output", accounts). The same username on another
// platform is another account.
func (x *Rules) AccountCards(scopeString, platform, username string) int {
	return x.accounts[accountKey{scopeString, platform, username}]
}

// Apply applies the rules to the records of a valid roster file of roster
// r, in order: Rules.Apply on each record.
func Apply(records []*verifier.Record, r verifier.Roster, proofs ProofVerifier, crls CRLArchive) (*State, error) {
	x := NewRules(r, proofs, crls)
	for _, rec := range records {
		if _, err := x.Apply(rec); err != nil {
			return nil, err
		}
	}
	return x.State(), nil
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

// output lists the state: scopes by scope string; cards by scoped_id, each
// with its current list in ascending order of platform; accounts by
// platform, then username, each with its cards by scoped_id. Every sort is
// by byte value. Cards with no valid record, accounts with no card and
// scopes with no card are not listed.
func (x *Rules) output() []ScopeState {
	byScope := map[string]*ScopeState{}
	type acct struct{ platform, username string }
	accounts := map[string]map[acct][]AccountCard{}
	for k, cs := range x.cards {
		if cs.lastCardProof == nil {
			continue
		}
		s := byScope[k.scope]
		if s == nil {
			s = &ScopeState{ScopeString: k.scope}
			byScope[k.scope] = s
			accounts[k.scope] = map[acct][]AccountCard{}
		}
		card := Card{ScopedID: k.scopedID, LastCardProof: *cs.lastCardProof, Accounts: []verifier.Account{}}
		for _, p := range x.platforms {
			if cur := cs.slots[p.ID].current; cur != nil {
				card.Accounts = append(card.Accounts, verifier.Account{Platform: p.ID, Username: *cur})
				a := acct{p.ID, *cur}
				accounts[k.scope][a] = append(accounts[k.scope][a], AccountCard{k.scopedID, *cs.lastCardProof})
			}
		}
		s.Cards = append(s.Cards, card)
	}
	var out []ScopeState
	for _, s := range byScope {
		sort.Slice(s.Cards, func(i, j int) bool { return s.Cards[i].ScopedID < s.Cards[j].ScopedID })
		for a, list := range accounts[s.ScopeString] {
			sort.Slice(list, func(i, j int) bool { return list[i].ScopedID < list[j].ScopedID })
			s.Accounts = append(s.Accounts, Account{a.platform, a.username, list})
		}
		sort.Slice(s.Accounts, func(i, j int) bool {
			a, b := s.Accounts[i], s.Accounts[j]
			if a.Platform != b.Platform {
				return a.Platform < b.Platform
			}
			return a.Username < b.Username
		})
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ScopeString < out[j].ScopeString })
	return out
}

// Report is the result of re-verifying a roster file.
type Report struct {
	Broken      *Broken // nil if the file is valid
	Fingerprint string  // the roster fingerprint of a valid file
	Records     int     // the number of records of a valid file
	State       *State  // the rules applied to a valid file
	// Cards is every card with a valid record in a valid file, as
	// Rules.CardRows returns them.
	Cards []CardRow
}

// Check reads a roster file of roster r and, if it is valid, applies the
// rules to it.
func Check(data []byte, r verifier.Roster, proofs ProofVerifier, crls CRLArchive) (*Report, error) {
	records, fingerprint, broken := ReadFile(data, r)
	if broken != nil {
		return &Report{Broken: broken}, nil
	}
	x := NewRules(r, proofs, crls)
	for _, rec := range records {
		if _, err := x.Apply(rec); err != nil {
			return nil, err
		}
	}
	return &Report{Fingerprint: fingerprint, Records: len(records), State: x.State(), Cards: x.CardRows()}, nil
}
