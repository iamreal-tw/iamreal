package main

// A preview of the visitors' pages, to look at them in a browser: a test
// roster of made-up records on a server that listens until it is stopped.
// Skipped unless IAMREAL_PAGES_PREVIEW is set:
//
//	IAMREAL_PAGES_PREVIEW=127.0.0.1:8090 \
//	IAMREAL_PAGES_PREVIEW_ACCOUNTS=<a>,<b>,<c>,<missing> \
//	go test -run TestPagesPreview -timeout 0 ./server
//
// The pages embed the real Threads profiles of the accounts named, so name
// accounts that may be shown that way: those of large organisations or
// public bodies, never a person's; <missing> is a name no account has, to
// see the embed fail. IAMREAL_PAGES_PREVIEW_EMPTY=1 serves an empty roster
// instead. The paths it serves are printed at the start.

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/server/pages"
	"github.com/iamreal-tw/iamreal/server/store"
)

func TestPagesPreview(t *testing.T) {
	addr := os.Getenv("IAMREAL_PAGES_PREVIEW")
	if addr == "" {
		t.Skip("IAMREAL_PAGES_PREVIEW is not set")
	}
	today := "2026-11-18"
	var h *harness
	var paths []string
	if os.Getenv("IAMREAL_PAGES_PREVIEW_EMPTY") != "" {
		h = pagesWorld(t, today)
		paths = []string{"/roster"}
	} else {
		names := strings.Split(os.Getenv("IAMREAL_PAGES_PREVIEW_ACCOUNTS"), ",")
		if len(names) != 4 {
			t.Fatal("IAMREAL_PAGES_PREVIEW_ACCOUNTS: four Threads names, separated by commas")
		}
		a, b, c, missing := names[0], names[1], names[2], names[3]
		single, second, fresh := cardStarting(t, "7K2Q9FM4XD"), cardStarting(t, "3M8T1RZ6WA"), cardStarting(t, "2HD5WN0J8C")
		withdrawn, twoA, twoB, failing := cardStarting(t, "9VQ4KD7T2M"), cardStarting(t, "M4T8XR6PZ13A"), cardStarting(t, "M4T8XR6PZ13B"), cardStarting(t, "5TCW8B3NQE")
		recs := []rec{
			r("2026-03-02", single, "threads:"+b),
			r("2026-05-10", single, "threads:"+b),
			r("2026-08-01", single, "threads:"+a),
			r("2026-09-01", second, "threads:"+a),
			r("2026-10-20", withdrawn, "threads:"+c),
			r("2026-11-01", twoB, "threads:"+c),
			r("2026-11-06", single, "threads:"+a),
			r("2026-11-06", twoA, "threads:"+c),
			r("2026-11-10", failing, "threads:"+missing),
		}
		for i := 0; i < 52; i++ {
			recs = append(recs, r("2026-11-12", newCard(), fmt.Sprintf("threads:sample.%02d", i)))
		}
		recs = append(recs,
			r("2026-11-15", withdrawn),
			r("2026-11-15", second, "threads:"+a),
			r("2026-11-15", twoB),
			r("2026-11-18", fresh, "threads:"+b),
		)
		h = pagesWorld(t, today, recs...)
		first, err := h.store.Recent(testScope, pages.Platform, store.RecentPosition{}, pages.PageSize)
		if err != nil {
			t.Fatal(err)
		}
		paths = []string{
			"/p/7K2Q9FM4XD", "/p/2HD5WN0J8C", "/p/9VQ4KD7T2M", "/p/M4T8XR6PZ1", "/p/5TCW8B3NQE", "/p/ZZZZZZZZZZ",
			"/threads/@" + b, "/threads/@" + a, "/threads/@nobody.here", "/threads/@a-b",
			"/roster", "/roster?after=" + pages.FormatPosition(first[len(first)-1].Position()), "/roster?q=a-b",
		}
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("serving a test roster of made-up records, today %s, at http://%s\n", today, addr)
	for _, p := range paths {
		fmt.Printf("  http://%s%s\n", addr, p)
	}
	srv := &http.Server{Handler: h.http, ReadHeaderTimeout: 10 * time.Second}
	t.Fatal(srv.Serve(ln))
}
