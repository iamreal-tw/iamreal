// Command iamreal-crl checks a MOICA CRL and rebuilds its revocation tree
// (spec/revocation-tree.md). See crl/README.md.
//
//	iamreal-crl check -issuer G3 MOICA-G3-complete.crl
//	iamreal-crl prove -issuer G3 -serial 0x1234… MOICA-G3-complete.crl
//	iamreal-crl index DIR
//
// check prints whether the CRL is usable, its cRLNumber, thisUpdate,
// nextUpdate, CRL date, the SHA-256 of the file and the root. prove prints
// the proof that a serial number is not in the tree, as the circuit's
// inputs. index prints the archive index of a directory: one line per file,
// usable or not (spec/revocation-tree.md, "Archive index"). -key-g2 and
// -key-g3 make a test key stand in for MOICA's G2 or G3 key, for tests.
package main

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "check":
		err = check(os.Args[2:], os.Stdout, os.Stderr)
	case "prove":
		err = prove(os.Args[2:], os.Stdout, os.Stderr)
	case "index":
		err = index(os.Args[2:], os.Stdout, os.Stderr)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "iamreal-crl:", err)
		var u *crl.Unusable
		if errors.As(err, &u) {
			os.Exit(1)
		}
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  iamreal-crl check -issuer G2|G3 [-key-g2 FILE] [-key-g3 FILE] CRL
  iamreal-crl prove -issuer G2|G3 [-key-g2 FILE] [-key-g3 FILE] -serial HEX CRL
  iamreal-crl index [-key-g2 FILE] [-key-g3 FILE] DIR

-key-g2 and -key-g3 make a test key (a public key or certificate, DER or
PEM) stand in for MOICA's G2 or G3 key. For tests only.

