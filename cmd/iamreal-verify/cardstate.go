package main

// The card state file (spec/roster-rules.md, "The card state file"): the
// states the server keeps, published once a day in the roster directory as
// card-state/<date>.jsonl (ADR-0027). The command compares the file of one
// date with the states it computes from the roster, and reports every card
// that differs (ADR-0025).

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// cardStateDir is the subdirectory of the roster directory that holds the
// card state files, one per date (ADR-0027).
const cardStateDir = "card-state"

// maxCardStateFile is the largest card state file the command reads. A row
// is under 300 bytes with today's platform tables, plus about 150 for each
// platform a card has used; 4 GiB holds more than 10 million cards.
const maxCardStateFile = 4 << 30

// cardStateName is the path, in the roster directory, of the card state
// file of date d.
func cardStateName(d verifier.Date) string { return cardStateDir + "/" + d.String() + ".jsonl" }

// checkCardState compares the card state file of a date with rep, the
// roster's own computation, for a valid roster directory p of roster r read
// from src. The date is asked, or else that of the fingerprint file's last
// line. It writes what it did to stderr and returns the problems, already
// written: a broken file, and every card that is different. Nothing to
// compare (no date, no line of that date, no file of the date the last line
// gives) is not a problem. An error means the check could not be made,
// including a file of an asked date that is not there.
func checkCardState(src source, p *publishedRoster, r verifier.Roster, rep *roster.Report, asked *verifier.Date, stderr io.Writer) ([]string, error) {
	say := func(format string, args ...any) { fmt.Fprintf(stderr, "iamreal-verify: "+format+"\n", args...) }
	var lines []fingerprintLine // the lines of the fingerprint file as the spec writes them
	if p.fingerprints != nil {
		for _, raw := range splitLines(p.fingerprints.data) {
			if fl, err := parseFingerprintLine(raw); err == nil {
				lines = append(lines, fl)
			}
		}
	}
	var date verifier.Date
	switch {
	case asked != nil:
		date = *asked
	case len(lines) == 0:
		say("%s has no line: no card state compared", fingerprintsFileName)
		return nil, nil
	default:
		date = lines[len(lines)-1].Date
	}
	name := cardStateName(date)
	var line *fingerprintLine
	for i := range lines {
		if lines[i].Date == date {
			line = &lines[i]
			break
		}
	}
	if line == nil {
		// Written before its line, or not one of the published days:
		// nothing says which records it covers.
		say("%s has no line dated %s: %s is not compared", fingerprintsFileName, date, name)
		return nil, nil
	}
	data, err := src.get(name, maxCardStateFile)
	switch {
	case errors.Is(err, errNotFound) && asked == nil:
		say("%s is not there: no card state compared", name)
		return nil, nil
	case errors.Is(err, errNotFound):
		return nil, fmt.Errorf("%s is not there", name)
	case err != nil:
		return nil, err
	}
	rows, broken := roster.ReadCardStateFile(data, r)
	if broken != nil {
		problem := fmt.Sprintf("%s: broken at line %d: %s (%v)", name, broken.Line, broken.Code, broken.Err)
		say("%s", problem)
		return []string{problem}, nil
	}
	cmp := roster.CompareCardStates(rows, line.Count, uint64(rep.Records), rep.Cards)
	var problems []string
	n := map[string]int{}
	for _, o := range cmp.Outcomes {
		n[o.Outcome]++
		if o.Outcome == roster.OutcomeDifferent {
			problem := fmt.Sprintf("%s: card %s %s is different: %s", name, o.ScopeString, o.ScopedID, strings.Join(o.Differences, "; "))
			say("%s", problem)
			problems = append(problems, problem)
		}
	}
	summary := fmt.Sprintf("%s: count %d of %s, %d record(s) re-verified: %d card(s) the same, %d skipped",
		name, line.Count, fingerprintsFileName, rep.Records, n[roster.OutcomeSame], n[roster.OutcomeSkipped])
	if len(problems) > 0 {
		summary += fmt.Sprintf(", %d different", len(problems))
	}
	say("%s", summary)
	return problems, nil
}
