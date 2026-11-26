package verifier_test

// Tests with real proofs (testdata/, see its README.md) and the bb executable.
// They run when IAMREAL_BB names a bb 6.0.0 executable, and are skipped
// otherwise. IAMREAL_CRS may name a directory holding bn254_g1.dat; without
// it the tests write that file (the 64-byte point (1, 2)) themselves, and
// verifier.New checks it against its SHA-256 either way.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

type proofCase struct {
	Circuit         string          `json:"circuit"`
	Issuer          string          `json:"issuer"`
	Accounts        []vectorAccount `json:"accounts"`
	Challenge       string          `json:"challenge"`
	DeclarationCode string          `json:"declaration_code"`
	IssuerModulus   string          `json:"issuer_modulus"`
	Nullifier       string          `json:"nullifier"`
}

type proofData struct {
	CircuitsCommit string      `json:"circuits_commit"`
	ScopeString    string      `json:"scope_string"`
	SMTRoot        string      `json:"smt_root"`
	Records        []proofCase `json:"records"`
}

func bbPath(t *testing.T) string {
	t.Helper()
	bb := os.Getenv("IAMREAL_BB")
	if bb == "" {
		t.Skip("IAMREAL_BB is not set: no bb to run")
	}
	return bb
}

func crsDir(t *testing.T) string {
	t.Helper()
	if dir := os.Getenv("IAMREAL_CRS"); dir != "" {
		return dir
	}
	dir := t.TempDir()
	point := make([]byte, 64)
	point[31], point[63] = 1, 2
	if err := os.WriteFile(filepath.Join(dir, verifier.CRSFile), point, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func loadProofs(t *testing.T) *proofData {
	t.Helper()
	b, err := os.ReadFile("testdata/proofs.json")
	if err != nil {
		t.Fatal(err)
	}
	var d proofData
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	return &d
}

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// testVerifier returns a verifier whose issuer table holds the throwaway
// issuer keys of the test proofs.
func testVerifier(t *testing.T, d *proofData, cfg verifier.Config) *verifier.Verifier {
	t.Helper()
	moduli := map[string]*big.Int{}
	for _, r := range d.Records {
		m, ok := new(big.Int).SetString(strings.TrimPrefix(r.IssuerModulus, "0x"), 16)
		if !ok {
			t.Fatal("bad modulus")
		}
		moduli[r.Issuer] = m
	}
	if cfg.BB == "" {
		cfg.BB = bbPath(t)
	}
	if cfg.CRSDir == "" {
		cfg.CRSDir = crsDir(t)
	}
	v, err := verifier.NewWithIssuers(cfg, moduli)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// records returns the test proofs as the records of a test log.
func records(t *testing.T, d *proofData) []*verifier.Record {
	t.Helper()
	var out []*verifier.Record
	for i, p := range d.Records {
		n, _ := new(big.Int).SetString(p.Nullifier, 16)
		f, _ := verifier.FieldFromBigInt(n)
		c := circuitOf(t, p.Circuit)
		r := &verifier.Record{
			Seq: uint64(i + 1), ScopeString: d.ScopeString, ScopedID: verifier.ScopedIDText(f),
			Accounts: accountsOf(p.Accounts), Challenge: p.Challenge, Issuer: p.Issuer,
			SMTRoot: d.SMTRoot, Circuit: c.VKSHA256,
			Proof: base64.StdEncoding.EncodeToString(readTestdata(t, p.Circuit+".proof")),
		}
		if _, err := verifier.ParseLine(r.Line(), verifier.Test); err != nil {
			t.Fatalf("record %d is not well formed: %v", i+1, err)
		}
		out = append(out, r)
	}
	return out
}

func circuitOf(t *testing.T, name string) verifier.Circuit {
	t.Helper()
	for _, c := range verifier.AcceptedCircuits() {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("no circuit %s", name)
	return verifier.Circuit{}
}

func isRejection(err error) bool {
	var rej *verifier.Rejection
	return errors.As(err, &rej)
}

func TestRealProofVerifies(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{})
	for i, r := range records(t, d) {
		p := d.Records[i]
		t.Run(p.Circuit, func(t *testing.T) {
			if err := v.VerifyRecord(r); err != nil {
				t.Fatalf("does not verify: %v", err)
			}
			// The rebuilt public inputs are byte for byte those bb wrote when
			// it made the proof.
			_, inputs, err := v.PublicInputs(r)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(verifier.EncodePublicInputs(inputs), readTestdata(t, p.Circuit+".public_inputs")) {
				t.Errorf("rebuilt public inputs differ from bb's")
			}
			if got := verifier.DeclarationCode(r.ScopeString, r.Accounts, r.Challenge); got != p.DeclarationCode {
				t.Errorf("declaration code %s, want %s", got, p.DeclarationCode)
			}
		})
	}
}

func TestRealProofProductionIssuersReject(t *testing.T) {
	d := loadProofs(t)
	v, err := verifier.New(verifier.Config{BB: bbPath(t), CRSDir: crsDir(t)})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range records(t, d) {
		if err := v.VerifyRecord(r); !isRejection(err) {
			t.Errorf("%s: a proof under a test issuer key: %v, want a rejection", r.Issuer, err)
		}
	}
}

// Each public input changed by one (mod p) is rejected.
func TestRealProofEachPublicInputChanged(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{})
	for i, r := range records(t, d) {
		p := d.Records[i]
		t.Run(p.Circuit, func(t *testing.T) {
			c, inputs, err := v.PublicInputs(r)
			if err != nil {
				t.Fatal(err)
			}
			proof := readTestdata(t, p.Circuit+".proof")
			if err := v.VerifyProof(c, proof, inputs); err != nil {
				t.Fatalf("unchanged inputs: %v", err)
			}
			for j := range inputs {
				changed := append([]verifier.Field(nil), inputs...)
				x := new(big.Int).Add(changed[j].BigInt(), big.NewInt(1))
				x.Mod(x, verifier.FieldModulus)
				changed[j], _ = verifier.FieldFromBigInt(x)
				if err := v.VerifyProof(c, proof, changed); !isRejection(err) {
					t.Errorf("input %d changed: %v, want a rejection", j, err)
				}
			}
			// The same through a value below p, or one of the count, is
			// rejected before bb runs.
			high := append([]verifier.Field(nil), inputs...)
			high[c.Limbs], _ = verifier.FieldFromBigInt(new(big.Int).Add(high[c.Limbs].BigInt(), verifier.FieldModulus))
			if err := v.VerifyProof(c, proof, high); !isRejection(err) {
				t.Errorf("smt_root + p: %v", err)
			}
			if err := v.VerifyProof(c, proof, inputs[:len(inputs)-1]); !isRejection(err) {
				t.Errorf("one input fewer: %v", err)
			}
			if err := v.VerifyProof(c, proof, append(inputs, verifier.Field{})); !isRejection(err) {
				t.Errorf("one input more: %v", err)
			}
		})
	}
}

// Changing any field of the record the public inputs come from is rejected.
func TestRealProofEachRecordFieldChanged(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{})
	other := map[string]string{"G2": "G3", "G3": "G2"}
	for i, r := range records(t, d) {
		t.Run(d.Records[i].Circuit, func(t *testing.T) {
			changes := map[string]func(r *verifier.Record){
				"issuer and circuit": func(r *verifier.Record) {
					r.Issuer = other[r.Issuer]
					r.Circuit = circuitOf(t, d.Records[1-i].Circuit).VKSHA256
				},
				"issuer only":      func(r *verifier.Record) { r.Issuer = other[r.Issuer] },
				"circuit only":     func(r *verifier.Record) { r.Circuit = circuitOf(t, d.Records[1-i].Circuit).VKSHA256 },
				"circuit unknown":  func(r *verifier.Record) { r.Circuit = strings.Repeat("ab", 32) },
				"smt_root":         func(r *verifier.Record) { r.SMTRoot = strings.Repeat("0", 63) + "1" },
				"challenge date":   func(r *verifier.Record) { r.Challenge = "2026-11-17" + r.Challenge[10:] },
				"challenge random": func(r *verifier.Record) { r.Challenge = r.Challenge[:11] + "00000000000000000000000000" },
				"scoped_id":        func(r *verifier.Record) { r.ScopedID = "0400000000000000000000000000000000000000000000000000" },
				"scope_string":     func(r *verifier.Record) { r.ScopeString = "iamreal:public:0_______________" },
				"a username": func(r *verifier.Record) {
					r.Accounts[len(r.Accounts)-1].Username = "bob"
				},
				"an account moved to another platform": func(r *verifier.Record) {
					a := r.Accounts[len(r.Accounts)-1]
					r.Accounts = []verifier.Account{{Platform: "test-example", Username: a.Username}}
				},
				"one account fewer": func(r *verifier.Record) { r.Accounts = r.Accounts[1:] },
				"one account more": func(r *verifier.Record) {
					r.Accounts = append([]verifier.Account{{Platform: "test-example", Username: "c-d"}}, r.Accounts[len(r.Accounts)-1:]...)
				},
				"the accounts in the other order": func(r *verifier.Record) {
					if len(r.Accounts) == 2 {
						r.Accounts = []verifier.Account{r.Accounts[1], r.Accounts[0]}
					} else {
						r.Accounts = append(r.Accounts, verifier.Account{Platform: "aaa", Username: "x"})
					}
				},
				"the empty list": func(r *verifier.Record) { r.Accounts = nil },
			}
			for name, change := range changes {
				c := *r
				c.Accounts = append([]verifier.Account(nil), r.Accounts...)
				change(&c)
				if err := v.VerifyRecord(&c); !isRejection(err) {
					t.Errorf("%s changed: %v, want a rejection", name, err)
				}
			}
		})
	}
}

func TestRealProofBytesChanged(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{})
	bb := bbPath(t)
	for i, r := range records(t, d) {
		p := d.Records[i]
		t.Run(p.Circuit, func(t *testing.T) {
			c, inputs, _ := v.PublicInputs(r)
			proof := readTestdata(t, p.Circuit+".proof")
			short := proof[:len(proof)-1]
			long := append(append([]byte(nil), proof...), 0)
			for name, b := range map[string][]byte{"one byte fewer": short, "one byte more": long} {
				if err := v.VerifyProof(c, b, inputs); !isRejection(err) {
					t.Errorf("%s: %v, want a rejection", name, err)
				}
				// bb alone, without the length check, for the record.
				ok, out := rawBB(t, bb, c, b, inputs, "noir-recursive")
				t.Logf("%s, bb alone: verified=%v (%s)", name, ok, out)
			}
			// One byte changed: the first and last byte, and one in every
			// 32-byte word (a different byte of each word).
			positions := []int{0, len(proof) - 1}
			for w := 0; w < len(proof)/32; w++ {
				positions = append(positions, 32*w+w%32)
			}
			for _, pos := range positions {
				b := append([]byte(nil), proof...)
				b[pos] ^= 0x01
				if err := v.VerifyProof(c, b, inputs); !isRejection(err) {
					t.Errorf("byte %d changed: %v, want a rejection", pos, err)
				}
			}
			t.Logf("%d single-byte changes rejected", len(positions))
		})
	}
}

