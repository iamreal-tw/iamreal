// The mark of a test roster (design/copy/test-site.md): the first thing on
// every page of a test site, above the page's own header. Only the test
// site's build has one (src/target-test-site.ts); the sentence and the date
// are the build's, not written here.
import { TEST_ROSTER_MARK } from "../target.ts";
import { el } from "./dom.ts";

/** Puts the mark at the top of the page, if the build is a test site's. */
export function showTestRosterMark(): void {
  if (TEST_ROSTER_MARK === null) return;
  document.body.prepend(el("p", { class: "test-roster" }, TEST_ROSTER_MARK.sentence, el("time", {}, TEST_ROSTER_MARK.clearedOn)));
}
