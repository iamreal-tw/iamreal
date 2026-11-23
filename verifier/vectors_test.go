package verifier_test

// Tests against the test vectors of spec/vectors/. Every case of every file
// this package covers runs as a subtest.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/verifier"
)

const vectorsDir = "../spec/vectors"

func loadVectors(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func fieldHex(f verifier.Field) string { return "0x" + f.Hex() }

func TestVectorsChallenge(t *testing.T) {
	var v struct {
		Valid []struct {
			RandomBytes            string `json:"random_bytes"`
			Challenge              string `json:"challenge"`
			Date                   string `json:"date"`
			CurrentTime            uint64 `json:"current_time"`
			CurrentTimePublicInput string `json:"current_time_public_input"`
		} `json:"valid"`
		Invalid []struct {
			Challenge string `json:"challenge"`
			Reason    string `json:"reason"`
		} `json:"invalid"`
	}
	loadVectors(t, "challenge.json", &v)
	for _, c := range v.Valid {
		t.Run("valid/"+c.Challenge, func(t *testing.T) {
			d, err := verifier.ParseChallenge(c.Challenge)
			if err != nil {
				t.Fatal(err)
			}
			if d.String() != c.Date {
				t.Errorf("date %s, want %s", d, c.Date)
			}
			raw, _ := hex.DecodeString(c.RandomBytes)
			if got := c.Date + "." + verifier.EncodeBase32(raw); got != c.Challenge {
				t.Errorf("encoding the random bytes gives %s", got)
			}
			if got := verifier.CurrentTime(d); got != c.CurrentTime {
				t.Errorf("current_time %d, want %d", got, c.CurrentTime)
			}
			r := testRecord()
			r.Challenge = c.Challenge
			inputs := publicInputs(t, r)
			if got := inputs[len(inputs)-4].Hex(); got != c.CurrentTimePublicInput {
				t.Errorf("current_time public input %s, want %s", got, c.CurrentTimePublicInput)
			}
		})
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.Reason+"/"+c.Challenge, func(t *testing.T) {
			if _, err := verifier.ParseChallenge(c.Challenge); err == nil {
				t.Errorf("accepted (%s)", c.Reason)
			}
		})
	}
}

var proofLogs = map[string]verifier.ProofLog{"production": verifier.Production, "test": verifier.Test}

func proofLogOf(t *testing.T, name string) verifier.ProofLog {
	t.Helper()
	r, ok := proofLogs[name]
	if !ok {
		t.Fatalf("proof log %q", name)
	}
	return r
}

// scopeOf returns the one accepted scope string of proof log r.
func scopeOf(r verifier.ProofLog) string { return verifier.Scopes(r)[0].String }

// vectorAccount is an account as the vectors write it.
type vectorAccount struct {
	Platform string `json:"platform"`
	Username string `json:"username"`
}

func accountsOf(list []vectorAccount) []verifier.Account {
	out := []verifier.Account{}
	for _, a := range list {
		out = append(out, verifier.Account{Platform: a.Platform, Username: a.Username})
	}
	return out
}

