package main

// The card state file (spec/roster-rules.md, "The card state file"): the
// states the server keeps, published once a day in the roster directory as
// card-state/<date>.jsonl (ADR-0027). The command compares the file of one
// date with the states it computes from the roster, and reports every card
// that differs (ADR-0025).

import (
	"errors"
	"fmt"
	"strings"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// cardStateDir is the subdirectory of the roster directory that holds the
// card state files, one per date (ADR-0027).
const cardStateDir = "card-state"

// maxCardStateFile is the largest card state file the command reads. In the
// production roster, a row is at most 212 bytes plus 151 for each slot it
// lists when its numbers are ones the rules leave, 227 plus 166 at the
// format's limits: 393 for a card that has used Threads. 4 GiB holds more
// than 10.9 million such rows.
const maxCardStateFile = 4 << 30

// cardStateName is the path, in the roster directory, of the card state
// file of date d.
func cardStateName(d verifier.Date) string { return cardStateDir + "/" + d.String() + ".jsonl" }

// checkCardState compares the card state file of a date with rep, the
// roster's own computation, for a valid roster directory p of roster r read
// from src. The date is asked, or else that of the fingerprint file's last
// line. It returns the problems, one line each for people: a broken file,
// and every card that is different; and one line that says what was
// compared, or why nothing was. Nothing to compare (no date, not exactly
// one line of that date, no file of the date the last line gives) is not a
// problem. An error means the check could not be made, including a file of
// an asked date that is not there.
func checkCardState(src source, p *publishedRoster, r verifier.Roster, rep *roster.Report, asked *verifier.Date) (problems []string, summary string, err error) {
	var lines []fingerprintLine
	if p.fingerprints != nil {
		lines = readableFingerprintLines(p.fingerprints.data)
	}
	var date verifier.Date
	switch {
	case asked != nil:
		date = *asked
	case len(lines) == 0:
		return nil, fingerprintsFileName + " has no line: no card state compared", nil
	default:
		date = lines[len(lines)-1].Date
	}
	name := cardStateName(date)
	var dated []fingerprintLine
	for _, fl := range lines {
		if fl.Date == date {
			dated = append(dated, fl)
		}
	}
	switch len(dated) {
	case 0:
		// Written before its line, or not one of the published days:
		// nothing says which records it covers.
		return nil, fmt.Sprintf("%s has no line dated %s: %s is not compared", fingerprintsFileName, date, name), nil
	case 1:
	default:
		// The fingerprint file is broken, and its check reports it: no one
		// count says which records the file covers.
		return nil, fmt.Sprintf("%s has %d lines dated %s: %s is not compared", fingerprintsFileName, len(dated), date, name), nil
	}
	count := dated[0].Count
	data, err := src.get(name, maxCardStateFile)
	switch {
	case errors.Is(err, errNotFound) && asked == nil:
		return nil, name + " is not there: no card state compared", nil
	case errors.Is(err, errNotFound):
		return nil, "", fmt.Errorf("%s is not there", name)
	case err != nil:
		return nil, "", err
	}
	rows, broken := roster.ReadCardStateFile(data, r)
	if broken != nil {
		return []string{fmt.Sprintf("%s: broken at line %d: %s (%v)", name, broken.Line, broken.Code, broken.Err)}, "", nil
	}
	n := map[string]int{}
	for _, o := range roster.CompareCardStates(rows, count, uint64(rep.Records), rep.Cards).Outcomes {
		n[o.Outcome]++
		if o.Outcome == roster.OutcomeDifferent {
			problems = append(problems, fmt.Sprintf("%s: card %s %s is different: %s", name, o.ScopeString, o.ScopedID, strings.Join(o.Differences, "; ")))
		}
	}
	summary = fmt.Sprintf("%s: count %d of %s, %d record(s) re-verified: %d card(s) the same, %d skipped",
		name, count, fingerprintsFileName, rep.Records, n[roster.OutcomeSame], n[roster.OutcomeSkipped])
	if len(problems) > 0 {
		summary += fmt.Sprintf(", %d different", len(problems))
	}
	return problems, summary, nil
}
