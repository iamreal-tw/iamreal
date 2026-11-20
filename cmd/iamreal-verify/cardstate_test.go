package main

// Comparing the card state file of a date with the states computed from the
// roster (spec/roster-rules.md, "The card state file"), with the fake
// verifier and archive of main_test.go: every record of longRoster is a
// valid first declaration of its own card.

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// cardRows returns the rows of the cards of the first n records of
// longRoster, as the server would write them.
func cardRows(t *testing.T, n int) []roster.CardRow {
	t.Helper()
	x := roster.NewRules(verifier.Production, allVerify{}, everyRoot{})
	for _, r := range longRoster()[:n] {
		if res, err := x.Apply(r); err != nil || !res.Valid {
			t.Fatalf("seq %d: %v %v", r.Seq, res, err)
		}
	}
	return x.CardRows()
}

// cardStateFiles is a roster directory of the first 5 records, published on
// 2026-11-19 up to 3 and on 2026-11-20 up to 5, with the card state files
// files (by date).
func cardStateFiles(t *testing.T, files map[string][]byte) map[string][]byte {
	t.Helper()
	dir := published(5)
	for date, b := range files {
		dir["card-state/"+date+".jsonl"] = b
	}
	return dir
}

var cardStateFingerprints = fingerprints(fingerprintEntry("2026-11-19", 3), fingerprintEntry("2026-11-20", 5))

func TestCardState(t *testing.T) {
	same := roster.CardStateFile(cardRows(t, 5))
	code, out, errOut := runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": same}), cardStateFingerprints))
	if code != exitAllValid || !strings.Contains(errOut, "card-state/2026-11-20.jsonl: count 5 of fingerprints.jsonl, 5 record(s) re-verified: 5 card(s) the same, 0 skipped\n") {
		t.Errorf("the same: exit %d\n%s", code, errOut)
	}
	// The standard output is that of the roster alone.
	if _, outNone, _ := runDir(t, writeDir(t, published(5), cardStateFingerprints)); outNone != out {
		t.Errorf("the card state file changed the output")
	}

	// One item of one card differs: that card is named, with the item.
	rows := cardRows(t, 5)
	slot := rows[2].State.Slots["threads"]
	slot.SwitchCount = 1
	rows[2].State.Slots["threads"] = slot
	code, _, errOut = runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": roster.CardStateFile(rows)}), cardStateFingerprints))
	want := "card-state/2026-11-20.jsonl: card " + rows[2].ScopeString + " " + rows[2].ScopedID + " is different: threads switch_count: file 1, roster 0\n"
	if code != exitInvalid || !strings.Contains(errOut, want) || !strings.Contains(errOut, "4 card(s) the same, 0 skipped, 1 different\n") {
		t.Errorf("one card differs: exit %d\n%s", code, errOut)
	}

	// A card that the roster gives and the file leaves out.
	code, _, errOut = runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": roster.CardStateFile(rows[1:])}), cardStateFingerprints))
	if code != exitInvalid || !strings.Contains(errOut, "card "+rows[0].ScopeString+" "+rows[0].ScopedID+" is different: the file has no row") {
		t.Errorf("a card left out: exit %d\n%s", code, errOut)
	}

	// A broken file: the line and the code; not compared.
	broken := append(append([]byte(nil), same...), same[:len(same)/5-1]...) // the first row without its LF
	code, _, errOut = runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": broken}), cardStateFingerprints))
	if code != exitInvalid || !strings.Contains(errOut, "card-state/2026-11-20.jsonl: broken at line 6: line (") || strings.Contains(errOut, "the same") {
		t.Errorf("broken: exit %d\n%s", code, errOut)
	}
	twice := append(append([]byte(nil), same...), same[len(same)/5*4:]...)
	if code, _, errOut = runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": twice}), cardStateFingerprints)); code != exitInvalid ||
		!strings.Contains(errOut, "broken at line 6: order (") {
		t.Errorf("a card twice: exit %d\n%s", code, errOut)
	}
}

// A row beyond the count of its file is different, whatever the records
// re-verified: the file was to hold the states after the first count.
func TestCardStateBeyondTheCount(t *testing.T) {
	// The file of a count of 5 has the rows of 7 records.
	rows := cardRows(t, 7)
	code, _, errOut := runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": roster.CardStateFile(rows)}), cardStateFingerprints))
	if code != exitInvalid || !strings.Contains(errOut, "5 card(s) the same, 0 skipped, 2 different\n") {
		t.Errorf("exit %d\n%s", code, errOut)
	}
	for _, row := range rows {
		if row.LastSeq > 5 && !strings.Contains(errOut, "card "+row.ScopeString+" "+row.ScopedID+" is different: the row's last_seq "+fmt.Sprint(row.LastSeq)+" is beyond the file's count 5\n") {
			t.Errorf("seq %d not named\n%s", row.LastSeq, errOut)
		}
	}
}

