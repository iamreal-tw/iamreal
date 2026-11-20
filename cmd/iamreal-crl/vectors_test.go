package main

// spec/vectors/revocation-tree.json and spec/vectors/circuit-inputs.json:
// `prove` gives every path of these vectors, from the CRL files in them.

import (
	"bytes"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/iamreal-tw/iamreal/crl"
)

const vectorsDir = "../../spec/vectors"

type vectorPath struct {
	Root     string   `json:"smt_root"`
	Siblings []string `json:"smt_siblings"`
	OldKey   string   `json:"smt_old_key"`
	OldValue string   `json:"smt_old_value"`
	IsOld0   bool     `json:"smt_is_old0"`
}

type testIssuer struct {
	Issuer  string `json:"issuer"`
	Bits    int    `json:"modulus_bits"`
	Modulus string `json:"modulus"`
}

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

// keyFiles writes each test issuer's public key to a file, for -key-g2 and
// -key-g3.
func keyFiles(t *testing.T, issuers []testIssuer) map[string]string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{}
	for _, i := range issuers {
		n, ok := new(big.Int).SetString(i.Modulus, 0)
		if !ok || n.BitLen() != i.Bits {
			t.Fatalf("test issuer %s: modulus %q", i.Issuer, i.Modulus)
		}
		der, err := x509.MarshalPKIXPublicKey(&rsa.PublicKey{N: n, E: 65537})
		if err != nil {
			t.Fatal(err)
		}
		f := filepath.Join(dir, i.Issuer+".der")
		if err := os.WriteFile(f, der, 0o644); err != nil {
			t.Fatal(err)
		}
		files[i.Issuer] = f
	}
	return files
}

// proveVector runs `iamreal-crl prove` on a CRL of the vectors.
func proveVector(t *testing.T, keys map[string]string, issuer string, crlHex string, serial string) (vectorPath, error) {
	t.Helper()
	der, err := hex.DecodeString(crlHex)
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "list.crl")
	if err := os.WriteFile(f, der, 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errs bytes.Buffer
	err = prove([]string{"-issuer", issuer, "-key-g2", keys["G2"], "-key-g3", keys["G3"], "-serial", serial, f}, &out, &errs)
	if err != nil {
		return vectorPath{}, err
	}
	var p vectorPath
	if err := json.Unmarshal(out.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return p, nil
}

// samePath compares two paths as numbers: prove writes 0x and the shortest
// hex, the vectors 64 digits.
func samePath(t *testing.T, got, want vectorPath) {
	t.Helper()
	num := func(s string) *big.Int {
		n, ok := new(big.Int).SetString(s, 0)
		if !ok {
			t.Fatalf("not a number: %q", s)
		}
		return n
	}
	eq := func(what, a, b string) {
		if num(a).Cmp(num(b)) != 0 {
			t.Errorf("%s: prove gives %s, the vector %s", what, a, b)
		}
	}
	eq("smt_root", got.Root, want.Root)
	eq("smt_old_key", got.OldKey, want.OldKey)
	eq("smt_old_value", got.OldValue, want.OldValue)
	if got.IsOld0 != want.IsOld0 {
		t.Errorf("smt_is_old0: prove gives %v, the vector %v", got.IsOld0, want.IsOld0)
	}
	if len(got.Siblings) != crl.Depth || len(want.Siblings) != crl.Depth {
		t.Fatalf("siblings: prove gives %d, the vector %d", len(got.Siblings), len(want.Siblings))
	}
	for i := range got.Siblings {
		eq("smt_siblings", got.Siblings[i], want.Siblings[i])
	}
}

func TestVectorsRevocationTree(t *testing.T) {
	var v struct {
		TestIssuers []testIssuer `json:"issuers"`
		CRLs        []struct {
			Name   string `json:"name"`
			Issuer string `json:"issuer"`
			CRL    string `json:"crl"`
			Root   string `json:"root"`
		} `json:"crls"`
		Cases []struct {
			Label  string      `json:"label"`
			CRL    string      `json:"crl"`
			Serial string      `json:"serial"`
			InTree bool        `json:"in_tree"`
			Path   *vectorPath `json:"path"`
		} `json:"cases"`
	}
	loadVectors(t, "revocation-tree.json", &v)
	keys := keyFiles(t, v.TestIssuers)
	type crlFile struct{ issuer, der, root string }
	crls := map[string]crlFile{}
	for _, c := range v.CRLs {
		crls[c.Name] = crlFile{c.Issuer, c.CRL, c.Root}
	}
	if len(v.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range v.Cases {
		t.Run(c.Label, func(t *testing.T) {
			f, ok := crls[c.CRL]
			if !ok {
				t.Fatalf("no CRL %q", c.CRL)
			}
			got, err := proveVector(t, keys, f.issuer, f.der, c.Serial)
			if c.InTree {
				if !errors.Is(err, crl.ErrInTree) {
					t.Errorf("in the tree: prove gives %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			samePath(t, got, *c.Path)
			if c.Path.Root != f.root {
				t.Errorf("the path's root %s is not the CRL's %s", c.Path.Root, f.root)
			}
		})
	}
}

// The paths in circuit-inputs.json are the paths of their certificate's
// serial number in a CRL of revocation-tree.json.
func TestVectorsCircuitInputsPaths(t *testing.T) {
	var tree struct {
		TestIssuers []testIssuer `json:"issuers"`
		CRLs        []struct {
			Issuer string `json:"issuer"`
			CRL    string `json:"crl"`
			Root   string `json:"root"`
		} `json:"crls"`
	}
	loadVectors(t, "revocation-tree.json", &tree)
	var v struct {
		TestIssuers []testIssuer `json:"issuers"`
		Cases       []struct {
			Label       string     `json:"label"`
			Issuer      string     `json:"issuer"`
			Certificate string     `json:"certificate"`
			Path        vectorPath `json:"path"`
		} `json:"cases"`
	}
	loadVectors(t, "circuit-inputs.json", &v)
	if !reflect.DeepEqual(v.TestIssuers, tree.TestIssuers) {
		t.Fatal("the two files have different test issuers")
	}
	keys := keyFiles(t, tree.TestIssuers)
	for _, c := range v.Cases {
		t.Run(c.Label, func(t *testing.T) {
			der, err := hex.DecodeString(c.Certificate)
			if err != nil {
				t.Fatal(err)
			}
			cert, err := x509.ParseCertificate(der)
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range tree.CRLs {
				if f.Issuer != c.Issuer || f.Root != c.Path.Root {
					continue
				}
				got, err := proveVector(t, keys, f.Issuer, f.CRL, cert.SerialNumber.Text(16))
				if err != nil {
					t.Fatal(err)
				}
				samePath(t, got, c.Path)
				return
			}
			t.Errorf("no CRL of %s in revocation-tree.json has the root %s", c.Issuer, c.Path.Root)
		})
	}
}
