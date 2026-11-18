package store

import (
	"database/sql"
	"errors"
	"math"

	"github.com/iamreal-tw/iamreal/verifier"
)

// The views (view.go) in SQLite. Dates are verifier.Date: days since
// 1970-01-01. An account that is none is NULL. Every table is keyed by the
// scope string, since a roster can hold two scopes while one is retired.
//
//   - view_state: one row, the seq of the last record the views reflect.
//   - view_cards: one row per card with a valid record.
//   - view_slots: one row per slot on which a valid record of the card has
//     had a kind. last_card_proof is the card's as of the last record with
//     a kind on the slot, so that the counts are answered from one index.
//     For a slot with an account that is the card's last_card_proof: a
//     valid record has a kind on every slot that has an account before it
//     (refresh, switch, correction or withdraw), so every valid record of
//     the card writes it.
//   - view_history: one row per valid record and platform on which it has a
//     kind.
//
// Every query of the pages reads one index range (see the comment on each);
// sqlite_view_test.go checks the query plans.
const viewSchema = `
CREATE TABLE IF NOT EXISTS view_state (
	id  INTEGER PRIMARY KEY CHECK (id = 1),
	seq INTEGER NOT NULL -- the views reflect the records 1 to seq
) STRICT;
INSERT OR IGNORE INTO view_state (id, seq) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS view_cards (
	scope_string    TEXT NOT NULL,
	scoped_id       TEXT NOT NULL,
	short_id        TEXT NOT NULL, -- the first 10 characters of scoped_id
	first_date      INTEGER NOT NULL,
	last_card_proof INTEGER NOT NULL,
	card_proofs     INTEGER NOT NULL,
	PRIMARY KEY (scope_string, scoped_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS view_cards_short_id ON view_cards (scope_string, short_id);

CREATE TABLE IF NOT EXISTS view_slots (
	scope_string    TEXT NOT NULL,
	scoped_id       TEXT NOT NULL,
	platform        TEXT NOT NULL,
	current         TEXT,    -- NULL: none
	since_date      INTEGER, -- NULL exactly when current is
	since_seq       INTEGER, -- NULL exactly when current is
	switch_count    INTEGER NOT NULL,
	last_card_proof INTEGER NOT NULL,
	PRIMARY KEY (scope_string, scoped_id, platform),
	CHECK ((current IS NULL) = (since_date IS NULL) AND (current IS NULL) = (since_seq IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS view_slots_account ON view_slots
	(scope_string, platform, current, since_date, since_seq, last_card_proof) WHERE current IS NOT NULL;
CREATE INDEX IF NOT EXISTS view_slots_recent ON view_slots
	(scope_string, platform, since_seq, since_date, current) WHERE current IS NOT NULL;
CREATE INDEX IF NOT EXISTS view_slots_recency ON view_slots
	(scope_string, platform, last_card_proof, current) WHERE current IS NOT NULL;

CREATE TABLE IF NOT EXISTS view_history (
	seq              INTEGER NOT NULL,
	platform         TEXT NOT NULL,
	scope_string     TEXT NOT NULL,
	scoped_id        TEXT NOT NULL,
	date             INTEGER NOT NULL,
	kind             TEXT NOT NULL,    -- the rules' kind
	after_withdrawal INTEGER NOT NULL, -- 1: see SlotChange.AfterWithdrawal
	before_username  TEXT,             -- SlotChange.Before; NULL for ""
	after_username   TEXT,             -- SlotChange.After; NULL for ""
	PRIMARY KEY (seq, platform)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS view_history_card ON view_history (scope_string, scoped_id, date, seq, platform);
`

// The queries of the pages. Each names its index (INDEXED BY), so that the
// plan does not depend on the planner's guesses; sqlite_view_test.go
// checks that each reads one index range and sorts nothing.
const (
	queryCards = `SELECT scoped_id, first_date, last_card_proof, card_proofs FROM view_cards INDEXED BY view_cards_short_id
		WHERE scope_string = ? AND short_id = ? ORDER BY scoped_id`
	querySlots = `SELECT platform, current, since_date, since_seq, switch_count FROM view_slots
		WHERE scope_string = ? AND scoped_id = ? ORDER BY platform`
	queryHistory = `SELECT seq, date, platform, kind, after_withdrawal, before_username, after_username
		FROM view_history INDEXED BY view_history_card WHERE scope_string = ? AND scoped_id = ?
		ORDER BY date DESC, seq DESC, platform DESC`
	queryAccountCards = `SELECT scoped_id, since_date, since_seq, last_card_proof FROM view_slots INDEXED BY view_slots_account
		WHERE scope_string = ? AND platform = ? AND current = ?
		ORDER BY since_date, since_seq`
	queryRecent = `SELECT since_seq, since_date, current, scoped_id FROM view_slots INDEXED BY view_slots_recent
		WHERE scope_string = ? AND platform = ? AND current IS NOT NULL AND since_seq < ?
		ORDER BY since_seq DESC LIMIT ?`
	queryCounts = `SELECT COUNT(*), COALESCE(SUM(last_card_proof >= ?), 0) FROM view_slots INDEXED BY view_slots_recency
		WHERE scope_string = ? AND platform = ? AND current IS NOT NULL`
)

