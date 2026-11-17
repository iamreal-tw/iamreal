package verifier

import (
	"fmt"
	"sort"
)

// ScopeStringLength is the length of every scope string in bytes.
const ScopeStringLength = 31

// Roster says which tables apply (spec/scope.md): the accepted scopes and
// the platforms of the production roster, or of the test rosters.
type Roster int

const (
	Production Roster = iota
	Test
)

func (r Roster) String() string {
	switch r {
	case Production:
		return "production"
	case Test:
		return "test"
	}
	return fmt.Sprintf("Roster(%d)", int(r))
}

// Scope is one row of an accepted-scopes table.
type Scope struct {
	String string
	// LastSeq is the `seq` of the last record the scope accepts, or 0 while
	// the scope is open.
	LastSeq uint64
}

// Platform is one row of a platform table (spec/scope.md, "Platforms").
type Platform struct {
	// ID is the platform ID written in records and in the declaration code.
	ID string
	// DisplayName is for screens; the rules do not read it.
	DisplayName string
	// UsernameFormat is the `username` format exactly as written in the
	// table, one character class and one length range, `[…]{m,n}`. The
	// server sends it to devices (docs/api/card-proof.md, config).
	UsernameFormat string
	// ValidUsername checks a username against UsernameFormat, matched
	// against the whole value. A test checks that the two agree.
	ValidUsername func(string) bool
}

// The tables of spec/scope.md. Rows are added, never removed; a scope's row
// changes only when the scope is retired (LastSeq).
var (
	productionScopes = []Scope{
		{String: "iamreal:public:0_______________"},
	}
	testScopes = []Scope{
		{String: "iamreal-test:public:0__________"},
	}
	// productionPlatforms are the platforms of the production roster. A test
	// roster accepts these and testPlatforms. IDs starting with "test-" are
	// never added here.
	productionPlatforms = []Platform{
		{ID: "threads", DisplayName: "Threads", UsernameFormat: "[a-z0-9._]{1,30}", ValidUsername: threadsUsername},
	}
	testPlatforms = []Platform{
		{ID: "test-example", DisplayName: "Example (no real service)", UsernameFormat: "[a-z0-9-]{1,20}", ValidUsername: testExampleUsername},
	}
)

// Scopes returns the accepted scopes of roster r.
func Scopes(r Roster) []Scope {
	switch r {
	case Production:
		return append([]Scope(nil), productionScopes...)
	case Test:
		return append([]Scope(nil), testScopes...)
	}
	return nil
}

// LookupScope returns the row of scope string s in roster r.
func LookupScope(r Roster, s string) (Scope, bool) {
	for _, sc := range Scopes(r) {
		if sc.String == s {
			return sc, true
		}
	}
	return Scope{}, false
}

// Platforms returns the platforms roster r accepts, in ascending order of
// ID by byte value: the order of a record's account list.
func Platforms(r Roster) []Platform {
	var out []Platform
	switch r {
	case Production:
		out = append(out, productionPlatforms...)
	case Test:
		out = append(append(out, productionPlatforms...), testPlatforms...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// LookupPlatform returns the platform with ID id in roster r. The ID must
// be exactly as in the table.
func LookupPlatform(r Roster, id string) (Platform, bool) {
	for _, p := range Platforms(r) {
		if p.ID == id {
			return p, true
		}
	}
	return Platform{}, false
}

// threadsUsername is the format [a-z0-9._]{1,30}.
func threadsUsername(u string) bool {
	return usernameOf(u, 30, func(c byte) bool { return c == '.' || c == '_' })
}

// testExampleUsername is the format [a-z0-9-]{1,20}.
func testExampleUsername(u string) bool {
	return usernameOf(u, 20, func(c byte) bool { return c == '-' })
}

// usernameOf reports whether u is 1 to max characters of a-z, 0-9 and the
// characters extra accepts.
func usernameOf(u string, max int, extra func(byte) bool) bool {
	if len(u) < 1 || len(u) > max {
		return false
	}
	for i := 0; i < len(u); i++ {
		c := u[i]
		if !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || extra(c)) {
			return false
		}
	}
	return true
}

// ScopePacked returns the public input scope_packed for a 31-byte scope string.
func ScopePacked(scopeString string) (Field, error) {
	if len(scopeString) != ScopeStringLength {
		return Field{}, fmt.Errorf("scope string of %d bytes, not 31", len(scopeString))
	}
	return pack31([]byte(scopeString)), nil
}