func TestRealProofNotZeroKnowledge(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{})
	bb := bbPath(t)
	for i, r := range records(t, d) {
		p := d.Records[i]
		t.Run(p.Circuit, func(t *testing.T) {
			c, inputs, _ := v.PublicInputs(r)
			noZK := readTestdata(t, p.Circuit+".no-zk.proof")
			if len(noZK) != 13120 {
				t.Fatalf("non-zero-knowledge proof of %d bytes", len(noZK))
			}
			// It is a real proof: under the setting it was made for, bb
			// accepts it with the same key and inputs.
			if ok, out := rawBB(t, bb, c, noZK, inputs, "noir-recursive-no-zk"); !ok {
				t.Fatalf("bb -t noir-recursive-no-zk rejects it: %s", out)
			}
			// The verifier rejects it: by its length, before bb.
			if err := v.VerifyProof(c, noZK, inputs); !isRejection(err) {
				t.Errorf("verifier: %v, want a rejection", err)
			}
			// bb with -t noir-recursive rejects it too.
			if ok, out := rawBB(t, bb, c, noZK, inputs, "noir-recursive"); ok {
				t.Errorf("bb -t noir-recursive accepts it: %s", out)
			}
			// Padded with zeros to 14,656 bytes, it passes the length check
			// and bb rejects it.
			padded := append(append([]byte(nil), noZK...), make([]byte, verifier.ProofLength-len(noZK))...)
			if err := v.VerifyProof(c, padded, inputs); !isRejection(err) {
				t.Errorf("padded: %v, want a rejection", err)
			}
			// And as a record: its base64 is not 19,544 characters, so the
			// line is malformed.
			bad := *r
			bad.Proof = base64.StdEncoding.EncodeToString(noZK)
			if _, err := verifier.ParseLine(bad.Line(), verifier.Test); err == nil {
				t.Errorf("a record with the non-zero-knowledge proof is well formed")
			}
			if err := v.VerifyRecord(&bad); !isRejection(err) {
				t.Errorf("VerifyRecord: %v, want a rejection", err)
			}
		})
	}
}

