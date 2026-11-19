package verifier

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func wellFormed() *Record {
	return &Record{
		Seq: 1, ScopeString: "iamreal:public:0_______________",
		ScopedID:  "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880",
		Accounts:  []Account{{"threads", "alice"}},
		Challenge: "2026-11-16.000G40R40M30E209185GR38E1W", Issuer: "G3",
		SMTRoot: "12b47395d98620576c5a8c714a9407c9b2d3a7ff91661f67ffb79c2b03b7ea32",
		Circuit: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
		Proof:   base64.StdEncoding.EncodeToString(make([]byte, ProofLength)),
	}
}

// A retired scope (spec/scope.md): records up to its last seq are well
// formed, later ones are not.
func TestRetiredScope(t *testing.T) {
	saved := productionScopes[0].LastSeq
	defer func() { productionScopes[0].LastSeq = saved }()
	productionScopes[0].LastSeq = 5
	r := wellFormed()
	r.Seq = 5
	if _, err := ParseLine(r.Line(), Production); err != nil {
		t.Errorf("seq 5: %v", err)
	}
	r.Seq = 6
	if _, err := ParseLine(r.Line(), Production); err == nil {
		t.Errorf("seq 6 accepted after the scope retired at 5")
	}
}

// Every scope string of the tables is 31 bytes, matches the format of
// spec/scope.md, and test and production never share one.
func TestScopeTables(t *testing.T) {
	seen := map[string]bool{}
	for _, sc := range append(append([]Scope(nil), productionScopes...), testScopes...) {
		if len(sc.String) != ScopeStringLength {
			t.Errorf("%q: %d bytes", sc.String, len(sc.String))
		}
		if seen[sc.String] {
			t.Errorf("%q in both tables", sc.String)
		}
		seen[sc.String] = true
	}
}

// Every platform ID matches the format of spec/scope.md (so it has no `:`,
// `"` or line feed), appears once, and the production table has no ID
// starting with "test-". Platforms returns the IDs in ascending order.
func TestPlatformTables(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range append(append([]Platform(nil), productionPlatforms...), testPlatforms...) {
		if !usernameOf(p.ID, 21, func(c byte) bool { return c == '-' }) {
			t.Errorf("%q: not a platform ID", p.ID)
		}
		if seen[p.ID] {
			t.Errorf("%q twice", p.ID)
		}
		seen[p.ID] = true
	}
	for _, p := range productionPlatforms {
		if len(p.ID) >= 5 && p.ID[:5] == "test-" {
			t.Errorf("%q in the production table", p.ID)
		}
	}
	for _, r := range []Roster{Production, Test} {
		ps := Platforms(r)
		for i := 1; i < len(ps); i++ {
			if !(ps[i-1].ID < ps[i].ID) {
				t.Errorf("%s: %q before %q", r, ps[i-1].ID, ps[i].ID)
			}
		}
	}
	if len(Platforms(Test)) != len(productionPlatforms)+len(testPlatforms) {
		t.Errorf("a test roster accepts %d platforms", len(Platforms(Test)))
	}
}

// Every single-byte change inside the account list of a well-formed test
// line with two accounts is rejected or gives another well-formed line
// written exactly as its template.
func TestSingleByteChangesInAccounts(t *testing.T) {
	r := wellFormed()
	r.ScopeString = "iamreal-test:public:0__________"
	r.Accounts = []Account{{"test-example", "a-b"}, {"threads", "alice"}}
	line := r.Line()
	text := AccountsText(r.Accounts)
	start := bytes.Index(line, []byte(text)) - 1 // from the `:` before `[`
	for i := start; i <= start+len(text)+1; i++ {
		for _, c := range []byte{0, '\n', ' ', '"', '\\', '[', ']', '{', '}', ',', ':', 'a', 'A', '-', '.', '_', 0xff} {
			b := append([]byte(nil), line...)
			b[i] = c
			got, err := ParseLine(b, Test)
			if err == nil && string(got.Line()) != string(b) {
				t.Fatalf("byte %d to %q: accepted, not its template", i, c)
			}
		}
	}
}

// Check 1 without bb: the circuit must be accepted and go with the issuer.
func TestPublicInputsCircuitAndIssuer(t *testing.T) {
	r := wellFormed()
	if _, in, err := PublicInputs(r); err != nil || len(in) != 40 {
		t.Fatalf("G3: %d inputs, %v", len(in), err)
	}
	r.Issuer = "G2"
	if _, _, err := PublicInputs(r); err == nil {
		t.Errorf("G2 with the G3 circuit accepted")
	}
	r.Circuit = "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8"
	if _, in, err := PublicInputs(r); err != nil || len(in) != 23 {
		t.Errorf("G2: %d inputs, %v", len(in), err)
	}
	r.Circuit = "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac9"
	if _, _, err := PublicInputs(r); err == nil {
		t.Errorf("unknown circuit accepted")
	}
}

// Whatever ParseLine accepts is written exactly as the template: the
// accepted bytes are the rewritten line.
func FuzzParseLine(f *testing.F) {
	f.Add(wellFormed().Line())
	f.Add([]byte(`{"seq": 1}` + "\n"))
	f.Fuzz(func(t *testing.T, line []byte) {
		r, err := ParseLine(line, Production)
		if err != nil {
			return
		}
		if got := r.Line(); string(got) != string(line) {
			t.Fatalf("accepted a line that is not its template:\n%q\n%q", line, got)
		}
		if err := r.CheckValues(Production); err != nil {
			t.Fatal(err)
		}
	})
}

// Every single-byte change of a well-formed line is rejected or gives
// another well-formed line written exactly as its template.
func TestSingleByteChanges(t *testing.T) {
	line := wellFormed().Line()
	// Only the part before the proof: the proof is 19,544 characters of the
	// same kind.
	head := len(line) - ProofTextLength - 3
	accepted := 0
	for i := 0; i < head; i++ {
		for _, c := range []byte{0, '\n', ' ', '"', '\\', '0', '1', 'a', 'A', 'G', 'f', ':', ',', '_', 0xff} {
			b := append([]byte(nil), line...)
			b[i] = c
			r, err := ParseLine(b, Production)
			if err == nil {
				accepted++
				if string(r.Line()) != string(b) {
					t.Fatalf("byte %d to %q: accepted, not its template", i, c)
				}
			}
		}
	}
	t.Logf("%d of %d changes give another well-formed line", accepted, head*15)
}
