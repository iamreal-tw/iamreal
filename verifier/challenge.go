package verifier

import (
	"errors"
	"fmt"
	"math/big"
	"time"
)

// Date is a calendar date (in Taiwan, for every date of the protocol), as a
// day count. Dates compare with < and differ by whole days.
type Date int64

const secondsPerDay = 24 * 60 * 60

// NewDate returns the date year-month-day. It does not check that the date
// exists; ParseDate does.
func NewDate(year, month, day int) Date {
	return Date(time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).Unix() / secondsPerDay)
}

// ParseDate reads YYYY-MM-DD, a date that exists, with a year from 2000 to
// 2049: the date part of a challenge (spec/challenge.md).
func ParseDate(s string) (Date, error) {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' || !digits(s[0:4]) || !digits(s[5:7]) || !digits(s[8:10]) {
		return 0, errors.New("not YYYY-MM-DD")
	}
	y, m, d := atoi(s[0:4]), atoi(s[5:7]), atoi(s[8:10])
	if y < 2000 || y > 2049 {
		return 0, errors.New("year not from 2000 to 2049")
	}
	date := NewDate(y, m, d)
	if yy, mm, dd := date.YMD(); yy != y || mm != m || dd != d {
		return 0, errors.New("no such date")
	}
	return date, nil
}

// YMD returns the year, month and day of d.
func (d Date) YMD() (year, month, day int) {
	t := time.Unix(int64(d)*secondsPerDay, 0).UTC()
	return t.Year(), int(t.Month()), t.Day()
}

// AddDays returns the date n days after d (before, for negative n).
func (d Date) AddDays(n int) Date { return d + Date(n) }

// String writes d as YYYY-MM-DD.
func (d Date) String() string {
	y, m, dd := d.YMD()
	return fmt.Sprintf("%04d-%02d-%02d", y, m, dd)
}

// ChallengeLength is the length of a challenge in bytes.
const ChallengeLength = 37

// ParseChallenge checks that s is a challenge in its one spelling
// (spec/challenge.md, "Format") and returns its date.
func ParseChallenge(s string) (Date, error) {
	if len(s) != ChallengeLength || s[10] != '.' {
		return 0, errors.New("challenge: not a date, `.` and 26 characters")
	}
	date, err := ParseDate(s[:10])
	if err != nil {
		return 0, fmt.Errorf("challenge: %w", err)
	}
	if _, err := decodeBase32(s[11:], 16); err != nil {
		return 0, fmt.Errorf("challenge: random part: %w", err)
	}
	return date, nil
}

// CurrentTime returns the public input current_time for a challenge dated d:
// the decimal integer YYMMDD155959, the last second of d in Taiwan, in UTC
// (spec/challenge.md, "The date and current_time").
func CurrentTime(d Date) uint64 {
	y, m, dd := d.YMD()
	return uint64(y%100)*10000000000 + uint64(m)*100000000 + uint64(dd)*1000000 + 155959
}

func currentTimeField(d Date) Field {
	f, _ := FieldFromBigInt(new(big.Int).SetUint64(CurrentTime(d)))
	return f
}

func digits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

// atoi reads a string of at most 18 ASCII digits.
func atoi(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		n = n*10 + int(s[i]-'0')
	}
	return n
}
