package store

import (
	"errors"
	"fmt"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// The views are tables derived from the records for the pages visitors
// read: the page of a card, the page of an account and the roster page.
// They hold what one valid record changed, as the roster rules computed it
// (roster.Rules); nothing here decides a kind. The records are what counts:
// the views can be cleared and rebuilt from them at any time (ResetViews,
// AddViews), and they reflect exactly the records 1 to ViewSeq.

// View is what one valid record changes in the views. NewView makes it from
// the rules' answer for the record; Append and AddViews write it.
type View struct {
	Seq         uint64
	ScopeString string
	ScopedID    string
	Date        verifier.Date // the record's date (from its challenge)
	// LastCardProof is the card's last_card_proof after the record.
	LastCardProof verifier.Date
	// Changes has one entry for every platform on which the record has a
	// kind, in ascending order of platform, as in the rules' result.
	Changes []SlotChange
}

// SlotChange is what a valid record did on one platform, and the slot as
// it is after it.
type SlotChange struct {
	Platform string
	Kind     string // the rules' kind: roster.KindFirst, ...
	// AfterWithdrawal is true if the slot had been declared before and its
	// current account was none just before this record: the record
	// declares an account again after a withdrawal.
	AfterWithdrawal bool
	// Before is the slot's last declared account just before the record
	// ("" for a first declaration). For a withdrawal it is the account
	// withdrawn; for a refresh it equals After.
	Before string
	// After is the slot's current account after the record, "" after a
	// withdrawal.
	After string
	// SwitchCount is the slot's switch_count after the record.
	SwitchCount int
	// Since is true if this record starts the slot giving its place to
	// After: a first declaration, a switch, a correction, or declaring
	// again after a withdrawal. A refresh of the current account does not.
	Since bool
}

// NewView returns what the valid record r changes in the views. res is the
// rules' result for r, before the state of r's card just before r, and
// after its state just after r (roster.Rules.Card, CheckWithCard).
func NewView(r *verifier.Record, res roster.RecordResult, before, after roster.CardState) (*View, error) {
	if !res.Valid || res.Seq != r.Seq {
		return nil, fmt.Errorf("store: no view for record %d: not a valid result of it", r.Seq)
	}
	d, err := r.Date()
	if err != nil {
		return nil, fmt.Errorf("store: record %d: %w", r.Seq, err)
	}
	if after.LastCardProof == nil {
		return nil, fmt.Errorf("store: record %d: the card has no last_card_proof after it", r.Seq)
	}
	v := &View{Seq: r.Seq, ScopeString: r.ScopeString, ScopedID: r.ScopedID, Date: d, LastCardProof: *after.LastCardProof}
	for _, k := range res.Kinds {
		b, okB := before.Slots[k.Platform]
		a, okA := after.Slots[k.Platform]
		if !okB || !okA {
			return nil, fmt.Errorf("store: record %d: no slot for platform %s", r.Seq, k.Platform)
		}
		c := SlotChange{
			Platform: k.Platform, Kind: k.Kind,
			AfterWithdrawal: b.Current == nil && b.LastDeclared != nil,
			Before:          deref(b.LastDeclared), After: deref(a.Current),
			SwitchCount: a.SwitchCount,
		}
		switch k.Kind {
		case roster.KindFirst, roster.KindSwitch, roster.KindCorrection:
			c.Since = true
		case roster.KindRefresh:
			c.Since = c.AfterWithdrawal
		}
		v.Changes = append(v.Changes, c)
	}
	return v, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// What one record did on one platform, as a page tells it
// (design/copy/proof-page.md, section 4). SlotChange.Event gives it.
const (
	EventFirst      = "first"      // 新宣告
	EventRefresh    = "refresh"    // 再次過卡: the same account, not withdrawn before
	EventSwitch     = "switch"     // 更換
	EventCorrection = "correction" // 更正
	EventWithdraw   = "withdraw"   // 收回
	// EventRedeclare is declaring again, after a withdrawal, the account
	// withdrawn (a refresh in the rules).
	EventRedeclare = "redeclare"
	// EventSwitchAfterWithdrawal is declaring another account after a
	// withdrawal, on a later date than the slot's last first or switch (a
	// switch in the rules).
	EventSwitchAfterWithdrawal = "switch_after_withdrawal"
	// EventCorrectionAfterWithdrawal is declaring another account after a
	// withdrawal, on the date of the slot's last first or switch (a
	// correction in the rules). proof-page.md does not list it apart.
	EventCorrectionAfterWithdrawal = "correction_after_withdrawal"
)

// Event returns what the change was, as a page tells it: the rules' kind,
// told apart by whether the slot had been withdrawn just before.
func (c SlotChange) Event() string {
	switch {
	case c.Kind == roster.KindRefresh && c.AfterWithdrawal:
		return EventRedeclare
	case c.Kind == roster.KindSwitch && c.AfterWithdrawal:
		return EventSwitchAfterWithdrawal
	case c.Kind == roster.KindCorrection && c.AfterWithdrawal:
		return EventCorrectionAfterWithdrawal
	}
	return c.Kind
}

// CardSummary is one card as the views have it.
type CardSummary struct {
	ScopedID string
	// FirstCardProof is the earliest date among the card's valid records:
	// the date of the last record of History. Dates can step back around
	// midnight, so it is not always the date of the first record in seq
	// order.
	FirstCardProof verifier.Date
	// LastCardProof is the card's last_card_proof: the latest date among
	// its valid records.
	LastCardProof verifier.Date
	// CardProofs is the number of the card's valid records.
	CardProofs int
	// Slots has one entry for every platform on which a valid record of
	// the card has had a kind, in ascending order of platform, whether or
	// not it has an account now. A platform not listed was never used: no
	// account and 0 switches.
	Slots []SlotSummary
}

// SlotSummary is one slot of a card now.
type SlotSummary struct {
	Platform string
	Current  string // the account the slot is declared to now; "" if none
	// Since is the date of the record that started the slot giving its
	// place to Current (see SlotChange.Since), and SinceSeq its seq. Both
	// are zero if Current is "".
	Since    verifier.Date
	SinceSeq uint64
	// SwitchCount is the slot's switch_count. It is kept after a
	// withdrawal.
	SwitchCount int
}

// HistoryRecord is one valid record of a card.
type HistoryRecord struct {
	Seq  uint64
	Date verifier.Date
	// Changes has one entry for every platform on which the record has a
	// kind, in ascending order of platform. SlotChange.Since and
	// SwitchCount are not kept in the history and are left zero.
	Changes []SlotChange
}

// AccountCard is a card whose current account on a platform is a given
// account.
type AccountCard struct {
	ScopedID string
	// Since is the date from which the card gives its place on the
	// platform to the account, and SinceSeq the seq of that record.
	Since         verifier.Date
	SinceSeq      uint64
	LastCardProof verifier.Date
}

// RecentSlot is a slot that has an account now, for the list of the
// latest ones.
type RecentSlot struct {
	// SinceSeq is the seq of the record that started the slot giving its
	// place to Username, and Since its date. Pass the Position of the last
	// one to Recent to get the ones after it.
	SinceSeq uint64
	Since    verifier.Date
	Username string
	ScopedID string
}

// RecentPosition is a place in the list of the latest slots: Recent
// returns the slots after it, those whose (Since, SinceSeq) is below it.
// The zero RecentPosition is the start of the list. On one platform of a
// scope no two slots have the same SinceSeq (a record is of one card and
// names at most one account per platform), so a position is one slot.
type RecentPosition struct {
	Since    verifier.Date
	SinceSeq uint64
}

// Position returns the place of r in the list of the latest slots.
func (r RecentSlot) Position() RecentPosition {
	return RecentPosition{Since: r.Since, SinceSeq: r.SinceSeq}
}

// RecentDays is how far back Counts looks for a recent card proof: a
// last_card_proof on the given date or up to 90 days before it, both
// included (design/copy/home.md, section 2).
const RecentDays = 90

var (
	// ErrViewsBehind is returned by Append when it is given a view while
	// the views do not reflect every earlier record, and by AddViews when a
	// view is not for the record after ViewSeq. Nothing is written.
	ErrViewsBehind = errors.New("store: the views are not at the record before this one")
	// ErrViewMismatch is returned when a view is not for the record it is
	// written with. Nothing is written.
	ErrViewMismatch = errors.New("store: the view is not for this record")
)