func TestVectorsScope(t *testing.T) {
	var v struct {
		Scopes []struct {
			ProofLog    string `json:"proof_log"`
			ScopeString string `json:"scope_string"`
			Accepted    bool   `json:"accepted"`
			ScopePacked string `json:"scope_packed"`
			Reason      string `json:"reason"`
		} `json:"scopes"`
		Platforms []struct {
			ProofLog    string `json:"proof_log"`
			Platform    string `json:"platform"`
			Accepted    bool   `json:"accepted"`
			DisplayName string `json:"display_name"`
			// UsernameFormat, of an accepted platform: the format as the
			// table writes it. protocol/'s table is checked against the
			// same field (protocol/test/spec.test.ts).
			UsernameFormat string `json:"username_format"`
			Reason         string `json:"reason"`
		} `json:"platforms"`
		Usernames []struct {
			Platform string `json:"platform"`
			Username string `json:"username"`
			Valid    bool   `json:"valid"`
			Reason   string `json:"reason"`
		} `json:"usernames"`
	}
	loadVectors(t, "scope.json", &v)
	for _, c := range v.Scopes {
		t.Run(fmt.Sprintf("scope/%s/%q", c.ProofLog, c.ScopeString), func(t *testing.T) {
			r := proofLogOf(t, c.ProofLog)
			_, accepted := verifier.LookupScope(r, c.ScopeString)
			if accepted != c.Accepted {
				t.Fatalf("accepted %v, want %v (%s)", accepted, c.Accepted, c.Reason)
			}
			// The same answer through the line check.
			rec := testRecord()
			rec.ScopeString = c.ScopeString
			_, err := verifier.ParseLine(rec.Line(), r)
			if (err == nil) != c.Accepted {
				t.Errorf("line check: %v, want accepted %v", err, c.Accepted)
			}
			if c.Accepted {
				p, err := verifier.ScopePacked(c.ScopeString)
				if err != nil {
					t.Fatal(err)
				}
				if fieldHex(p) != c.ScopePacked {
					t.Errorf("scope_packed %s, want %s", fieldHex(p), c.ScopePacked)
				}
			}
		})
	}
	// Every platform each proof log accepts is in the vectors, and no other.
	listed := map[string]int{}
	for _, c := range v.Platforms {
		t.Run(fmt.Sprintf("platform/%s/%q", c.ProofLog, c.Platform), func(t *testing.T) {
			r := proofLogOf(t, c.ProofLog)
			p, accepted := verifier.LookupPlatform(r, c.Platform)
			if accepted != c.Accepted {
				t.Fatalf("accepted %v, want %v (%s)", accepted, c.Accepted, c.Reason)
			}
			if accepted {
				listed[c.ProofLog]++
				if p.DisplayName != c.DisplayName {
					t.Errorf("display name %q, want %q", p.DisplayName, c.DisplayName)
				}
				if c.UsernameFormat == "" || p.UsernameFormat != c.UsernameFormat {
					t.Errorf("username format %q, want %q", p.UsernameFormat, c.UsernameFormat)
				}
			}
			// The same answer through the line check, with a username
			// both formats accept.
			rec := testRecord()
			rec.ScopeString = scopeOf(r)
			rec.Accounts = []verifier.Account{{Platform: c.Platform, Username: "alice"}}
			_, err := verifier.ParseLine(rec.Line(), r)
			if (err == nil) != c.Accepted {
				t.Errorf("line check: %v, want accepted %v", err, c.Accepted)
			}
		})
	}
	for name, r := range proofLogs {
		if n := len(verifier.Platforms(r)); n != listed[name] {
			t.Errorf("the %s log accepts %d platforms, the vectors list %d", name, n, listed[name])
		}
	}
	for _, c := range v.Usernames {
		t.Run(fmt.Sprintf("username/%s/%q", c.Platform, c.Username), func(t *testing.T) {
			p, ok := verifier.LookupPlatform(verifier.Test, c.Platform)
			if !ok {
				t.Fatalf("platform %q", c.Platform)
			}
			if got := p.ValidUsername(c.Username); got != c.Valid {
				t.Errorf("valid %v, want %v (%s)", got, c.Valid, c.Reason)
			}
			rec := testRecord()
			rec.ScopeString = scopeOf(verifier.Test)
			rec.Accounts = []verifier.Account{{Platform: c.Platform, Username: c.Username}}
			_, err := verifier.ParseLine(rec.Line(), verifier.Test)
			if (err == nil) != c.Valid {
				t.Errorf("line check: %v, want valid %v", err, c.Valid)
			}
		})
	}
}

func TestVectorsDeclarationCode(t *testing.T) {
	var v struct {
		Version string `json:"version"`
		Cases   []struct {
			Label                 string          `json:"label"`
			ScopeString           string          `json:"scope_string"`
			Accounts              []vectorAccount `json:"accounts"`
			Challenge             string          `json:"challenge"`
			Preimage              string          `json:"preimage"`
			PreimageSHA256        string          `json:"preimage_sha256"`
			DeclarationCode       string          `json:"declaration_code"`
			DeclarationCodePacked string          `json:"declaration_code_packed"`
		} `json:"cases"`
	}
	loadVectors(t, "declaration-code.json", &v)
	if v.Version != verifier.DeclarationVersion {
		t.Errorf("version %q, want %q", v.Version, verifier.DeclarationVersion)
	}
	for _, c := range v.Cases {
		t.Run(c.Label, func(t *testing.T) {
			accounts := accountsOf(c.Accounts)
			pre := verifier.DeclarationPreimage(c.ScopeString, accounts, c.Challenge)
			if string(pre) != c.Preimage {
				t.Errorf("preimage %q, want %q", pre, c.Preimage)
			}
			sum := sha256.Sum256(pre)
			if got := hex.EncodeToString(sum[:]); got != c.PreimageSHA256 {
				t.Errorf("preimage SHA-256 %s, want %s", got, c.PreimageSHA256)
			}
			code := verifier.DeclarationCode(c.ScopeString, accounts, c.Challenge)
			if code != c.DeclarationCode {
				t.Errorf("code %s, want %s", code, c.DeclarationCode)
			}
			if got := fieldHex(verifier.DeclarationCodePacked(code)); got != c.DeclarationCodePacked {
				t.Errorf("packed %s, want %s", got, c.DeclarationCodePacked)
			}
			// The same value as the last public input rebuilt from a record.
			r := testRecord()
			r.ScopeString, r.Accounts, r.Challenge = c.ScopeString, accounts, c.Challenge
			inputs := publicInputs(t, r)
			if got := fieldHex(inputs[len(inputs)-1]); got != c.DeclarationCodePacked {
				t.Errorf("declaration_code_packed public input %s, want %s", got, c.DeclarationCodePacked)
			}
		})
	}
}

