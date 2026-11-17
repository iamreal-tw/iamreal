package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/iamreal-tw/iamreal/verifier"
)

// The error codes of docs/api/card-proof.md, and three the document does
// not list: not_found, method_not_allowed and internal.
const (
	errMalformed         = "malformed"
	errScope             = "scope"
	errPlatform          = "platform"
	errSwitchRestricted  = "switch_restricted"
	errChallengeUnknown  = "challenge_unknown"
	errChallengeUsed     = "challenge_used"
	errChallengeAttempts = "challenge_attempts"
	errProof             = "proof"
	errRoot              = "root"
	errCRLStale          = "crl_stale"
	errRateLimited       = "rate_limited" // no rate limit yet; the code is reserved
	errNotFound          = "not_found"
	errMethod            = "method_not_allowed"
	errInternal          = "internal"
)

// reply is what a handler answers: a status and a JSON body. code is the
// error code of an error reply, for the log.
type reply struct {
	status int
	body   any
	code   string
}

func ok(status int, body any) reply { return reply{status: status, body: body} }

func fail(status int, code string) reply {
	return reply{status: status, body: map[string]string{"error": code}, code: code}
}

// endpoint is one API endpoint: its method and its handler.
type endpoint struct {
	method string
	handle func(r *http.Request) reply
}

func (s *Server) endpoints() map[string]endpoint {
	return map[string]endpoint{
		"/api/v1/challenges": {http.MethodPost, s.postChallenge},
		"/api/v1/card-state": {http.MethodPost, s.postCardState},
		"/api/v1/records":    {http.MethodPost, s.postRecord},
		"/api/v1/config":     {http.MethodGet, s.getConfig},
		"/api/v1/head":       {http.MethodGet, s.getHead},
	}
}

// api serves everything under /api/. Every response is JSON with
// Cache-Control: no-store and X-Request-Id, and every request is logged
// once (log.go) with the same ID.
func (s *Server) api() http.Handler {
	endpoints := s.endpoints()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := requestID()
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id))
		e, found := endpoints[r.URL.Path]
		rep := func() (rep reply) {
			defer func() {
				if p := recover(); p != nil {
					s.cfg.Log.Error("panic", "id", id, "panic", p)
					rep = fail(http.StatusInternalServerError, errInternal)
				}
			}()
			switch {
			case !found:
				return fail(http.StatusNotFound, errNotFound)
			case r.Method != e.method:
				w.Header().Set("Allow", e.method)
				return fail(http.StatusMethodNotAllowed, errMethod)
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBody)
			return e.handle(r)
		}()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		// The ID the log line carries, so that a cardholder who reports an
		// error can name it (docs/api/card-proof.md).
		w.Header().Set("X-Request-Id", id)
		w.WriteHeader(rep.status)
		json.NewEncoder(w).Encode(rep.body)
		s.logRequest(id, r, found, rep)
	})
}

// requestID returns a new random request ID, written in the log so that a
// failure can be found without anything that identifies the connection.
func requestID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// POST /api/v1/challenges: a new challenge dated today in Taiwan
// (spec/challenge.md), stored with the time it was issued.
func (s *Server) postChallenge(r *http.Request) reply {
	now := s.cfg.Now()
	random := make([]byte, 16)
	if _, err := io.ReadFull(s.cfg.Random, random); err != nil {
		return s.internal(r, "random", err)
	}
	c := taiwanDate(now).String() + "." + verifier.EncodeBase32(random)
	if _, err := verifier.ParseChallenge(c); err != nil {
		return s.internal(r, "challenge", err) // a date outside 2000 to 2049
	}
	if err := s.cfg.Store.AddChallenge(c, now); err != nil {
		return s.internal(r, "store", err)
	}
	return ok(http.StatusOK, map[string]string{"challenge": c})
}