// Cards beyond what either side covers are skipped, not a failure.
func TestCardStateSkipped(t *testing.T) {
	// The re-verifier is behind the file: the fingerprint file's line says
	// 7, the roster has 5. The rows of records 6 and 7 are within the count
	// and beyond the records re-verified. (The fingerprint file's count
	// beyond the roster is a problem of its own.)
	fps := fingerprints(fingerprintEntry("2026-11-19", 3), fingerprintEntry("2026-11-20", 7))
	_, _, errOut := runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": roster.CardStateFile(cardRows(t, 7))}), fps))
	if !strings.Contains(errOut, "card-state/2026-11-20.jsonl: count 7 of fingerprints.jsonl, 5 record(s) re-verified: 5 card(s) the same, 2 skipped\n") ||
		strings.Contains(errOut, "is different") || !strings.Contains(errOut, "count 7, but the roster has 5 records") {
		t.Errorf("rows beyond the records:\n%s", errOut)
	}
	// The file of an earlier date, given by -card-state: the cards whose
	// last valid record is after its count (3) are skipped.
	code, _, errOut := runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-19": roster.CardStateFile(cardRows(t, 3))}), cardStateFingerprints), "-card-state", "2026-11-19")
	if code != exitAllValid || !strings.Contains(errOut, "card-state/2026-11-19.jsonl: count 3 of fingerprints.jsonl, 5 record(s) re-verified: 3 card(s) the same, 2 skipped\n") {
		t.Errorf("an earlier date: exit %d\n%s", code, errOut)
	}
}

// When there is nothing to compare, the command says so; that is not a
// failure, unless a date was asked for and its file is not there.
func TestCardStateNotCompared(t *testing.T) {
	// No file for the date of the fingerprint file's last line.
	code, _, errOut := runDir(t, writeDir(t, published(5), cardStateFingerprints))
	if code != exitInvalid || !strings.Contains(errOut, "iamreal-verify: card-state/2026-11-20.jsonl is missing\n") {
		t.Errorf("no file: exit %d\n%s", code, errOut)
	}
	// A date without a line in the fingerprint file: the file is not read.
	dir := writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-18": []byte("not read")}), cardStateFingerprints)
	code, _, errOut = runDir(t, dir, "-card-state", "2026-11-18")
	if code != exitAllValid || !strings.Contains(errOut, "fingerprints.jsonl has no line dated 2026-11-18: card-state/2026-11-18.jsonl is not compared\n") {
		t.Errorf("no line: exit %d\n%s", code, errOut)
	}
	// Two lines of the date: the fingerprint file is broken, and says no
	// one count; the file is not read. The fingerprint file's check reports
	// the line.
	twoLines := fingerprints(fingerprintEntry("2026-11-19", 3), fingerprintEntry("2026-11-20", 5), fingerprintEntry("2026-11-20", 5))
	code, _, errOut = runDir(t, writeDir(t, cardStateFiles(t, map[string][]byte{"2026-11-20": []byte("not read")}), twoLines))
	if code != exitInvalid || !strings.Contains(errOut, "fingerprints.jsonl has 2 lines dated 2026-11-20: card-state/2026-11-20.jsonl is not compared\n") ||
		strings.Contains(errOut, "card-state/2026-11-20.jsonl: broken") || !strings.Contains(errOut, "fingerprints.jsonl line 3: date 2026-11-20 is not after 2026-11-20") {
		t.Errorf("two lines: exit %d\n%s", code, errOut)
	}
	// No fingerprint file: no date, nothing compared.
	code, _, errOut = runDir(t, writeDir(t, cardStateFiles(t, nil), "-"))
	if code != exitInvalid || !strings.Contains(errOut, "fingerprints.jsonl has no line: no card state compared\n") {
		t.Errorf("no fingerprint file: exit %d\n%s", code, errOut)
	}
	// A broken roster: nothing to compare with.
	files := cardStateFiles(t, map[string][]byte{"2026-11-20": []byte("not read")})
	delete(files, "0000000000000000.jsonl")
	if code, _, errOut = runDir(t, writeDir(t, files, cardStateFingerprints)); code != exitInvalid || strings.Contains(errOut, "card-state") {
		t.Errorf("broken roster: exit %d\n%s", code, errOut)
	}
}

func TestCardStateOptionErrors(t *testing.T) {
	dir := writeDir(t, published(5), cardStateFingerprints)
	// A date asked for whose file is not there: the check cannot be made.
	if code, _, errOut := runDir(t, dir, "-card-state", "2026-11-19"); code != exitError || !strings.Contains(errOut, "card-state/2026-11-19.jsonl is not there") {
		t.Errorf("asked, not there: exit %d\n%s", code, errOut)
	}
	if code, _, errOut := runDir(t, dir, "-card-state", "2026-11-31"); code != exitError || !strings.Contains(errOut, "-card-state") {
		t.Errorf("not a date: exit %d\n%s", code, errOut)
	}
	// A roster file has no fingerprint file to give a count.
	if code, _, errOut := runWith(t, lines(longRoster()[:5]), allVerify{}, everyRoot{}, "-card-state", "2026-11-20"); code != exitError || !strings.Contains(errOut, "-card-state") {
		t.Errorf("roster file: exit %d\n%s", code, errOut)
	}
}

// From a URL: the file of the date is asked for by its name.
func TestCardStateURL(t *testing.T) {
	files := under("roster", cardStateFiles(t, map[string][]byte{"2026-11-20": roster.CardStateFile(cardRows(t, 5))}))
	files["roster/"+fingerprintsFileName] = []byte(cardStateFingerprints)
	files["crl/index.jsonl"] = nil
	srv := serveData(t, files)
	code, _, errOut := runData(t, srv.URL)
	if code != exitAllValid || !strings.Contains(errOut, "5 card(s) the same, 0 skipped\n") {
		t.Errorf("exit %d\n%s", code, errOut)
	}
	if !slices.Contains(srv.paths(), "GET roster/card-state/2026-11-20.jsonl") {
		t.Errorf("asked for %q", srv.paths())
	}
}
