package crl

import (
	"bytes"
	"encoding/hex"
	"errors"
	"regexp"
	"testing"
)

// spec/vectors/crl-patch.json, the answers every reader of CRL patches is
// tested with (TypeScript's too, worker/test/crl-patch.test.ts).
type patchVectors struct {
	Usable []struct {
		Label, Previous, Patch, File, Name string
	}
	Unusable []struct {
		Label, Previous, Patch string
		Name                   *string
	}
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// patchFile is the SHA-256 of the file a patch's name says it gives.
var patchFile = regexp.MustCompile(`^[0-9a-f]{64}-([0-9a-f]{64})\.patch$`)

func TestPatchVectors(t *testing.T) {
	var v patchVectors
	readJSON(t, "../spec/vectors/crl-patch.json", &v)
	if len(v.Usable) < 8 || len(v.Unusable) < 10 {
		t.Fatalf("%d usable, %d unusable", len(v.Usable), len(v.Unusable))
	}
	for _, c := range v.Usable {
		previous, file := unhex(t, c.Previous), unhex(t, c.File)
		got, err := ApplyPatch(previous, unhex(t, c.Patch))
		if err != nil || !bytes.Equal(got, file) {
			t.Errorf("%s: gives %x, %v; want %x", c.Label, got, err, file)
		}
		if name := PatchName(sha256Hex(previous), sha256Hex(file)); name != c.Name {
			t.Errorf("%s: name %s, want %s", c.Label, name, c.Name)
		}
		m := patchFile.FindStringSubmatch(c.Name)
		if got, err := RestorePatch(previous, unhex(t, c.Patch), m[1]); err != nil || !bytes.Equal(got, file) {
			t.Errorf("%s: restores %x, %v; want %x", c.Label, got, err, file)
		}
	}
	for _, c := range v.Unusable {
		previous, patch := unhex(t, c.Previous), unhex(t, c.Patch)
		var err error
		if c.Name == nil {
			_, err = ApplyPatch(previous, patch)
		} else {
			_, err = RestorePatch(previous, patch, patchFile.FindStringSubmatch(*c.Name)[1])
		}
		var u *UnusablePatch
		if !errors.As(err, &u) {
			t.Errorf("%s: %v, want an unusable patch", c.Label, err)
		}
	}
}
