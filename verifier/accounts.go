package verifier

import (
	"errors"
	"fmt"
	"strings"
)

// Account is one account of a record's list (spec/record.md, "The account
// list"): a platform ID and the account's username on that platform.
type Account struct {
	Platform string
	Username string
}

// AccountsText writes an account list from its template: `[` `]` around the
// accounts, each {"platform":"…","username":"…"}, separated by `,`. This is
// how the list appears in a record's line and in its record hash. It does
// not check the values.
func AccountsText(accounts []Account) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, a := range accounts {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"platform":"`)
		b.WriteString(a.Platform)
		b.WriteString(`","username":"`)
		b.WriteString(a.Username)
		b.WriteString(`"}`)
	}
	b.WriteByte(']')
	return b.String()
}

// CheckAccounts checks an account list against the platform table of roster
// r (spec/record.md, "The account list"): every platform is an ID of the
// table, exactly as written there; the platforms are in strictly ascending
// order by byte value, so none is repeated; every username is in the format
// of its own platform. An empty list is valid. Nothing is sorted or
// repaired: a list that breaks a rule is an error.
func CheckAccounts(r Roster, accounts []Account) error {
	for i, a := range accounts {
		p, ok := LookupPlatform(r, a.Platform)
		if !ok {
			return fmt.Errorf("accounts: %q is not a platform of the %s roster", a.Platform, r)
		}
		if i > 0 && !(accounts[i-1].Platform < a.Platform) {
			if accounts[i-1].Platform == a.Platform {
				return fmt.Errorf("accounts: platform %s twice", a.Platform)
			}
			return errors.New("accounts: not in ascending order of platform")
		}
		if !p.ValidUsername(a.Username) {
			return fmt.Errorf("accounts: username not in the format of %s", a.Platform)
		}
	}
	return nil
}

// ReadAccountsText reads an account list written as AccountsText writes it,
// and only so: other spellings of the same list are an error. It does not
// check the platforms or usernames against a table; CheckAccounts does.
func ReadAccountsText(text string) ([]Account, error) {
	p := &jsonParser{b: []byte(text)}
	v, err := p.list()
	if err != nil {
		return nil, fmt.Errorf("accounts: %w", err)
	}
	if p.i != len(p.b) {
		return nil, errors.New("accounts: bytes after the list")
	}
	accounts, err := accountsFromList(v)
	if err != nil {
		return nil, err
	}
	if AccountsText(accounts) != text {
		return nil, errors.New("accounts: not written exactly as the template")
	}
	return accounts, nil
}

// AccountOn returns the username list has for platform, or ok false if it
// has none.
func AccountOn(list []Account, platform string) (username string, ok bool) {
	for _, a := range list {
		if a.Platform == platform {
			return a.Username, true
		}
	}
	return "", false
}