Exit status 1: the CRL is not usable (index: a file is not usable).
2: any other error.`)
	os.Exit(2)
}

// keyFlags adds -key-g2 and -key-g3 to fs: each names a test key that
// stands in for that MOICA issuer key.
type keyFlags map[string]*string

func addKeyFlags(fs *flag.FlagSet) keyFlags {
	f := keyFlags{}
	for _, name := range crl.Issuers {
		f[name] = fs.String("key-"+strings.ToLower(name), "", "`file` of a test key (public key or certificate, DER or PEM) that stands in for MOICA's "+name+" key; for tests only")
	}
	return f
}

// keys returns MOICA's issuer keys, in the order of crl.Issuers, with each
// test key given standing in for its issuer's. It warns on errw for every
// test key in use.
func (f keyFlags) keys(errw io.Writer) ([]crl.NamedKey, error) {
	keys, err := crl.MOICAKeys()
	if err != nil {
		return nil, err
	}
	for i, k := range keys {
		path := *f[k.Name]
		if path == "" {
			continue
		}
		if keys[i].Key, err = readKey(path); err != nil {
			return nil, err
		}
		fmt.Fprintf(errw, "iamreal-crl: WARNING: test key %s stands in for MOICA's %s key; results under it say nothing about MOICA's CRLs\n", path, k.Name)
	}
	return keys, nil
}

// issuerKey returns the key of the issuer named by -issuer: MOICA's, or
// the test key standing in for it.
func issuerKey(issuer string, f keyFlags, errw io.Writer) (*rsa.PublicKey, error) {
	if _, ok := f[issuer]; !ok {
		return nil, errors.New("give -issuer G2 or G3")
	}
	keys, err := f.keys(errw)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		if k.Name == issuer {
			return k.Key, nil
		}
	}
	panic("unreachable: every issuer has a key")
}

// readKey reads an RSA public key from a SubjectPublicKeyInfo or a
// certificate, DER or PEM.
func readKey(path string) (*rsa.PublicKey, error) {
	der, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if b, _ := pem.Decode(der); b != nil {
		der = b.Bytes
	}
	var pub any
	if cert, err := x509.ParseCertificate(der); err == nil {
		pub = cert.PublicKey
	} else if pub, err = x509.ParsePKIXPublicKey(der); err != nil {
		return nil, fmt.Errorf("%s: neither a certificate nor a public key", path)
	}
	k, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("%s: not an RSA key", path)
	}
	return k, nil
}

// open reads and parses a CRL. A file that is not a DER CertificateList is
// not usable (ReasonDER); check prints its SHA-256 first.
func open(path string, w io.Writer) (*crl.CRL, error) {
	der, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c, err := crl.Parse(der)
	if err != nil {
		if w != nil {
			l := crl.IndexFile(der, nil)
			fmt.Fprintf(w, "sha256       %s\n", l.SHA256)
			fmt.Fprintf(w, "usable       no\n")
			fmt.Fprintf(w, "reason       %s\n", crl.ReasonDER)
		}
		return nil, &crl.Unusable{Code: crl.ReasonDER, Reason: fmt.Sprintf("%s: %v", path, err)}
	}
	return c, nil
}

func check(args []string, w, errw io.Writer) error {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	issuer := fs.String("issuer", "", "MOICA issuer key: G2 or G3")
	testKeys := addKeyFlags(fs)
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}
	key, err := issuerKey(*issuer, testKeys, errw)
	if err != nil {
		return err
	}
	c, err := open(fs.Arg(0), w)
	if err != nil {
		return err
	}
	// The fields as the index writes them; the issuer is the key asked for.
	l := crl.IndexFile(c.Raw, nil)
	fmt.Fprintf(w, "issuer       %s\n", *issuer)
	fmt.Fprintf(w, "crl_number   %s\n", l.CRLNumber)
	fmt.Fprintf(w, "this_update  %s\n", l.ThisUpdate)
	fmt.Fprintf(w, "next_update  %s\n", l.NextUpdate)
	fmt.Fprintf(w, "crl_date     %s\n", l.CRLDate)
	fmt.Fprintf(w, "sha256       %s\n", l.SHA256)
	fmt.Fprintf(w, "entries      %d\n", len(c.Entries))
	start := time.Now()
	tree, err := c.Tree(key)
	if err != nil {
		var u *crl.Unusable
		errors.As(err, &u)
		fmt.Fprintf(w, "usable       no\n")
		fmt.Fprintf(w, "reason       %s\n", u.Code)
		return err
	}
	fmt.Fprintf(w, "usable       yes\n")
	fmt.Fprintf(w, "root         %s\n", tree.RootHex())
	fmt.Fprintf(w, "keys         %d\n", tree.Len())
	fmt.Fprintf(w, "hashes       %d\n", tree.Hashes())
	fmt.Fprintf(w, "build_time   %.2fs\n", time.Since(start).Seconds())
	return nil
}

func prove(args []string, w, errw io.Writer) error {
	fs := flag.NewFlagSet("prove", flag.ExitOnError)
	issuer := fs.String("issuer", "", "MOICA issuer key: G2 or G3")
	testKeys := addKeyFlags(fs)
	serial := fs.String("serial", "", "the certificate's serial number as a hexadecimal integer: its content bytes read unsigned")
	fs.Parse(args)
	if fs.NArg() != 1 || *serial == "" {
		usage()
	}
	key, err := issuerKey(*issuer, testKeys, errw)
	if err != nil {
		return err
	}
	k, err := crl.ParseKey(*serial)
	if err != nil {
		return err
	}
	c, err := open(fs.Arg(0), nil)
	if err != nil {
		return err
	}
	tree, err := c.Tree(key)
	if err != nil {
		return err
	}
	p, err := tree.ProveAbsent(k)
	if err != nil {
		return err
	}
	field := func(x interface{ Text(int) string }) string { return "0x" + x.Text(16) }
	out := struct {
		Root     string   `json:"smt_root"`
		Siblings []string `json:"smt_siblings"`
		OldKey   string   `json:"smt_old_key"`
		OldValue string   `json:"smt_old_value"`
		IsOld0   bool     `json:"smt_is_old0"`
	}{Root: field(p.Root), OldKey: field(p.OldKey), OldValue: field(p.OldValue), IsOld0: p.IsOld0}
	for _, s := range p.Siblings {
		out.Siblings = append(out.Siblings, field(s))
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

// index prints the archive index of a directory (spec/revocation-tree.md,
// "Archive index"): one line per file, usable or not, sorted. The issuer is
// the key whose signature verifies, G2 or G3, also when a test key stands
// in for it. If a file is not usable, the exit status is 1 after the index
// is printed; each such file is also reported on stderr.
func index(args []string, w, errw io.Writer) error {
	fs := flag.NewFlagSet("index", flag.ExitOnError)
	testKeys := addKeyFlags(fs)
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}
	keys, err := testKeys.keys(errw)
	if err != nil {
		return err
	}
	lines, err := crl.BuildIndex(fs.Arg(0), keys, nil)
	if err != nil {
		return err
	}
	if _, err := w.Write(crl.FormatIndex(lines)); err != nil {
		return err
	}
	bad := 0
	for _, l := range lines {
		if !l.Usable() {
			fmt.Fprintf(errw, "sha256 %s: not usable: %s\n", l.SHA256, l.Reason())
			bad++
		}
	}
	if bad > 0 {
		return &crl.Unusable{Code: "", Reason: fmt.Sprintf("%d of %d file(s) not usable", bad, len(lines))}
	}
	return nil
}
