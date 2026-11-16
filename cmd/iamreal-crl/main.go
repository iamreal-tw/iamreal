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
// usable or not (spec/revocation-tree.md, "Archive index"). -key replaces
// -issuer with a test key.
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

Exit status 1: the CRL is not usable (index: a file is not usable).
2: any other error.`)
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
	c, err := open(fs.Arg(0), w)
	if err != nil {
		return err
	}
	// The fields as the index writes them; the issuer is the key asked for.
	l := crl.IndexFile(c.Raw, nil)
	fmt.Fprintf(w, "issuer       %s\n", name)
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
// the key whose signature verifies. If a file is not usable, the exit
// status is 1 after the index is printed; each such file is also reported
// on stderr.
func index(args []string, w, errw io.Writer) error {
	fs := flag.NewFlagSet("index", flag.ExitOnError)
	keyPath := fs.String("key", "", "also try a test issuer's public key or certificate; its lines have issuer \"test\"")
	fs.Parse(args)
	if fs.NArg() != 1 {
		usage()
	}
	keys, err := crl.MOICAKeys()
	if err != nil {
		return err
	}
	if *keyPath != "" {
		k, err := readKey(*keyPath)
		if err != nil {
			return err
		}
		keys = append(keys, crl.NamedKey{Name: "test", Key: k})
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
