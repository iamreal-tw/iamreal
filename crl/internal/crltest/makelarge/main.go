// Command makelarge writes CRL files made to cost a reader as much time and
// memory as a file within the mirror's download limit (32 MiB) can: a long
// cRLNumber, a great many extensions, a great many entries, a long issuer
// name, a long OID, a long serial number. Each is signed by a key made on
// the spot and not kept, so none is usable; the index gives each the line
// of a file that anyone on the path from MOICA could have put there.
//
//	go run ./crl/internal/crltest/makelarge -out DIR
//
// worker/README.md, "清冊鏡像量到的", has what worker/ and the Go crl/ do
// with them (#120).
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/asn1"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"

	"github.com/iamreal-tw/iamreal/crl/internal/crltest"
)

// limit is the mirror's download limit: the largest file it stores.
const limit = 32 << 20

var key *rsa.PrivateKey

func base() *crltest.CRL {
	return &crltest.CRL{
		IssuerCN:   "Synthetic issuer nobody trusts",
		ThisUpdate: crltest.ThisUpdate,
		NextUpdate: crltest.ThisUpdate.AddDate(0, 0, 1),
		Number:     4660,
	}
}

// fill returns the file that build(n) gives for the largest n whose file
// is at most limit bytes, for a build whose file grows with n: a binary
// search between 0 and a first guess from the size of build(1000).
func fill(build func(n int) *crltest.CRL) ([]byte, int) {
	size := func(n int) int { return len(crltest.TBS(build(n), crltest.KeyID(&key.PublicKey))) }
	s0, s1 := size(0), size(1000)
	// The signature and the outer SEQUENCE: the same for every n.
	extra := len(crltest.Make(build(0), key)) - s0
	low, high := 0, 2*int(float64(limit-s0)/(float64(s1-s0)/1000))+1
	for low < high {
		mid := (low + high + 1) / 2
		if size(mid)+extra+2 <= limit {
			low = mid
		} else {
			high = mid - 1
		}
	}
	der := crltest.Make(build(low), key)
	if len(der) > limit {
		log.Fatalf("%d bytes", len(der))
	}
	return der, low
}

// positive is n content bytes of a positive INTEGER: 7f, then ff.
func positive(n int) []byte {
	content := make([]byte, n)
	for i := range content {
		content[i] = 0xff
	}
	content[0] = 0x7f
	return content
}

// integer is a DER INTEGER of n content bytes: 7f, then ff.
func integer(n int) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.INTEGER, func(b *cryptobyte.Builder) { b.AddBytes(positive(n)) })
	return b.BytesOrPanic()
}

// oid is 1.2.x, x from 2^21 on: content bytes of the same length for every
// x below 2^28, so each extension has the same size.
func oid(i int) asn1.ObjectIdentifier { return asn1.ObjectIdentifier{1, 2, 1<<21 + i} }

func extensions(n int) []crltest.Extension {
	out := make([]crltest.Extension, n)
	for i := range out {
		out[i] = crltest.Extension{ID: oid(i)}
	}
	return out
}

func main() {
	out := flag.String("out", "large", "directory to write the files into")
	flag.Parse()
	var err error
	if key, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	write := func(name, what string, der []byte) {
		if len(der) > limit {
			log.Fatalf("%s: %d bytes, more than %d", name, len(der), limit)
		}
		if err := os.WriteFile(filepath.Join(*out, name+".crl"), der, 0o644); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%-24s %10d bytes  %s\n", name, len(der), what)
	}

	// The cRLNumber of the table of #120: 1 MB, 4 MB, and the longest.
	for _, n := range []int{1_000_000, 4_000_000} {
		c := base()
		c.Number = -1
		c.Extensions = []crltest.Extension{{ID: crltest.OIDCRLNumber, Value: integer(n)}}
		write(fmt.Sprintf("number-%dmb", n/1_000_000), fmt.Sprintf("a cRLNumber of %d bytes", n), crltest.Make(c, key))
	}
	der, n := fill(func(n int) *crltest.CRL {
		c := base()
		c.Number = -1
		c.Extensions = []crltest.Extension{{ID: crltest.OIDCRLNumber, Value: integer(n*1000 + 1)}}
		return c
	})
	write("number-longest", fmt.Sprintf("a cRLNumber of about %d bytes", n*1000), der)

	der, n = fill(func(n int) *crltest.CRL {
		c := base()
		c.Extensions = extensions(n)
		return c
	})
	write("crl-extensions", fmt.Sprintf("%d different extensions of the CRL", n+2), der)

	der, n = fill(func(n int) *crltest.CRL {
		c := base()
		c.Entries = []crltest.Entry{{Serial: []byte{0x05}, RevocationDate: crltest.ThisUpdate, Extensions: extensions(n)}}
		return c
	})
	write("entry-extensions", fmt.Sprintf("one entry with %d different extensions", n), der)

	der, n = fill(func(n int) *crltest.CRL {
		c := base()
		c.Entries = make([]crltest.Entry, n)
		for i := range c.Entries {
			c.Entries[i] = crltest.Entry{Serial: []byte{byte(i % 128)}, RevocationDate: crltest.ThisUpdate}
		}
		return c
	})
	write("entries", fmt.Sprintf("%d entries of one-byte serials, without extensions", n), der)

	der, n = fill(func(n int) *crltest.CRL {
		c := base()
		c.Entries = []crltest.Entry{{Serial: positive(n*1000 + 1), RevocationDate: crltest.ThisUpdate}}
		return c
	})
	write("serial-longest", fmt.Sprintf("one entry whose serial number is about %d bytes", n*1000), der)

	der, n = fill(func(n int) *crltest.CRL {
		c := base()
		c.IssuerCN = strings.Repeat("a", n*1000)
		return c
	})
	write("issuer-longest", fmt.Sprintf("an issuer name of about %d bytes", n*1000), der)

	der, n = fill(func(n int) *crltest.CRL {
		c := base()
		long := make(asn1.ObjectIdentifier, n*1000+2)
		long[0], long[1] = 1, 2
		for i := 2; i < len(long); i++ {
			long[i] = 1 + i%100
		}
		c.Extensions = []crltest.Extension{{ID: long}, {ID: oid(0)}}
		return c
	})
	write("oid-longest", fmt.Sprintf("an extension of the CRL whose OID has about %d arcs, and another", n*1000), der)
}
