// Command iamreal-server is the server of the card proof
// (docs/api/card-proof.md): it issues challenges, answers the state of a
// card, accepts card proofs into the roster, mirrors MOICA's CRLs and
// publishes the roster once a day. See README.md.
//
//	iamreal-server serve    -data DIR -bb BB -crs DIR [-addr ADDR] [-web DIR] [-roster test|production] [-mirror=false]
//	iamreal-server mirror   -data DIR
//	iamreal-server snapshot -data DIR -bb BB -crs DIR [-out DIR] [-roster test|production]
//
// The data directory holds:
//
//	DIR/iamreal.sqlite  the roster's records and the challenges
//	DIR/crl/            the CRL mirror (served at /crl/)
//	DIR/roster/         the published roster (served at /roster/)
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, productionDeps()))
}

// deps are the parts tests replace. The program uses MOICA's issuer keys
// and CRL addresses only.
type deps struct {
	verifier func(verifier.Config) (roster.ProofVerifier, error)
	crlKeys  func() ([]crl.NamedKey, error)
	sources  []crlSource
	now      func() time.Time
}

func productionDeps() deps {
	return deps{
		verifier: func(cfg verifier.Config) (roster.ProofVerifier, error) { return verifier.New(cfg) },
		crlKeys:  crl.MOICAKeys,
		sources:  moicaCRLs,
		now:      time.Now,
	}
}

// testOptions is set only in a build with the tag iamrealtest
// (testissuers.go). It adds the options that replace MOICA's issuer keys and
// CRL addresses with throwaway ones, for web/'s end-to-end test against this
// server. A program built without the tag has no such option.
var testOptions func(fs *flag.FlagSet) func(*deps) error

// addTestOptions adds testOptions to fs, if the build has them, and returns
// what applies them after parsing.
func addTestOptions(fs *flag.FlagSet) func(*deps) error {
	if testOptions == nil {
		return func(*deps) error { return nil }
	}
	return testOptions(fs)
}

// The files of the data directory.
func dbPath(data string) string    { return filepath.Join(data, "iamreal.sqlite") }
func crlDir(data string) string    { return filepath.Join(data, "crl") }
func rosterDir(data string) string { return filepath.Join(data, "roster") }

const usage = `usage:
  iamreal-server serve    -data DIR -bb BB -crs DIR [flags]   run the server
  iamreal-server mirror   -data DIR                           fetch MOICA's CRLs once
  iamreal-server snapshot -data DIR -bb BB -crs DIR [flags]   re-verify and publish the roster
Run iamreal-server <command> -h for the flags of a command.`

func run(args []string, stdout, stderr io.Writer, d deps) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve":
		return serve(args[1:], stderr, d)
	case "mirror":
		return mirror(args[1:], stderr, d)
	case "snapshot":
		return snapshotCommand(args[1:], stdout, stderr, d)
	}
	fmt.Fprintln(stderr, usage)
	return 2
}

func rosterFlag(fs *flag.FlagSet) *string {
	return fs.String("roster", "test", "whose accepted scopes: test or production")
}

func parseRoster(s string) (verifier.Roster, error) {
	switch s {
	case "test":
		return verifier.Test, nil
	case "production":
		return verifier.Production, nil
	}
	return 0, fmt.Errorf("-roster %q: want test or production", s)
}