// Random proofs: whatever bb does (fail, crash, hang), the outcome is a
// rejection and the test process carries on.
func TestRandomProof(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{Timeout: 10 * time.Second})
	for i, r := range records(t, d) {
		p := d.Records[i]
		t.Run(p.Circuit, func(t *testing.T) {
			c, inputs, _ := v.PublicInputs(r)
			outcomes := map[string]int{}
			for n := 0; n < 40; n++ {
				b := make([]byte, verifier.ProofLength)
				rand.Read(b)
				if n%2 == 1 {
					// Every 32-byte word below 2^252, so below p: bb's field
					// checks pass and it reaches the curve points.
					for w := 0; w < len(b); w += 32 {
						b[w] &= 0x0f
					}
				}
				err := v.VerifyProof(c, b, inputs)
				if !isRejection(err) {
					t.Fatalf("random proof: %v, want a rejection", err)
				}
				outcomes[outcomeOf(err)]++
			}
			t.Logf("outcomes of bb on 40 random proofs: %v", outcomes)
		})
	}
}

func outcomeOf(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "signal"):
		return s[strings.Index(s, "signal"):strings.Index(s, ")")]
	case strings.Contains(s, "exit status"):
		return s[strings.Index(s, "exit status"):strings.Index(s, ")")]
	}
	return s
}

