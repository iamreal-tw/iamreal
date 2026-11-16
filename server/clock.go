package main

import (
	"time"

	"github.com/iamreal-tw/iamreal/verifier"
)

// taiwan is the time zone of every date of the protocol: UTC+8, with no
// daylight saving time (spec/challenge.md). A fixed offset, so the program
// does not depend on the time zone database of the machine.
var taiwan = time.FixedZone("UTC+8", 8*60*60)

// taiwanDate returns the date in Taiwan at the moment t.
func taiwanDate(t time.Time) verifier.Date {
	y, m, d := t.In(taiwan).Date()
	return verifier.NewDate(y, int(m), d)
}

// The time limits of the server (docs/api/card-proof.md).
const (
	// A challenge can be used for less than this long after it is issued.
	challengeLifetime = 10 * time.Minute
	// A challenge can be submitted at most this many times.
	maxSubmissions = 5
	// No card proof is accepted when the newest CRL of the issuer is more
	// than this many days old (spec/revocation-tree.md, "Who checks what").
	// GET /api/v1/config announces it to devices.
	crlMaxAgeDays = 3
)
