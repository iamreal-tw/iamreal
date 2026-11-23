package prooflog_test

import (
	"os"
	"regexp"
	"strconv"
	"testing"

	"github.com/iamreal-tw/iamreal/prooflog"
)

// The version number of the rules is stated once in the specification
// (spec/record-rules.md, "The version number") and carried by the vectors.
// The TypeScript tests check protocol/'s RULES_VERSION against the same two
// places (protocol/test/record-rules.test.ts), so the two constants agree.
func TestRulesVersion(t *testing.T) {
	spec, err := os.ReadFile("../spec/record-rules.md")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^\*\*These rules are version ([1-9][0-9]*)\.\*\*$`).FindSubmatch(spec)
	if m == nil {
		t.Fatal("spec/record-rules.md does not state the version in one sentence")
	}
	if got := strconv.Itoa(prooflog.RulesVersion); got != string(m[1]) {
		t.Errorf("RulesVersion is %s, spec/record-rules.md says %s", got, m[1])
	}
	var v struct {
		RulesVersion *int `json:"rules_version"`
	}
	load(t, "record-rules.json", &v)
	if v.RulesVersion == nil || *v.RulesVersion != prooflog.RulesVersion {
		t.Errorf("RulesVersion is %d, spec/vectors/record-rules.json has %v", prooflog.RulesVersion, v.RulesVersion)
	}
}
