package roster_test

import (
	"os"
	"regexp"
	"strconv"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
)

// The version number of the rules is stated once in the specification
// (spec/roster-rules.md, "The version number") and carried by the vectors.
// The TypeScript tests check protocol/'s RULES_VERSION against the same two
// places (protocol/test/roster-rules.test.ts), so the two constants agree.
func TestRulesVersion(t *testing.T) {
	spec, err := os.ReadFile("../spec/roster-rules.md")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^\*\*These rules are version ([1-9][0-9]*)\.\*\*$`).FindSubmatch(spec)
	if m == nil {
		t.Fatal("spec/roster-rules.md does not state the version in one sentence")
	}
	if got := strconv.Itoa(roster.RulesVersion); got != string(m[1]) {
		t.Errorf("RulesVersion is %s, spec/roster-rules.md says %s", got, m[1])
	}
	var v struct {
		RulesVersion *int `json:"rules_version"`
	}
	load(t, "roster-rules.json", &v)
	if v.RulesVersion == nil || *v.RulesVersion != roster.RulesVersion {
		t.Errorf("RulesVersion is %d, spec/vectors/roster-rules.json has %v", roster.RulesVersion, v.RulesVersion)
	}
}