// A bb that crashes or hangs: both are rejections, and the verifier keeps
// working. Each fake bb first waits a second, as a process can take to start
// on a loaded machine (#220): longer than the timeout the hanging ones get.
// What is checked does not depend on how long anything took, but for the
// last bound, which only tells a bb stopped at its timeout from one waited
// for to the end of its 30 seconds.
func TestBBCrashAndTimeout(t *testing.T) {
	d := loadProofs(t)
	dir := t.TempDir()
	script := func(name, body string) string {
		path := filepath.Join(dir, name)
		src := "#!/bin/sh\nsleep 1\nif [ \"$1\" = --version ]; then echo 6.0.0; exit 0; fi\n" + body + "\n"
		if err := os.WriteFile(path, []byte(src), 0o755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	const (
		crashes = "bb verify failed"
		hangs   = "bb verify did not finish"
	)
	cases := []struct {
		name, body string
		// The timeout of the verifier: none to speak of for a bb that crashes, so that it crashes however slowly it starts.
		timeout time.Duration
		want    string
	}{
		{"abort", "kill -ABRT $$", 0, crashes},
		{"segfault", "kill -SEGV $$", 0, crashes},
		{"exit 134", "exit 134", 0, crashes},
		{"hang", "exec sleep 30", 500 * time.Millisecond, hangs},
		{"hang, child holds pipe", "sleep 30", 500 * time.Millisecond, hangs},
	}
	r := records(t, d)[0]
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			// Making the verifier runs bb --version, which takes the second too: it is not held to the per-proof timeout.
			v := testVerifier(t, d, verifier.Config{BB: script(strings.ReplaceAll(c.name, " ", "_"), c.body), Timeout: c.timeout})
			start := time.Now()
			err := v.VerifyRecord(r)
			var rej *verifier.Rejection
			if !errors.As(err, &rej) || !strings.HasPrefix(rej.Reason, c.want) {
				t.Fatalf("%v, want a rejection %q", err, c.want)
			}
			if el := time.Since(start); el > 20*time.Second {
				t.Errorf("took %v: waited for the child's 30 seconds", el)
			}
			t.Logf("%v", err)
		})
	}
}