func TestVectorsScopedID(t *testing.T) {
	var v struct {
		FieldModulus string `json:"field_modulus"`
		Encoding     []struct {
			Label             string `json:"label"`
			FieldElement      string `json:"field_element"`
			BytesLittleEndian string `json:"bytes_little_endian"`
			ScopedID          string `json:"scoped_id"`
			ShortID           string `json:"short_id"`
		} `json:"encoding"`
		Invalid []struct {
			ScopedID string `json:"scoped_id"`
			Reason   string `json:"reason"`
		} `json:"invalid"`
		ShortIDInURLs []struct {
			Typed   string  `json:"typed"`
			ReadsAs *string `json:"reads_as"`
			Reason  string  `json:"reason"`
		} `json:"short_id_in_urls"`
	}
	loadVectors(t, "scoped-id.json", &v)
	t.Run("field_modulus", func(t *testing.T) {
		if got := "0x" + fmt.Sprintf("%064x", verifier.FieldModulus); got != v.FieldModulus {
			t.Errorf("p = %s, want %s", got, v.FieldModulus)
		}
	})
	for _, c := range v.Encoding {
		t.Run("encoding/"+c.Label, func(t *testing.T) {
			x, _ := new(big.Int).SetString(strings.TrimPrefix(c.FieldElement, "0x"), 16)
			f, err := verifier.FieldFromBigInt(x)
			if err != nil {
				t.Fatal(err)
			}
			le := make([]byte, 32)
			for i := range le {
				le[i] = f[31-i]
			}
			if got := hex.EncodeToString(le); got != c.BytesLittleEndian {
				t.Errorf("little-endian bytes %s, want %s", got, c.BytesLittleEndian)
			}
			text := verifier.ScopedIDText(f)
			if text != c.ScopedID {
				t.Errorf("text %s, want %s", text, c.ScopedID)
			}
			if got := verifier.ShortID(text); got != c.ShortID {
				t.Errorf("short ID %s, want %s", got, c.ShortID)
			}
			back, err := verifier.ParseScopedID(c.ScopedID)
			if err != nil {
				t.Fatal(err)
			}
			if back != f {
				t.Errorf("parsing gives %s", back.Hex())
			}
			// The nullifier public input rebuilt from a record.
			r := testRecord()
			r.ScopedID = c.ScopedID
			inputs := publicInputs(t, r)
			if got := inputs[len(inputs)-3]; got != f {
				t.Errorf("nullifier public input %s", got.Hex())
			}
		})
	}
	for _, c := range v.Invalid {
		t.Run("invalid/"+c.Reason, func(t *testing.T) {
			if _, err := verifier.ParseScopedID(c.ScopedID); err == nil {
				t.Errorf("accepted %s (%s)", c.ScopedID, c.Reason)
			}
			r := testRecord()
			r.ScopedID = c.ScopedID
			if _, err := verifier.ParseLine(r.Line(), verifier.Production); err == nil {
				t.Errorf("line check accepted it")
			}
		})
	}
	for _, c := range v.ShortIDInURLs {
		t.Run("url/"+c.Typed, func(t *testing.T) {
			got, ok := verifier.ReadShortIDInURL(c.Typed)
			switch {
			case c.ReadsAs == nil && ok:
				t.Errorf("reads as %s, want no short ID (%s)", got, c.Reason)
			case c.ReadsAs != nil && (!ok || got != *c.ReadsAs):
				t.Errorf("reads as %q (%v), want %s", got, ok, *c.ReadsAs)
			}
		})
	}
}