func serve(args []string, stderr io.Writer, d deps) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	data := fs.String("data", "", "the data `directory` (required)")
	addr := fs.String("addr", "127.0.0.1:8080", "the address to listen on")
	web := fs.String("web", "", "a `directory` of static files served at / (the build of web/)")
	kind := rosterFlag(fs)
	bb := fs.String("bb", "", "path of the `bb` 6.0.0 executable (required)")
	crs := fs.String("crs", "", "`directory` holding "+verifier.CRSFile+" (required)")
	runMirror := fs.Bool("mirror", true, "fetch MOICA's CRLs at start and every hour")
	acceptRestricted := fs.Bool("accept-restricted-switches", false, "accept the fourth and fifth switch of a slot (switch_restricted); refused by default")
	applyTest := addTestOptions(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *data == "" || *bb == "" || *crs == "" || fs.NArg() != 0 {
		fs.Usage()
		return 2
	}
	if err := applyTest(&d); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	r, err := parseRoster(*kind)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	logger := slog.New(slog.NewJSONHandler(stderr, nil))
	fail := func(err error) int {
		logger.Error("not starting", "err", err)
		return 1
	}

	for _, dir := range []string{*data, crlDir(*data), rosterDir(*data)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fail(err)
		}
	}
	proofs, err := d.verifier(verifier.Config{BB: *bb, CRSDir: *crs})
	if err != nil {
		return fail(err)
	}
	keys, err := d.crlKeys()
	if err != nil {
		return fail(err)
	}
	st, err := store.Open(dbPath(*data))
	if err != nil {
		return fail(err)
	}
	defer st.Close()

	s, err := New(Config{
		Roster: r, Store: st, CRLDir: crlDir(*data), Proofs: proofs,
		Now: d.now, Random: rand.Reader, Log: logger, Version: version(),
		AcceptRestrictedSwitches: *acceptRestricted,
	})
	if err != nil {
		return fail(err)
	}
	logger.Info("roster loaded", "roster", r.String(), "count", s.count, "head", s.head, "version", version(),
		"accept_restricted_switches", *acceptRestricted)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go every(ctx, time.Minute, func() {
		if _, err := s.deleteExpiredChallenges(); err != nil {
			logger.Error("deleting expired challenges", "err", err)
		}
	})
	if *runMirror {
		m := &Mirror{Dir: crlDir(*data), Keys: keys, Sources: d.sources, Client: &http.Client{Timeout: 5 * time.Minute}, Log: logger}
		go func() {
			m.Fetch(ctx)
			every(ctx, mirrorInterval, func() { m.Fetch(ctx) })
		}()
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           s.routes(crlDir(*data), rosterDir(*data), *web),
		ErrorLog:          httpErrorLog(logger),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       time.Minute,
		WriteTimeout:      5 * time.Minute,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	logger.Info("listening", "addr", *addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fail(err)
	}
	return 0
}

// every calls f every interval until ctx is done.
func every(ctx context.Context, interval time.Duration, f func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

func mirror(args []string, stderr io.Writer, d deps) int {
	fs := flag.NewFlagSet("mirror", flag.ContinueOnError)
	fs.SetOutput(stderr)
	data := fs.String("data", "", "the data `directory` (required)")
	applyTest := addTestOptions(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *data == "" || fs.NArg() != 0 {
		fs.Usage()
		return 2
	}
	if err := applyTest(&d); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	logger := slog.New(slog.NewJSONHandler(stderr, nil))
	if err := os.MkdirAll(crlDir(*data), 0o755); err != nil {
		logger.Error("mirror", "err", err)
		return 2
	}
	keys, err := d.crlKeys()
	if err != nil {
		logger.Error("mirror", "err", err)
		return 2
	}
	m := &Mirror{Dir: crlDir(*data), Keys: keys, Sources: d.sources, Client: &http.Client{Timeout: 5 * time.Minute}, Log: logger}
	if err := m.Fetch(context.Background()); err != nil {
		return 1
	}
	return 0
}

func snapshotCommand(args []string, stdout, stderr io.Writer, d deps) int {
	fs := flag.NewFlagSet("snapshot", flag.ContinueOnError)
	fs.SetOutput(stderr)
	data := fs.String("data", "", "the data `directory` (required)")
	out := fs.String("out", "", "the roster `directory` to publish into (default DATA/roster)")
	kind := rosterFlag(fs)
	bb := fs.String("bb", "", "path of the `bb` 6.0.0 executable (required)")
	crs := fs.String("crs", "", "`directory` holding "+verifier.CRSFile+" (required)")
	applyTest := addTestOptions(fs)
	if err := fs.Parse(args); err != nil {
		return snapshotError
	}
	if *data == "" || *bb == "" || *crs == "" || fs.NArg() != 0 {
		fs.Usage()
		return snapshotError
	}
	if err := applyTest(&d); err != nil {
		fmt.Fprintln(stderr, err)
		return snapshotError
	}
	if *out == "" {
		*out = rosterDir(*data)
	}
	r, err := parseRoster(*kind)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return snapshotError
	}
	proofs, err := d.verifier(verifier.Config{BB: *bb, CRSDir: *crs})
	if err != nil {
		fmt.Fprintf(stderr, "snapshot: %v\n", err)
		return snapshotError
	}
	keys, err := d.crlKeys()
	if err != nil {
		fmt.Fprintf(stderr, "snapshot: %v\n", err)
		return snapshotError
	}
	st, err := store.OpenReadOnly(dbPath(*data))
	if err != nil {
		fmt.Fprintf(stderr, "snapshot: %v\n", err)
		return snapshotError
	}
	defer st.Close()
	return snapshot(snapshotConfig{
		Store: st, Roster: r, CRLDir: crlDir(*data), OutDir: *out, Proofs: proofs, Keys: keys,
		Today: taiwanDate(d.now()), Out: stdout, Err: stderr,
	})
}