// cardState is the response of POST /api/v1/card-state. The fields are in
// the order of docs/api/card-proof.md; nil pointers are written as null.
// Platforms has one entry for every platform of the roster's table; the
// order of its entries means nothing (encoding/json writes them sorted).
type cardState struct {
	LastCardProof    *string              `json:"last_card_proof"`
	ProofsOnLastDate int                  `json:"proofs_on_last_date"`
	Platforms        map[string]slotState `json:"platforms"`
	Count            uint64               `json:"count"`
	Head             string               `json:"head"`
}

// slotState is the state of the card's slot on one platform.
type slotState struct {
	Current        *string `json:"current"`
	LastDeclared   *string `json:"last_declared"`
	SwitchCount    int     `json:"switch_count"`
	CorrectionDate *string `json:"correction_date"`
}

// POST /api/v1/card-state: the state of one card, for every platform, as
// the roster rules compute it. The server sends facts, not conclusions.
func (s *Server) postCardState(r *http.Request) reply {
	f, err := readObject(r.Body, "scope_string", "scoped_id")
	if err != nil {
		return fail(http.StatusBadRequest, errMalformed)
	}
	// A scope this roster does not accept is not in the format of
	// scope_string (spec/record.md).
	if _, accepted := verifier.LookupScope(s.cfg.Roster, f["scope_string"]); !accepted {
		return fail(http.StatusBadRequest, errMalformed)
	}
	if _, err := verifier.ParseScopedID(f["scoped_id"]); err != nil {
		return fail(http.StatusBadRequest, errMalformed)
	}

	s.mu.RLock()
	card := s.rules.Card(f["scope_string"], f["scoped_id"])
	out := cardState{ProofsOnLastDate: card.ProofsOnLastDate, Platforms: map[string]slotState{}, Count: s.count, Head: s.head}
	s.mu.RUnlock()

	if card.LastCardProof != nil {
		d := card.LastCardProof.String()
		out.LastCardProof = &d
	}
	for p, slot := range card.Slots {
		st := slotState{Current: slot.Current, LastDeclared: slot.LastDeclared, SwitchCount: slot.SwitchCount}
		if slot.CorrectionDate != nil {
			d := slot.CorrectionDate.String()
			st.CorrectionDate = &d
		}
		out.Platforms[p] = st
	}
	return ok(http.StatusOK, out)
}

// config is the response of GET /api/v1/config, in the order of
// docs/api/card-proof.md.
type config struct {
	CRLMaxAgeDays int              `json:"crl_max_age_days"`
	Platforms     []configPlatform `json:"platforms"`
}

// configPlatform is one row of the roster's platform table
// (spec/scope.md): a convenience for devices, which every re-verifier can
// check against the specification.
type configPlatform struct {
	Platform       string `json:"platform"`
	DisplayName    string `json:"display_name"`
	UsernameFormat string `json:"username_format"`
}

// GET /api/v1/config: the CRL age bound and the platform table of this
// roster, in ascending order of platform ID.
func (s *Server) getConfig(*http.Request) reply {
	out := config{CRLMaxAgeDays: crlMaxAgeDays, Platforms: []configPlatform{}}
	for _, p := range verifier.Platforms(s.cfg.Roster) {
		out.Platforms = append(out.Platforms, configPlatform{p.ID, p.DisplayName, p.UsernameFormat})
	}
	return ok(http.StatusOK, out)
}

// head is the response of GET /api/v1/head.
type head struct {
	Count uint64 `json:"count"`
	Head  string `json:"head"`
}

// GET /api/v1/head
func (s *Server) getHead(*http.Request) reply {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return ok(http.StatusOK, head{s.count, s.head})
}

// internal logs an error of the server itself, with the request ID, and
// answers 500. The message says what failed, never what the request
// carried.
func (s *Server) internal(r *http.Request, what string, err error) reply {
	id, _ := r.Context().Value(requestIDKey{}).(string)
	s.cfg.Log.Error("internal error", "id", id, "what", what, "err", strings.TrimSpace(err.Error()))
	return fail(http.StatusInternalServerError, errInternal)
}

// requestIDKey is the context key of the request ID.
type requestIDKey struct{}
