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
// inputs. index prints one line per CRL file in a directory (see crl/README.md;
// the format is a proposal). -key replaces -issuer with a test key.
package main

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
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
		err = check(os.Args[2:], os.Stdout)
	case "prove":
		err = prove(os.Args[2:], os.Stdout)
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
  iamreal-crl check (-issuer G2|G3 | -key FILE) CRL
  iamreal-crl prove (-issuer G2|G3 | -key FILE) -serial HEX CRL
  iamreal-crl index [-key FILE] DIR

Exit status 1: the CRL is not usable. 2: any other error.`)
	os.Exit(2)
}

// issuerFlags adds -issuer and -key to fs.
type issuerFlags struct {
	issuer, key *string
}

func addIssuerFlags(fs *flag.FlagSet) issuerFlags {
	return issuerFlags{
		issuer: fs.String("issuer", "", "MOICA issuer key: G2 or G3"),
		key:    fs.String("key", "", "a test issuer's public key or certificate (DER or PEM) instead of -issuer"),
	}
}

func (f issuerFlags) load() (string, *rsa.PublicKey, error) {
	switch {
	case *f.issuer != "" && *f.key != "":
		return "", nil, errors.New("give -issuer or -key, not both")
	case *f.issuer != "":
		k, err := crl.IssuerKey(*f.issuer)
		return *f.issuer, k, err
	case *f.key != "":
		k, err := readKey(*f.key)
		return "test", k, err
	}
	return "", nil, errors.New("give -issuer G2 or G3 (or -key)")
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

// summary is what check prints and index lists.
type summary struct {
	Issuer     string
	Number     string // decimal, or "-" if absent
	ThisUpdate string
	NextUpdate string // or "-" if absent
	Date       string
	SHA256     string
	Entries    int
	Root       string // or "" if not usable
}

const timeFormat = "2006-01-02T15:04:05Z"

// open reads and parses a CRL and fills in what does not need the key.
func open(path string) (*crl.CRL, summary, error) {
	der, err := os.ReadFile(path)
	if err != nil {
		return nil, summary{}, err
	}
	c, err := crl.Parse(der)
	if err != nil {
		return nil, summary{}, fmt.Errorf("%s: %w", path, err)
	}
	sum := c.SHA256()
	s := summary{
		Number:     "-",
		ThisUpdate: c.ThisUpdate.Format(timeFormat),
		NextUpdate: "-",
		Date:       c.Date(),
		SHA256:     hex.EncodeToString(sum[:]),
		Entries:    len(c.Entries),
	}
	if !c.NextUpdate.IsZero() {
		s.NextUpdate = c.NextUpdate.Format(timeFormat)
	}
	n, err := c.Number()
	if err != nil {
		return nil, summary{}, fmt.Errorf("%s: %w", path, err)
	}
	if n != nil {
		s.Number = n.String()
	}
	return c, s, nil
}

func build(c *crl.CRL, key *rsa.PublicKey) (*crl.Tree, error) {
	keys, err := c.Check(key)
	if err != nil {
		return nil, err
	}
	return crl.NewTree(keys)
}

func check(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	keyFlags := addIssuerFlags(fs)
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}
	name, key, err := keyFlags.load()
	if err != nil {
		return err
	}
	c, s, err := open(fs.Arg(0))
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "issuer       %s\n", name)
	fmt.Fprintf(w, "crl_number   %s\n", s.Number)
	fmt.Fprintf(w, "this_update  %s\n", s.ThisUpdate)
	fmt.Fprintf(w, "next_update  %s\n", s.NextUpdate)
	fmt.Fprintf(w, "crl_date     %s\n", s.Date)
	fmt.Fprintf(w, "sha256       %s\n", s.SHA256)
	fmt.Fprintf(w, "entries      %d\n", s.Entries)
	start := time.Now()
	tree, err := build(c, key)
	if err != nil {
		fmt.Fprintf(w, "usable       no\n")
		return err
	}
	fmt.Fprintf(w, "usable       yes\n")
	fmt.Fprintf(w, "root         %s\n", tree.RootHex())
	fmt.Fprintf(w, "hashes       %d\n", tree.Hashes())
	fmt.Fprintf(w, "build_time   %.2fs\n", time.Since(start).Seconds())
	return nil
}

func prove(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("prove", flag.ExitOnError)
	keyFlags := addIssuerFlags(fs)
	serial := fs.String("serial", "", "the certificate's serial number as a hexadecimal integer: its content bytes read unsigned")
	fs.Parse(args)
	if fs.NArg() != 1 || *serial == "" {
		usage()
	}
	_, key, err := keyFlags.load()
	if err != nil {
		return err
	}
	k, err := crl.ParseKey(*serial)
	if err != nil {
		return err
	}
	c, _, err := open(fs.Arg(0))
	if err != nil {
		return err
	}
	tree, err := build(c, key)
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

// index prints one line per usable CRL in a directory, sorted by issuer,
// cRLNumber and SHA-256. The issuer is the key whose signature verifies.
// Files that are not usable under any key are reported on stderr, and make
// the exit status 1 after the index is printed.
func index(args []string, w, errw io.Writer) error {
	fs := flag.NewFlagSet("index", flag.ExitOnError)
	keyPath := fs.String("key", "", "also try a test issuer's public key or certificate")
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}
	type issuer struct {
		name string
		key  *rsa.PublicKey
	}
	var issuers []issuer
	for _, name := range crl.Issuers {
		k, err := crl.IssuerKey(name)
		if err != nil {
			return err
		}
		issuers = append(issuers, issuer{name, k})
	}
	if *keyPath != "" {
		k, err := readKey(*keyPath)
		if err != nil {
			return err
		}
		issuers = append(issuers, issuer{"test", k})
	}
	entries, err := os.ReadDir(fs.Arg(0))
	if err != nil {
		return err
	}
	var lines []summary
	bad := 0
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		path := filepath.Join(fs.Arg(0), e.Name())
		c, s, err := open(path)
		if err != nil {
			fmt.Fprintf(errw, "%s: %v\n", e.Name(), err)
			bad++
			continue
		}
		signed := false
		for _, is := range issuers {
			if c.VerifySignature(is.key) != nil {
				continue
			}
			signed = true
			s.Issuer = is.name
			tree, err := build(c, is.key)
			if err != nil {
				fmt.Fprintf(errw, "%s: issuer %s: %v\n", e.Name(), is.name, err)
				bad++
			} else {
				s.Root = tree.RootHex()
			}
			break
		}
		if !signed {
			fmt.Fprintf(errw, "%s: the signature verifies under no issuer key\n", e.Name())
			bad++
		}
		if s.Root == "" {
			continue
		}
		lines = append(lines, s)
	}
	slices.SortFunc(lines, func(a, b summary) int {
		if c := strings.Compare(a.Issuer, b.Issuer); c != 0 {
			return c
		}
		if c := len(a.Number) - len(b.Number); c != 0 && a.Number != "-" && b.Number != "-" {
			return c
		}
		if c := strings.Compare(a.Number, b.Number); c != 0 {
			return c
		}
		return strings.Compare(a.SHA256, b.SHA256)
	})
	for _, s := range lines {
		fmt.Fprintf(w, `{"issuer":"%s","crl_number":"%s","this_update":"%s","next_update":"%s","crl_date":"%s","sha256":"%s","root":"%s"}`+"\n",
			s.Issuer, s.Number, s.ThisUpdate, s.NextUpdate, s.Date, s.SHA256, s.Root)
	}
	if bad > 0 {
		return &crl.Unusable{Reason: fmt.Sprintf("%d file(s) not indexed", bad)}
	}
	return nil
}
