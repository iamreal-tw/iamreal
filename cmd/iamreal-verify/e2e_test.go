//go:build iamrealtest

package main

// The test log of testdata/ through the command with its real proofs,
// checked by bb, and the CRL archive of testdata/. The issuer keys of the
// test proofs reach the verifier through verifier.NewWithIssuers, which
// exists only with the build tag iamrealtest:
//
//	IAMREAL_BB=<bb 6.0.0> go test -tags iamrealtest ./cmd/iamreal-verify
//
// Without IAMREAL_BB the test is skipped. IAMREAL_CRS may name a directory
// holding bn254_g1.dat; without it the test writes that file (the point
// (1, 2)) itself, and verifier.New checks its SHA-256 either way.

import (
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

func TestEndToEnd(t *testing.T) {
	bb := os.Getenv("IAMREAL_BB")
	if bb == "" {
		t.Skip("IAMREAL_BB is not set: no bb to run")
	}
	crs := os.Getenv("IAMREAL_CRS")
	if crs == "" {
		crs = t.TempDir()
		point := make([]byte, 64)
		point[31], point[63] = 1, 2
		if err := os.WriteFile(filepath.Join(crs, verifier.CRSFile), point, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keys, err := testIssuerKeys()
	if err != nil {
		t.Fatal(err)
	}
	moduli := map[string]*big.Int{}
	for _, k := range keys {
		moduli[k.Name] = k.Key.N
	}
	mk := func(cfg verifier.Config) (prooflog.ProofVerifier, error) { return verifier.NewWithIssuers(cfg, moduli) }
	runArchiveCases(t, mk, "-bb", bb, "-crs", crs)

	// With the issuer keys compiled into the program, every proof fails.
	proofLogFile := filepath.Join("testdata", "proof-log.jsonl")
	a := []string{"-bb", bb, "-crs", crs, "-proof-log", "test", "-crl-archive", filepath.Join("testdata", "archive"), proofLogFile}
	var out, errOut strings.Builder
	prod := func(cfg verifier.Config) (prooflog.ProofVerifier, error) { return verifier.New(cfg) }
	if code := run(a, &out, &errOut, deps{prod, openArchive(testIssuerKeys)}); code != exitInvalid ||
		strings.Count(out.String(), "invalid proof") != 3 {
		t.Errorf("MOICA's keys: exit %d\n%s\n%s", code, out.String(), errOut.String())
	}
}
