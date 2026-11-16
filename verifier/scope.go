package verifier

import "fmt"

// ScopeStringLength is the length of every scope string in bytes.
const ScopeStringLength = 31

// Roster says which list of accepted scopes applies (spec/scope.md,
// "Accepted scopes"): the production roster's, or the test rosters'.
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
	String   string
	Platform string
	// ValidUsername checks a username against the scope's format, matched
	// against the whole value.
	ValidUsername func(string) bool
	// LastSeq is the `seq` of the last record the scope accepts, or 0 while
	// the scope is open.
	LastSeq uint64
}

// The tables of spec/scope.md. Rows are added, never removed; a row changes
// only when its scope is retired (LastSeq).
var (
	productionScopes = []Scope{
		{String: "iamreal:threads:0______________", Platform: "Threads", ValidUsername: threadsUsername},
	}
	testScopes = []Scope{
		{String: "iamreal-test:threads:0_________", Platform: "Threads", ValidUsername: threadsUsername},
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

// threadsUsername is the format [a-z0-9._]{1,30}.
func threadsUsername(u string) bool {
	if len(u) < 1 || len(u) > 30 {
		return false
	}
	for i := 0; i < len(u); i++ {
		c := u[i]
		if !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '.' || c == '_') {
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