func TestVectorsIssuers(t *testing.T) {
	var v struct {
		Issuers []struct {
			Issuer             string   `json:"issuer"`
			CertificateSHA256  string   `json:"certificate_sha256"`
			ModulusBits        int      `json:"modulus_bits"`
			Exponent           int      `json:"exponent"`
			Modulus            string   `json:"modulus"`
			Limbs              int      `json:"limbs"`
			IssuerModulusLimbs []string `json:"issuer_modulus_limbs"`
		} `json:"issuers"`
	}
	loadVectors(t, "issuers.json", &v)
	compiled := map[string]verifier.Issuer{}
	for _, is := range verifier.Issuers() {
		compiled[is.Name] = is
	}
	if len(compiled) != len(v.Issuers) {
		t.Errorf("%d issuers compiled in, %d in the vectors", len(compiled), len(v.Issuers))
	}
	for _, c := range v.Issuers {
		t.Run(c.Issuer, func(t *testing.T) {
			is, ok := compiled[c.Issuer]
			if !ok {
				t.Fatalf("issuer %s not compiled in", c.Issuer)
			}
			if got := "0x" + is.Modulus.Text(16); got != c.Modulus {
				t.Errorf("modulus differs")
			}
			if is.ModulusBits != c.ModulusBits || is.Modulus.BitLen() != c.ModulusBits {
				t.Errorf("modulus bits %d, want %d", is.ModulusBits, c.ModulusBits)
			}
			if is.CertificateSHA256 != c.CertificateSHA256 {
				t.Errorf("certificate SHA-256 differs")
			}
			if c.Exponent != 65537 {
				t.Errorf("exponent %d", c.Exponent)
			}
			// The circuit of this issuer has this many limbs.
			var circuit verifier.Circuit
			for _, ac := range verifier.AcceptedCircuits() {
				if ac.Issuer == c.Issuer {
					circuit = ac
				}
			}
			if circuit.Limbs != c.Limbs {
				t.Fatalf("circuit %q has %d limbs, want %d", circuit.Name, circuit.Limbs, c.Limbs)
			}
			limbs, err := verifier.ModulusLimbs(is.Modulus, c.Limbs)
			if err != nil {
				t.Fatal(err)
			}
			if len(limbs) != len(c.IssuerModulusLimbs) {
				t.Fatalf("%d limbs, want %d", len(limbs), len(c.IssuerModulusLimbs))
			}
			// And the same limbs come first in the public inputs of a record.
			r := testRecord()
			r.Issuer, r.Circuit = c.Issuer, circuit.VKSHA256
			inputs := publicInputs(t, r)
			for i, want := range c.IssuerModulusLimbs {
				w, _ := new(big.Int).SetString(strings.TrimPrefix(want, "0x"), 16)
				if limbs[i].BigInt().Cmp(w) != 0 || inputs[i].BigInt().Cmp(w) != 0 {
					t.Errorf("limb %d: %s, want %s", i, limbs[i].Hex(), want)
				}
			}
		})
	}
}

// vectorRecord is a record as record.json writes it.
type vectorRecord struct {
	Seq         uint64          `json:"seq"`
	ScopeString string          `json:"scope_string"`
	ScopedID    string          `json:"scoped_id"`
	Accounts    []vectorAccount `json:"accounts"`
	Challenge   string          `json:"challenge"`
	Issuer      string          `json:"issuer"`
	SMTRoot     string          `json:"smt_root"`
	Circuit     string          `json:"circuit"`
	Proof       string          `json:"proof"`
}

// recordVectors is spec/vectors/record.json with its tokens replaced.
type recordVectors struct {
	Version   string            `json:"version"`
	Tokens    map[string]string `json:"tokens"`
	ProofLogs []struct {
		ProofLog string `json:"proof_log"`
		Records  []struct {
			Record         vectorRecord `json:"record"`
			AccountsText   string       `json:"accounts_text"`
			Line           string       `json:"line"`
			PreimageSHA256 string       `json:"preimage_sha256"`
			RecordHash     string       `json:"record_hash"`
		} `json:"records"`
	} `json:"proof_logs"`
	WellFormedLines []struct {
		ProofLog string `json:"proof_log"`
		Line     string `json:"line"`
		Note     string `json:"note"`
	} `json:"well_formed_lines"`
	MalformedLines []struct {
		ProofLog string `json:"proof_log"`
		Line     string `json:"line"`
		Reason   string `json:"reason"`
	} `json:"malformed_lines"`
}

// loadRecordVectors reads record.json and replaces every token, as its note
// says.
func loadRecordVectors(t *testing.T, path string) *recordVectors {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v recordVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	sub := func(s string) string {
		for k, val := range v.Tokens {
			s = strings.ReplaceAll(s, k, val)
		}
		return s
	}
	for i := range v.ProofLogs {
		for j := range v.ProofLogs[i].Records {
			v.ProofLogs[i].Records[j].Line = sub(v.ProofLogs[i].Records[j].Line)
			v.ProofLogs[i].Records[j].Record.Proof = sub(v.ProofLogs[i].Records[j].Record.Proof)
		}
	}
	for i := range v.WellFormedLines {
		v.WellFormedLines[i].Line = sub(v.WellFormedLines[i].Line)
	}
	for i := range v.MalformedLines {
		v.MalformedLines[i].Line = sub(v.MalformedLines[i].Line)
	}
	return &v
}

