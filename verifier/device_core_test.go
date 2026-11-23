package verifier_test

// The requests device-core/ made (device-core/prover/tests/proof.rs), each
// verified as the record it would become. That test runs this one, with
// IAMREAL_DEVICE_REQUESTS naming the file it wrote and IAMREAL_BB naming bb;
// without the first it is skipped.

import (
	"encoding/json"
	"math/big"
	"os"
	"testing"

	"github.com/iamreal-tw/iamreal/verifier"
)

type deviceCoreRequests struct {
	// The moduli of the test keys the proofs were made under, in hex.
	Issuers  map[string]string `json:"issuers"`
	Requests []struct {
		ScopeString string          `json:"scope_string"`
		ScopedID    string          `json:"scoped_id"`
		Accounts    []vectorAccount `json:"accounts"`
		Challenge   string          `json:"challenge"`
		Issuer      string          `json:"issuer"`
		SMTRoot     string          `json:"smt_root"`
		Circuit     string          `json:"circuit"`
		Proof       string          `json:"proof"`
	} `json:"requests"`
}

func TestDeviceCoreRequests(t *testing.T) {
	path := os.Getenv("IAMREAL_DEVICE_REQUESTS")
	if path == "" {
		t.Skip("IAMREAL_DEVICE_REQUESTS is not set: device-core/'s proof test sets it")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d deviceCoreRequests
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	if len(d.Requests) == 0 {
		t.Fatal("no requests")
	}
	moduli := map[string]*big.Int{}
	for name, hex := range d.Issuers {
		m, ok := new(big.Int).SetString(hex, 16)
		if !ok {
			t.Fatal("bad modulus")
		}
		moduli[name] = m
	}
	v, err := verifier.NewWithIssuers(verifier.Config{BB: bbPath(t), CRSDir: crsDir(t)}, moduli)
	if err != nil {
		t.Fatal(err)
	}
	production, err := verifier.New(verifier.Config{BB: bbPath(t), CRSDir: crsDir(t)})
	if err != nil {
		t.Fatal(err)
	}
	for i, q := range d.Requests {
		r := &verifier.Record{
			Seq: 1, ScopeString: q.ScopeString, ScopedID: q.ScopedID,
			Accounts: accountsOf(q.Accounts), Challenge: q.Challenge, Issuer: q.Issuer,
			SMTRoot: q.SMTRoot, Circuit: q.Circuit, Proof: q.Proof,
		}
		proofLog := verifier.Test
		if _, ok := verifier.LookupScope(verifier.Production, q.ScopeString); ok {
			proofLog = verifier.Production
		}
		if _, err := verifier.ParseLine(r.Line(), proofLog); err != nil {
			t.Fatalf("request %d is not a well-formed record: %v", i, err)
		}
		if err := v.VerifyRecord(r); err != nil {
			t.Errorf("request %d does not verify: %v", i, err)
		}
		// The proof is tied to the list: with another, it is rejected.
		other := *r
		other.Accounts = append([]verifier.Account{}, r.Accounts...)
		if len(other.Accounts) > 0 {
			other.Accounts = other.Accounts[:len(other.Accounts)-1]
		} else {
			other.Accounts = accountsOf([]vectorAccount{{Platform: "threads", Username: "alice"}})
		}
		if err := v.VerifyRecord(&other); !isRejection(err) {
			t.Errorf("request %d with another list: %v, want a rejection", i, err)
		}
		// It was made under a test key: the verifier of the program rejects it.
		if err := production.VerifyRecord(r); !isRejection(err) {
			t.Errorf("request %d under MOICA's keys: %v, want a rejection", i, err)
		}
	}
	t.Logf("verified %d requests", len(d.Requests))
}
