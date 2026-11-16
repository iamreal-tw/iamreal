package main

import (
	"log"
	"log/slog"
	"net/http"
	"runtime/debug"
)

// The request log (docs/api/card-proof.md, "Rules for every endpoint").
//
// One line per API request, with only:
//
//	time, request ID, method and path, status, error code, program version
//
// Never the IP address, the port, any header (User-Agent, X-Forwarded-For,
// …), the body, or anything that came in it: no scoped ID, no username, no
// challenge. A scoped ID next to an IP address would let anyone holding the
// logs look for the person behind a card; a challenge next to an IP address
// would lead back to the same through the roster. The rule is the same for
// every endpoint, so no endpoint can get it wrong.
//
// Static files (/crl/, /roster/, the web directory) are not logged.
//
// The path is logged only if it is one of the endpoints: another path is
// whatever the client wrote, and is logged as "other".
func (s *Server) logRequest(id string, r *http.Request, known bool, rep reply) {
	path := "other"
	if known {
		path = r.URL.Path
	}
	s.cfg.Log.Info("request",
		"id", id,
		"method", r.Method,
		"path", path,
		"status", rep.status,
		"error", rep.code,
		"version", s.cfg.Version,
	)
}

// httpErrorLog is the error log of the HTTP server. net/http writes the
// client's address into some of its messages (a panic, a TLS handshake
// error), so the message is dropped and only the fact is kept.
func httpErrorLog(logger *slog.Logger) *log.Logger {
	return log.New(withheld{logger}, "", 0)
}

type withheld struct{ logger *slog.Logger }

func (w withheld) Write(p []byte) (int, error) {
	w.logger.Warn("net/http error; the message is not logged because it can contain the client's address")
	return len(p), nil
}

// version is the program's version: the git commit it was built from, as
// go build records it, with "+dirty" for uncommitted changes.
func version() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	rev, dirty := "", false
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	if rev == "" {
		return info.Main.Version
	}
	if dirty {
		rev += "+dirty"
	}
	return rev
}