func TestNewChecksBBAndCRS(t *testing.T) {
	d := loadProofs(t)
	bb := bbPath(t)
	dir := t.TempDir()
	wrongVersion := filepath.Join(dir, "bb5")
	os.WriteFile(wrongVersion, []byte("#!/bin/sh\necho 5.0.0\n"), 0o755)
	if _, err := verifier.New(verifier.Config{BB: wrongVersion, CRSDir: crsDir(t)}); err == nil {
		t.Errorf("bb of another version accepted")
	}
	if _, err := verifier.New(verifier.Config{BB: filepath.Join(dir, "missing"), CRSDir: crsDir(t)}); err == nil {
		t.Errorf("missing bb accepted")
	}
	if _, err := verifier.New(verifier.Config{BB: bb, CRSDir: t.TempDir()}); err == nil {
		t.Errorf("missing CRS accepted")
	}
	bad := t.TempDir()
	point := make([]byte, 64)
	point[31], point[63] = 1, 3
	os.WriteFile(filepath.Join(bad, verifier.CRSFile), point, 0o600)
	if _, err := verifier.New(verifier.Config{BB: bb, CRSDir: bad}); err == nil {
		t.Errorf("CRS file with another SHA-256 accepted")
	}
	// The right files work.
	_ = testVerifier(t, d, verifier.Config{})
}

// The test proofs as a test log file, through the record rules.
func TestRealProofProofLog(t *testing.T) {
	d := loadProofs(t)
	v := testVerifier(t, d, verifier.Config{})
	var file []byte
	for _, r := range records(t, d) {
		file = append(file, r.Line()...)
	}
	date := func(s string) verifier.Date { x, _ := verifier.ParseDate(s); return x }
	archive := fakeArchive{d.SMTRoot: {date("2026-11-16"), date("2027-01-01")}}
	rep, err := prooflog.Check(file, verifier.Test, v, archive)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Broken != nil {
		t.Fatalf("broken: %v", rep.Broken)
	}
	var got []string
	for _, res := range rep.State.Records {
		var kinds []string
		for _, k := range res.Kinds {
			kinds = append(kinds, k.Platform+" "+k.Kind)
		}
		got = append(got, strings.Join(kinds, " ")+res.Reason)
	}
	if want := "test-example first threads first,test-example withdraw threads refresh"; strings.Join(got, ",") != want {
		t.Errorf("results %v, want %s", got, want)
	}
	if s := rep.State.Scopes; len(s) != 1 || len(s[0].Cards) != 1 ||
		verifier.AccountsText(s[0].Cards[0].Accounts) != `[{"platform":"threads","username":"alice"}]` ||
		s[0].Cards[0].LastCardProof.String() != "2027-01-01" || len(s[0].Accounts) != 1 ||
		s[0].Accounts[0].Platform != "threads" || s[0].Accounts[0].Username != "alice" {
		t.Errorf("state %+v", rep.State.Scopes)
	}
	// In a production log the test scope makes the file broken.
	if rep, _ := prooflog.Check(file, verifier.Production, v, archive); rep.Broken == nil || rep.Broken.Code != prooflog.CodeLine {
		t.Errorf("production log: %+v", rep)
	}
	// With no CRL behind the root, check 3 fails.
	rep, _ = prooflog.Check(file, verifier.Test, v, fakeArchive{})
	for _, res := range rep.State.Records {
		if res.Reason != prooflog.CodeRoot {
			t.Errorf("seq %d: %+v, want root", res.Seq, res)
		}
	}
	// Under the issuer keys compiled into the program, both are `proof`.
	prod, err := verifier.New(verifier.Config{BB: bbPath(t), CRSDir: crsDir(t)})
	if err != nil {
		t.Fatal(err)
	}
	rep, _ = prooflog.Check(file, verifier.Test, prod, archive)
	for _, res := range rep.State.Records {
		if res.Reason != prooflog.CodeProof {
			t.Errorf("seq %d: %+v, want proof", res.Seq, res)
		}
	}
}

type fakeArchive map[string][]verifier.Date

func (a fakeArchive) CRLDates(issuer, root string) ([]verifier.Date, error) { return a[root], nil }

// rawBB runs bb verify directly, with no checks around it.
func rawBB(t *testing.T, bb string, c verifier.Circuit, proof []byte, inputs []verifier.Field, setting string) (bool, string) {
	t.Helper()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "vk"), c.VerificationKey(), 0o600)
	os.WriteFile(filepath.Join(dir, "proof"), proof, 0o600)
	os.WriteFile(filepath.Join(dir, "public_inputs"), verifier.EncodePublicInputs(inputs), 0o600)
	cmd := exec.Command(bb, "verify", "-k", filepath.Join(dir, "vk"), "-p", filepath.Join(dir, "proof"),
		"-i", filepath.Join(dir, "public_inputs"), "-c", crsDir(t), "-t", setting)
	out, err := cmd.CombinedOutput()
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return err == nil, lines[len(lines)-1]
}
