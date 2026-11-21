// The mark of a test roster (design/copy/test-site.md): the first thing on
// every page of a test site, above the page's own header. This file is an
// entry of its own, which vite.config.ts adds to the pages in mode
// "testsite" and in no other: no other build holds it, and the production
// build is the same with and without it in the repository
// (test/build.test.ts).
//
// The sentence, the date the roster was last cleared on and the scope
// string the build's target signs are the build's: one JSON text
// (`__IAMREAL_TEST_ROSTER_MARK__`), kept as it is in the script so that who
// deploys can read it there (worker/scripts/proof-page.ts). Nothing here
// writes a sentence of its own.
import "./test-roster.css";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { ROSTER } from "../target.ts";

declare const __IAMREAL_TEST_ROSTER_MARK__: string;

const mark = JSON.parse(__IAMREAL_TEST_ROSTER_MARK__) as { sentence: string; clearedOn: string; scope: string };
const p = document.createElement("p");
p.className = "test-roster";
// The scope string the page's own target gives the card to sign, as the page runs: the headless test reads it here.
p.dataset.scope = scopeOf(ROSTER);
const time = document.createElement("time");
time.textContent = mark.clearedOn;
p.append(mark.sentence, time);
document.body.prepend(p);
