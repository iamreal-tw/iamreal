package verifier_test

// The platform table's two ways of saying which usernames a platform
// accepts agree: the format string (UsernameFormat, which the back end's
// `config` sends and a device reads) and the check function
// (ValidUsername). Moved from the Go back end's tests
// (e159ab9:server/api_test.go, TestConfigPlatforms) when that was deleted
// (#74).

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/verifier"
)

func TestUsernameFormatIsTheCheckFunction(t *testing.T) {
	for _, r := range []verifier.Roster{verifier.Production, verifier.Test} {
		for _, p := range verifier.Platforms(r) {
			accept, err := parseUsernameFormat(p.UsernameFormat)
			if err != nil {
				t.Errorf("%s: %s: %q: %v", r, p.ID, p.UsernameFormat, err)
				continue
			}
			for _, u := range usernameProbes() {
				if accept(u) != p.ValidUsername(u) {
					t.Errorf("%s: %s: %q: the format says %v, the check function %v", r, p.ID, u, accept(u), p.ValidUsername(u))
				}
			}
		}
	}
	if _, err := parseUsernameFormat("[a-z]+"); err == nil {
		t.Errorf("a format outside the form was read")
	}
}

// parseUsernameFormat reads the one form of a username format of
// spec/scope.md, a character class and a length range, `[…]{m,n}`, the way
// a device would: without a regular expression library. In the class, `x-y`
// is a range and any other character stands for itself.
func parseUsernameFormat(f string) (func(string) bool, error) {
	open, close := strings.IndexByte(f, '['), strings.LastIndexByte(f, ']')
	if open != 0 || close < 2 {
		return nil, errors.New("not a character class first")
	}
	class := f[1:close]
	var m, n int
	if _, err := fmt.Sscanf(f[close+1:], "{%d,%d}", &m, &n); err != nil || fmt.Sprintf("{%d,%d}", m, n) != f[close+1:] || m < 1 || n < m {
		return nil, errors.New("not a length range")
	}
	in := func(c byte) bool {
		for i := 0; i < len(class); i++ {
			if i+2 < len(class) && class[i+1] == '-' {
				if class[i] <= c && c <= class[i+2] {
					return true
				}
				i += 2
				continue
			}
			if class[i] == c {
				return true
			}
		}
		return false
	}
	return func(u string) bool {
		if len(u) < m || len(u) > n {
			return false
		}
		for i := 0; i < len(u); i++ {
			if !in(u[i]) {
				return false
			}
		}
		return true
	}, nil
}

// usernameProbes are strings to tell two username checks apart: every
// single byte, every byte after and before a letter, and runs of a letter
// around each length limit of spec/scope.md.
func usernameProbes() []string {
	out := []string{""}
	for c := 0; c < 256; c++ {
		out = append(out, string([]byte{byte(c)}), string([]byte{'a', byte(c)}), string([]byte{byte(c), 'a'}))
	}
	for n := 1; n <= 32; n++ {
		out = append(out, strings.Repeat("a", n), strings.Repeat("-", n), strings.Repeat(".", n))
	}
	return out
}
