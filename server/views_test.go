package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// viewsOf reads, through the store's queries, what the pages would show
// for the given cards and accounts ("platform:username").
func viewsOf(t *testing.T, h *harness, today string, cards []string, accounts ...string) string {
	t.Helper()
	st := h.store
	out := ""
	for _, c := range cards {
		got, err := st.Cards(testScope, verifier.ShortID(c))
		if err != nil {
			t.Fatal(err)
		}
		hist, err := st.History(testScope, c)
		if err != nil {
			t.Fatal(err)
		}
		out += fmt.Sprintf("card %+v\nhistory %+v\n", got, hist)
	}
	for _, a := range list(accounts...) {
		got, err := st.AccountCards(testScope, a.Platform, a.Username)
		if err != nil {
			t.Fatal(err)
		}
		out += fmt.Sprintf("account %s %s %+v\n", a.Platform, a.Username, got)
	}
	for _, p := range verifier.Platforms(verifier.Test) {
		recent, err := st.Recent(testScope, p.ID, store.RecentPosition{}, 100)
		if err != nil {
			t.Fatal(err)
		}
		declared, fresh, err := st.Counts(testScope, p.ID, mustDate(t, today))
		if err != nil {
			t.Fatal(err)
		}
		out += fmt.Sprintf("recent %s %+v\ncounts %d %d\n", p.ID, recent, declared, fresh)
	}
	return out
}

func mustViewSeq(t *testing.T, h *harness) uint64 {
	t.Helper()
	seq, err := h.store.ViewSeq()
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

// A card proof the server accepts updates the views with the record; the
// views say what the rules say. After the views are emptied, starting the
// server builds them again, the same.
func TestViewsFromSubmissions(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	a, b := newCard(), newCard()
	h.mustSubmit(h.sub(a, root, "threads:alice"), "threads first")
	h.mustSubmit(h.sub(a, root, "test-example:a-b", "threads:bob"), "test-example first, threads correction")
	h.mustSubmit(h.sub(b, root, "threads:bob"), "threads first")
	h.clock.Set(startOfTests.Add(24 * time.Hour))
	h.mustSubmit(h.sub(a, root, "threads:carol"), "test-example withdraw, threads switch")
	h.mustSubmit(h.sub(b, root, "threads:bob"), "threads refresh")

	if seq := mustViewSeq(t, h); seq != 5 {
		t.Fatalf("ViewSeq %d after 5 records", seq)
	}
	cards, err := h.store.Cards(testScope, verifier.ShortID(a))
	if err != nil || len(cards) != 1 {
		t.Fatalf("%+v %v", cards, err)
	}
	ca := h.server.rules.Card(testScope, a)
	got := cards[0]
	if got.CardProofs != 3 || got.FirstCardProof.String() != "2026-11-20" || got.LastCardProof != *ca.LastCardProof ||
		len(got.Slots) != 2 || got.Slots[1].Current != *ca.Slots["threads"].Current || got.Slots[1].SwitchCount != 1 ||
		got.Slots[1].SinceSeq != 4 || got.Slots[0].Current != "" {
		t.Errorf("card %+v, the rules %+v", got, ca)
	}
	bob, err := h.store.AccountCards(testScope, "threads", "bob")
	if err != nil || len(bob) != 1 || bob[0].ScopedID != b || bob[0].SinceSeq != 3 || bob[0].LastCardProof.String() != "2026-11-21" {
		t.Errorf("bob: %+v %v", bob, err)
	}
	if n := h.server.rules.AccountCards(testScope, "threads", "bob"); n != len(bob) {
		t.Errorf("the rules count %d cards for bob", n)
	}

	before := viewsOf(t, h, "2026-11-21", []string{a, b}, "threads:alice", "threads:bob", "threads:carol", "test-example:a-b")
	if err := h.store.ResetViews(); err != nil {
		t.Fatal(err)
	}
	h.start()
	if seq := mustViewSeq(t, h); seq != 5 {
		t.Fatalf("ViewSeq %d after starting", seq)
	}
	if h.server.viewsFrom != 1 {
		t.Errorf("viewsFrom %d", h.server.viewsFrom)
	}
	if after := viewsOf(t, h, "2026-11-21", []string{a, b}, "threads:alice", "threads:bob", "threads:carol", "test-example:a-b"); after != before {
		t.Errorf("rebuilt at start\n%s\nwritten one at a time\n%s", after, before)
	}
	// Started again with the views up to date: nothing to write.
	h.start()
	if h.server.viewsFrom != 0 {
		t.Errorf("viewsFrom %d with the views up to date", h.server.viewsFrom)
	}
	// And the server goes on writing them.
	h.mustSubmit(h.sub(b, root, "threads:dave"), "threads switch")
	if seq := mustViewSeq(t, h); seq != 6 {
		t.Errorf("ViewSeq %d after one more", seq)
	}
}

// Records written without their views (here past the server, more than
// one batch of them) are caught up when the server starts.
func TestStartCatchesUpViews(t *testing.T) {
	c := g3CRL(t)
	root := rootOf(t, c)
	h := newHarness(t, startOfTests, c)
	h.mustSubmit(h.sub(newCard(), root, "threads:alice"), "threads first")
	for i := 0; i < 1001; i++ {
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
	}
	if seq := mustViewSeq(t, h); seq != 1 {
		t.Fatalf("ViewSeq %d", seq)
	}
	h.start()
	if seq := mustViewSeq(t, h); seq != 1002 || h.server.viewsFrom != 2 {
		t.Fatalf("ViewSeq %d, viewsFrom %d", seq, h.server.viewsFrom)
	}
	got, err := h.store.AccountCards(testScope, "threads", "alice")
	if err != nil || len(got) != 1002 {
		t.Fatalf("%d cards, %v", len(got), err)
	}
	if declared, fresh, err := h.store.Counts(testScope, "threads", mustDate(t, "2026-11-20")); err != nil || declared != 1002 || fresh != 1002 {
		t.Errorf("Counts %d %d %v", declared, fresh, err)
	}
	h.mustSubmit(h.sub(newCard(), root, "threads:bob"), "threads first")
	if seq := mustViewSeq(t, h); seq != 1003 {
		t.Errorf("ViewSeq %d", seq)
	}
}
