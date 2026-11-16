package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/iamreal-tw/iamreal/verifier"

	_ "modernc.org/sqlite" // the SQLite driver, pure Go
)

// The two tables. A record's columns are its fields as written in its line
// (spec/record.md); its hash is not stored, since it is computed from them.
// A challenge is stored from the moment it is issued until it is deleted
// after it expired (see DeleteChallengesIssuedBefore).
const schema = `
CREATE TABLE IF NOT EXISTS records (
	seq          INTEGER PRIMARY KEY,
	prev         TEXT NOT NULL,
	scope_string TEXT NOT NULL,
	scoped_id    TEXT NOT NULL,
	action       TEXT NOT NULL,
	username     TEXT NOT NULL,
	challenge    TEXT NOT NULL UNIQUE,
	issuer       TEXT NOT NULL,
	smt_root     TEXT NOT NULL,
	circuit      TEXT NOT NULL,
	proof        TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS challenges (
	challenge   TEXT PRIMARY KEY,
	issued_ns   INTEGER NOT NULL, -- Unix time in nanoseconds
	submissions INTEGER NOT NULL DEFAULT 0,
	accepted    INTEGER NOT NULL DEFAULT 0 -- 1 once a card proof is accepted
) STRICT;
`

const recordColumns = `seq, prev, scope_string, scoped_id, action, username, challenge, issuer, smt_root, circuit, proof`

// SQLite is the Store kept in one SQLite file.
type SQLite struct {
	db *sql.DB
}

var _ Store = (*SQLite)(nil)

// Open opens the SQLite file at path, creating it and its tables if needed.
func Open(path string) (*SQLite, error) {
	// WAL lets the snapshot command read while the server writes;
	// synchronous(FULL) makes a committed record survive a power cut.
	db, err := sql.Open("sqlite", "file:"+path+
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(10000)")
	if err != nil {
		return nil, err
	}
	// One connection: every read and write of this process is one after
	// the other, which is what an append-only chain needs.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: %s: %w", path, err)
	}
	return &SQLite{db: db}, nil
}

// OpenReadOnly opens an existing SQLite file for reading only, for a
// command that runs next to the server (the daily snapshot).
func OpenReadOnly(path string) (*SQLite, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(10000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`SELECT 1 FROM records LIMIT 1`); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: %s: %w", path, err)
	}
	return &SQLite{db: db}, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

// queryer is what *sql.DB and *sql.Tx have in common.
type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func (s *SQLite) Head() (uint64, string, error) { return head(s.db) }

func head(q queryer) (uint64, string, error) {
	r, err := scanRecord(q.QueryRow(`SELECT ` + recordColumns + ` FROM records ORDER BY seq DESC LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return 0, verifier.GenesisPrev, nil
	}
	if err != nil {
		return 0, "", err
	}
	// seq runs from 1 without gaps (Append checks it), so the last seq is
	// the number of records.
	return r.Seq, r.Hash(), nil
}

type scanner interface{ Scan(dest ...any) error }

func scanRecord(row scanner) (*verifier.Record, error) {
	r := &verifier.Record{}
	err := row.Scan(&r.Seq, &r.Prev, &r.ScopeString, &r.ScopedID, &r.Action, &r.Username,
		&r.Challenge, &r.Issuer, &r.SMTRoot, &r.Circuit, &r.Proof)
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (s *SQLite) Records(first, last uint64) ([]*verifier.Record, error) {
	rows, err := s.db.Query(`SELECT `+recordColumns+` FROM records WHERE seq BETWEEN ? AND ? ORDER BY seq`, first, last)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*verifier.Record
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *SQLite) Append(r *verifier.Record) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() // does nothing after Commit

	count, h, err := head(tx)
	if err != nil {
		return err
	}
	if r.Seq != count+1 || r.Prev != h {
		return ErrNotNext
	}
	res, err := tx.Exec(`UPDATE challenges SET accepted = 1 WHERE challenge = ? AND accepted = 0`, r.Challenge)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return ErrChallengeNotOpen
	}
	_, err = tx.Exec(`INSERT INTO records (`+recordColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.Seq, r.Prev, r.ScopeString, r.ScopedID, r.Action, r.Username, r.Challenge, r.Issuer, r.SMTRoot, r.Circuit, r.Proof)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLite) AddChallenge(challenge string, issued time.Time) error {
	_, err := s.db.Exec(`INSERT INTO challenges (challenge, issued_ns) VALUES (?, ?)`, challenge, issued.UnixNano())
	return err
}

func (s *SQLite) Submit(challenge string) (Challenge, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Challenge{}, false, err
	}
	defer tx.Rollback()

	c := Challenge{Challenge: challenge}
	var issued int64
	err = tx.QueryRow(`SELECT issued_ns, submissions, accepted FROM challenges WHERE challenge = ?`, challenge).
		Scan(&issued, &c.Submissions, &c.Accepted)
	if errors.Is(err, sql.ErrNoRows) {
		return Challenge{}, false, nil
	}
	if err != nil {
		return Challenge{}, false, err
	}
	c.Issued = time.Unix(0, issued)
	if c.Accepted {
		return c, true, nil
	}
	c.Submissions++
	if _, err := tx.Exec(`UPDATE challenges SET submissions = ? WHERE challenge = ?`, c.Submissions, challenge); err != nil {
		return Challenge{}, false, err
	}
	return c, true, tx.Commit()
}

func (s *SQLite) DeleteChallengesIssuedBefore(t time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM challenges WHERE issued_ns < ?`, t.UnixNano())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