// execer is what *sql.DB and *sql.Tx have in common for writing.
type execer interface {
	queryer
	Exec(query string, args ...any) (sql.Result, error)
}

func viewSeq(q queryer) (uint64, error) {
	var seq uint64
	err := q.QueryRow(`SELECT seq FROM view_state WHERE id = 1`).Scan(&seq)
	return seq, err
}

func nullable(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

// writeView writes what one valid record changes and moves view_state to
// its seq. The caller checks that the views are at the record before.
func writeView(tx execer, v *View) error {
	if len(v.ScopedID) < verifier.ShortIDLength {
		return ErrViewMismatch
	}
	if _, err := tx.Exec(`INSERT INTO view_cards (scope_string, scoped_id, short_id, first_date, last_card_proof, card_proofs)
		VALUES (?, ?, ?, ?, ?, 1)
		ON CONFLICT (scope_string, scoped_id) DO UPDATE SET
			last_card_proof = excluded.last_card_proof, card_proofs = card_proofs + 1`,
		v.ScopeString, v.ScopedID, verifier.ShortID(v.ScopedID), int64(v.Date), int64(v.LastCardProof)); err != nil {
		return err
	}
	for _, c := range v.Changes {
		var sinceDate, sinceSeq sql.NullInt64
		if c.Since && c.After != "" {
			sinceDate = sql.NullInt64{Int64: int64(v.Date), Valid: true}
			sinceSeq = sql.NullInt64{Int64: int64(v.Seq), Valid: true}
		}
		// A change that does not start the slot's giving (a refresh of the
		// current account) keeps since; a withdrawal clears it. A slot
		// gets its row with its first declaration.
		keep := !c.Since && c.After != ""
		res, err := tx.Exec(`UPDATE view_slots SET
				current = ?4,
				since_date = CASE WHEN ?7 THEN since_date ELSE ?5 END,
				since_seq = CASE WHEN ?7 THEN since_seq ELSE ?6 END,
				switch_count = ?8,
				last_card_proof = ?9
			WHERE scope_string = ?1 AND scoped_id = ?2 AND platform = ?3`,
			v.ScopeString, v.ScopedID, c.Platform, nullable(c.After), sinceDate, sinceSeq, keep,
			c.SwitchCount, int64(v.LastCardProof))
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil {
			return err
		} else if n == 0 {
			if _, err := tx.Exec(`INSERT INTO view_slots
				(scope_string, scoped_id, platform, current, since_date, since_seq, switch_count, last_card_proof)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				v.ScopeString, v.ScopedID, c.Platform, nullable(c.After), sinceDate, sinceSeq,
				c.SwitchCount, int64(v.LastCardProof)); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`INSERT INTO view_history
			(seq, platform, scope_string, scoped_id, date, kind, after_withdrawal, before_username, after_username)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			v.Seq, c.Platform, v.ScopeString, v.ScopedID, int64(v.Date), c.Kind, c.AfterWithdrawal,
			nullable(c.Before), nullable(c.After)); err != nil {
			return err
		}
	}
	_, err := tx.Exec(`UPDATE view_state SET seq = ? WHERE id = 1`, v.Seq)
	return err
}

func (s *SQLite) ViewSeq() (uint64, error) { return viewSeq(s.db) }

func (s *SQLite) AddViews(views []*View) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	at, err := viewSeq(tx)
	if err != nil {
		return err
	}
	for _, v := range views {
		if v.Seq != at+1 {
			return ErrViewsBehind
		}
		var scope, id string
		err := tx.QueryRow(`SELECT scope_string, scoped_id FROM records WHERE seq = ?`, v.Seq).Scan(&scope, &id)
		if errors.Is(err, sql.ErrNoRows) || err == nil && (scope != v.ScopeString || id != v.ScopedID) {
			return ErrViewMismatch
		}
		if err != nil {
			return err
		}
		if err := writeView(tx, v); err != nil {
			return err
		}
		at = v.Seq
	}
	return tx.Commit()
}

func (s *SQLite) ResetViews() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM view_cards`, `DELETE FROM view_slots`, `DELETE FROM view_history`,
		`UPDATE view_state SET seq = 0 WHERE id = 1`,
	} {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Cards reads the index view_cards_short_id, then the primary key of
// view_slots for each card.
func (s *SQLite) Cards(scopeString, shortID string) ([]CardSummary, error) {
	rows, err := s.db.Query(queryCards, scopeString, shortID)
	if err != nil {
		return nil, err
	}
	var out []CardSummary
	for rows.Next() {
		var c CardSummary
		var first, last int64
		if err := rows.Scan(&c.ScopedID, &first, &last, &c.CardProofs); err != nil {
			rows.Close()
			return nil, err
		}
		c.FirstCardProof, c.LastCardProof = verifier.Date(first), verifier.Date(last)
		out = append(out, c)
	}
	rows.Close() // one connection: close before the next query
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Slots, err = s.slots(scopeString, out[i].ScopedID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *SQLite) slots(scopeString, scopedID string) ([]SlotSummary, error) {
	rows, err := s.db.Query(querySlots, scopeString, scopedID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SlotSummary
	for rows.Next() {
		var sl SlotSummary
		var cur sql.NullString
		var sinceDate, sinceSeq sql.NullInt64
		if err := rows.Scan(&sl.Platform, &cur, &sinceDate, &sinceSeq, &sl.SwitchCount); err != nil {
			return nil, err
		}
		sl.Current, sl.Since, sl.SinceSeq = cur.String, verifier.Date(sinceDate.Int64), uint64(sinceSeq.Int64)
		out = append(out, sl)
	}
	return out, rows.Err()
}

// History reads the index view_history_card, backwards.
func (s *SQLite) History(scopeString, scopedID string) ([]HistoryRecord, error) {
	rows, err := s.db.Query(queryHistory, scopeString, scopedID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryRecord
	for rows.Next() {
		var seq uint64
		var date int64
		var c SlotChange
		var before, after sql.NullString
		if err := rows.Scan(&seq, &date, &c.Platform, &c.Kind, &c.AfterWithdrawal, &before, &after); err != nil {
			return nil, err
		}
		c.Before, c.After = before.String, after.String
		if n := len(out); n == 0 || out[n-1].Seq != seq {
			out = append(out, HistoryRecord{Seq: seq, Date: verifier.Date(date)})
		}
		last := &out[len(out)-1]
		// The rows of one record come by platform, descending: put each
		// in front.
		last.Changes = append([]SlotChange{c}, last.Changes...)
	}
	return out, rows.Err()
}

// AccountCards reads the index view_slots_account (it covers the query).
func (s *SQLite) AccountCards(scopeString, platform, username string) ([]AccountCard, error) {
	rows, err := s.db.Query(queryAccountCards, scopeString, platform, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccountCard
	for rows.Next() {
		var c AccountCard
		var since, last int64
		if err := rows.Scan(&c.ScopedID, &since, &c.SinceSeq, &last); err != nil {
			return nil, err
		}
		c.Since, c.LastCardProof = verifier.Date(since), verifier.Date(last)
		out = append(out, c)
	}
	return out, rows.Err()
}

// Recent reads the index view_slots_recent, backwards (it covers the
// query).
func (s *SQLite) Recent(scopeString, platform string, before uint64, n int) ([]RecentSlot, error) {
	if before == 0 || before > math.MaxInt64 {
		before = math.MaxInt64
	}
	rows, err := s.db.Query(queryRecent, scopeString, platform, int64(before), n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RecentSlot
	for rows.Next() {
		var r RecentSlot
		var since int64
		if err := rows.Scan(&r.SinceSeq, &since, &r.Username, &r.ScopedID); err != nil {
			return nil, err
		}
		r.Since = verifier.Date(since)
		out = append(out, r)
	}
	return out, rows.Err()
}

// Counts reads the index view_slots_recency (it covers the query): one
// range, the slots of the platform with an account.
func (s *SQLite) Counts(scopeString, platform string, today verifier.Date) (declared, recent int, err error) {
	err = s.db.QueryRow(queryCounts,
		int64(today.AddDays(-RecentDays)), scopeString, platform).Scan(&declared, &recent)
	return declared, recent, err
}