func TestVectorsRecord(t *testing.T) {
	v := loadRecordVectors(t, filepath.Join(vectorsDir, "record.json"))
	if v.Version != verifier.RecordVersion {
		t.Errorf("version %q", v.Version)
	}
	t.Run("tokens", func(t *testing.T) {
		for _, k := range []string{"@PROOF1@", "@PROOF2@", "@PROOF3@"} {
			r := testRecord()
			r.Proof = v.Tokens[k]
			if _, err := r.ProofBytes(); err != nil {
				t.Errorf("%s: %v", k, err)
			}
		}
		for _, k := range []string{"@PROOF_BADPAD@", "@PROOF_LINEBREAK@", "@PROOF_SHORT@", "@PROOF_NOPAD@"} {
			r := testRecord()
			r.Proof = v.Tokens[k]
			if _, err := r.ProofBytes(); err == nil {
				t.Errorf("%s decodes", k)
			}
		}
	})
	for _, rs := range v.ProofLogs {
		proofLog := proofLogOf(t, rs.ProofLog)
		for _, c := range rs.Records {
			t.Run(fmt.Sprintf("proofLogs/%s/seq%d", rs.ProofLog, c.Record.Seq), func(t *testing.T) {
				cr := c.Record
				r := &verifier.Record{Seq: cr.Seq, ScopeString: cr.ScopeString, ScopedID: cr.ScopedID,
					Accounts: accountsOf(cr.Accounts), Challenge: cr.Challenge, Issuer: cr.Issuer,
					SMTRoot: cr.SMTRoot, Circuit: cr.Circuit, Proof: cr.Proof}
				if got := verifier.AccountsText(r.Accounts); got != c.AccountsText {
					t.Errorf("accounts written %s, want %s", got, c.AccountsText)
				}
				if got := string(r.Line()); got != c.Line {
					t.Errorf("line differs from the template")
				}
				parsed, err := verifier.ParseLine([]byte(c.Line), proofLog)
				if err != nil {
					t.Fatal(err)
				}
				if !parsed.Equal(r) {
					t.Errorf("parsed record differs")
				}
				sum := sha256.Sum256(r.HashPreimage())
				if got := hex.EncodeToString(sum[:]); got != c.PreimageSHA256 {
					t.Errorf("preimage SHA-256 %s, want %s", got, c.PreimageSHA256)
				}
				if got := r.Hash(); got != c.RecordHash {
					t.Errorf("record hash %s, want %s", got, c.RecordHash)
				}
			})
		}
	}
	for i, c := range v.WellFormedLines {
		t.Run(fmt.Sprintf("well_formed/%d", i), func(t *testing.T) {
			r, err := verifier.ParseLine([]byte(c.Line), proofLogOf(t, c.ProofLog))
			if err != nil {
				t.Fatalf("%v (%s)", err, c.Note)
			}
			if !bytes.Equal(r.Line(), []byte(c.Line)) {
				t.Errorf("rewritten line differs")
			}
		})
	}
	for _, c := range v.MalformedLines {
		t.Run("malformed/"+c.Reason, func(t *testing.T) {
			if _, err := verifier.ParseLine([]byte(c.Line), proofLogOf(t, c.ProofLog)); err == nil {
				t.Errorf("accepted (%s)", c.Reason)
			}
		})
	}
	// The proof log fingerprints, v.Files and the published proof log are run by
	// the proof log package, which reads whole files.
}

// testRecord returns a well-formed production record to change one field of.
func testRecord() *verifier.Record {
	return &verifier.Record{
		Seq:         1,
		ScopeString: "iamreal:public:0_______________",
		ScopedID:    "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880",
		Accounts:    []verifier.Account{{Platform: "threads", Username: "alice"}},
		Challenge:   "2026-11-16.000G40R40M30E209185GR38E1W",
		Issuer:      "G3",
		SMTRoot:     "12b47395d98620576c5a8c714a9407c9b2d3a7ff91661f67ffb79c2b03b7ea32",
		Circuit:     "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
		Proof:       base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength)),
	}
}

// publicInputs rebuilds the public inputs of r with the production issuer
// table. It does not run bb.
func publicInputs(t *testing.T, r *verifier.Record) []verifier.Field {
	t.Helper()
	_, inputs, err := verifier.PublicInputs(r)
	if err != nil {
		t.Fatal(err)
	}
	return inputs
}
