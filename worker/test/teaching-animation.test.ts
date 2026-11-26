// The teaching animations (design/motion/): the two timelines make sense on
// their own, and src/teaching-animation.ts gives the answers of
// spec/vectors/teaching-animation.json, which the Android and iOS apps'
// implementations are tested against as well.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type HangEvent, hangStateAt, senseLength, senseStateAt } from "../src/teaching-animation.ts";
import { WORKER_DIR } from "./build.ts";
import { difference, hangTimeline, senseTimeline, vectors } from "./teaching-animation.ts";

const PLATFORMS = ["android", "ios"];
/** The six changes of the screens (design/motion/README.md). */
const CHANGES = ["copied", "pasteMenu", "pasted", "linkListed", "linkOnProfile", "resultLabel"];

const inOrder = (events: readonly { at: number }[], what: string) => {
  for (const [i, e] of events.entries()) {
    assert.ok(e.at >= 0, `${what}: event ${i} is before the start`);
    if (i > 0) assert.ok(e.at >= events[i - 1]!.at, `${what}: event ${i} (${e.at} s) is before the one above it`);
  }
};

test("hang.json makes sense on its own", () => {
  const tl = hangTimeline();
  const tap = tl.tap;
  inOrder(tl.events, "hang.json");
  assert.deepEqual(Object.keys(tl.variants).sort(), PLATFORMS);
  assert.deepEqual(Object.keys(tl.states).sort(), [...CHANGES].sort());
  assert.ok(tl.start in tl.frames, `the first framing ${tl.start} is defined`);
  // Every time a state divides by: none is 0. (The six changes may be: one that takes no time is done at once.)
  for (const [name, seconds] of Object.entries({ duration: tl.duration, fade: tl.mark.fade, pressIn: tap.pressIn, pressHold: tap.pressHold, pressOut: tap.pressOut, ring: tap.ring, holdIn: tap.holdIn, holdOut: tap.holdOut })) assert.ok(seconds > 0, `${name} is more than 0 s`);
  assert.ok(tap.from > 0 && tap.holdAt > tap.from && tap.to > tap.holdAt, "the ring only grows");
  for (const [name, seconds] of Object.entries(tl.states)) assert.ok(seconds >= 0, `${name} does not take less than 0 s`);
  for (const [name, f] of Object.entries(tl.frames)) {
    assert.ok(f.span > 0, `framing ${name} has a width`);
    for (const anchor of [f.x, f.y]) {
      assert.ok(anchor.t in tl.boxes, `framing ${name} pins the box ${anchor.t}, which is not in boxes`);
      for (const n of [anchor.a, anchor.v]) assert.ok(n >= 0 && n <= 1, `framing ${name}: ${n} is not between 0 and 1`);
    }
  }
  // A long press holds its ring until the finger lifts, so the ring has to have grown by then.
  for (const e of tl.events) if (e.do === "tap" && e.hold !== undefined) assert.ok(e.hold >= tap.holdIn, `the long press at ${e.at} s is shorter than its ring takes to grow`);

  for (const [platform, names] of Object.entries(tl.variants)) {
    const own = (name: string) => names[name] ?? name;
    // What differs by platform is named in the events and nowhere else: a platform's own name is a box and a framing.
    for (const [alias, name] of Object.entries(names)) {
      assert.ok(!(alias in tl.boxes) && !(alias in tl.frames), `${alias} is both a name of ${platform}'s and a box or a framing`);
      assert.ok(name in tl.boxes && name in tl.frames, `${platform}'s ${alias} is ${name}, which is not both a box and a framing`);
    }
    /** When what an event starts is over. */
    const end = (e: HangEvent): number => {
      if (e.do === "camera") return e.at + e.dur;
      if (e.do === "mark" || e.do === "unmark") return e.at + tl.mark.fade;
      if (e.do === "state") return e.at + (tl.states[e.state] ?? 0);
      if (e.do === "tap") return e.at + (e.hold ?? 0) + Math.max((e.hold ?? 0) > 0 ? tap.holdOut : tap.ring, tap.pressHold + tap.pressOut);
      return e.at;
    };
    const marked = new Map<string, number>();
    const changed = new Set<string>();
    let cameraFree = 0;
    let tapFree = 0;
    let step = 0;
    for (const e of tl.events) {
      const at = `${platform}, ${e.at} s`;
      // A hair over the duration is the sum of two decimals, not an event that runs late.
      assert.ok(end(e) <= tl.duration + 1e-9, `${at}: ${e.do} ends at ${end(e)} s, after the ${tl.duration} s of the whole`);
      if (e.do === "camera") {
        assert.ok(own(e.frame) in tl.frames, `${at}: the framing ${own(e.frame)} is not defined`);
        assert.ok(e.dur > 0, `${at}: the camera takes time to move`);
        assert.ok(e.at >= cameraFree - 1e-9, `${at}: the camera is still on its way from the move before`);
        cameraFree = end(e);
      } else if (e.do === "mark") {
        const box = own(e.target);
        assert.ok(box in tl.boxes, `${at}: the box ${box} is not defined`);
        assert.ok(!marked.has(box), `${at}: ${box} is marked twice`);
        marked.set(box, end(e));
      } else if (e.do === "unmark") {
        const box = own(e.target);
        assert.ok(marked.has(box), `${at}: ${box} is unmarked without a mark`);
        assert.ok(e.at >= marked.get(box)! - 1e-9, `${at}: ${box} is unmarked before its mark is all there`);
        marked.delete(box);
      } else if (e.do === "tap") {
        assert.ok(own(e.target) in tl.boxes, `${at}: the box ${own(e.target)} is not defined`);
        assert.ok(e.at >= tapFree - 1e-9, `${at}: the tap before is not over`);
        tapFree = end(e);
      } else if (e.do === "state") {
        assert.ok(e.state in tl.states, `${at}: the change ${e.state} is not one of the six`);
        assert.ok(!changed.has(e.state), `${at}: ${e.state} happens twice`);
        changed.add(e.state);
      } else {
        assert.ok(Number.isInteger(e.step) && e.step >= step && e.step <= 5, `${at}: step ${e.step} after step ${step}`);
        step = e.step;
      }
    }
    assert.deepEqual([...marked.keys()], [], `${platform}: every mark is taken off again`);
    assert.deepEqual([...changed].sort(), [...CHANGES].sort(), `${platform}: each of the six changes happens`);
    assert.equal(step, 5, `${platform}: the last step is the result`);
  }
});

test("hang.json is the 20.7 s the research settled, and the platforms differ in one box", () => {
  const tl = hangTimeline();
  assert.equal(tl.duration, 20.7);
  assert.equal(tl.events.length, 53);
  assert.deepEqual(tl.variants, { ios: { back: "done3" }, android: { back: "x3" } });
});

test("sense.json makes sense on its own", () => {
  const tl = senseTimeline();
  assert.equal(tl.rounds, 3);
  assert.deepEqual(tl.rest, { card: "stays", ring: false });
  assert.ok(tl.enter.from > 0 && tl.ring.to > tl.ring.from && tl.ring.from > 0);
  assert.deepEqual(Object.keys(tl.variants).sort(), PLATFORMS);
  for (const [platform, v] of Object.entries(tl.variants)) {
    inOrder(v.events, `sense.json, ${platform}`);
    assert.ok(v.duration > 0, `${platform}: a round takes time`);
    assert.equal(v.events[0]!.do, "enter", `${platform}: the card comes in first`);
    assert.equal(v.events.at(-1)!.do, "leave", `${platform}: the card leaves last`);
    for (const kind of ["enter", "ring", "leave"]) assert.equal(v.events.filter((e) => e.do === kind).length, 1, `${platform}: one ${kind} a round`);
    let free = 0;
    for (const e of v.events) {
      assert.ok(e.dur > 0, `${platform}, ${e.at} s: ${e.do} takes time`);
      // The card does one thing at a time: it is in before it moves, still before the ring, and the ring is gone before it leaves.
      assert.ok(e.at >= free - 1e-9, `${platform}, ${e.at} s: ${e.do} starts before what is above it is over`);
      free = e.at + e.dur;
      if (e.do === "enter" || e.do === "move") assert.ok(e.y >= 0 && e.y <= 1, `${platform}, ${e.at} s: ${e.y} is not on the phone`);
    }
    assert.ok(free <= v.duration + 1e-9, `${platform}: the last event ends at ${free} s, after the ${v.duration} s of a round`);
  }
  assert.equal(senseLength(tl, "android"), 8.75 * 2 + 8.05);
  assert.equal(senseLength(tl, "ios"), 3.75 * 2 + 3.05);
});

test("the states are the answers of spec/vectors/teaching-animation.json", () => {
  const v = vectors();
  const hang = hangTimeline();
  const sense = senseTimeline();
  assert.ok(v.hang.length >= 12 && v.sense.length >= 12, "a dozen moments of each");
  for (const c of v.hang) assert.equal(difference(hangStateAt(hang, c.variant, c.seconds), c.state, v.tolerance), null, `hang, ${c.name} (${c.seconds} s)`);
  for (const c of v.sense) assert.equal(difference(senseStateAt(sense, c.variant, c.seconds), c.state, v.tolerance), null, `sense, ${c.name} (${c.seconds} s)`);
});

test("the answers cover what the platforms have to agree on", () => {
  const v = vectors();
  const hang = hangTimeline();
  const sense = senseTimeline();
  const at = (seconds: number) => v.hang.filter((c) => c.seconds === seconds);
  assert.ok(at(0).length > 0 && at(hang.duration).length > 0, "the start and the last frame");
  assert.ok(v.hang.some((c) => c.seconds > hang.duration), "past the end");
  assert.ok(v.hang.some((c) => c.state.camera.progress > 0 && c.state.camera.progress < 1), "a camera on its way");
  assert.ok(v.hang.some((c) => Object.values(c.state.marks).some((m) => m > 0 && m < 1)), "a mark partly there");
  assert.ok(v.hang.some((c) => c.state.tap !== null && c.state.tap.ring.opacity < 1 && c.state.tap.pressed < 1), "a tap on its way out");
  assert.ok(v.hang.some((c) => Object.values(c.state.states).some((s) => s > 0 && s < 1)), "a change partly done");
  // A long press, held: the event has `hold`, and the moment is inside it.
  const holds = hang.events.filter((e) => e.do === "tap" && e.hold !== undefined) as { at: number; hold: number }[];
  assert.ok(holds.some((e) => v.hang.some((c) => c.seconds > e.at && c.seconds < e.at + e.hold)), "a long press being held");
  for (const step of [0, 1, 2, 3, 4, 5]) assert.ok(v.hang.some((c) => c.state.step === step), `step ${step}`);
  // The one difference between the platforms: the same moment, another box.
  const differing = v.hang.filter((c) => c.variant === "android" && c.state.camera.to === "x3").map((c) => c.seconds);
  assert.ok(differing.some((s) => v.hang.some((c) => c.variant === "ios" && c.seconds === s && c.state.camera.to === "done3")), "going back, on both platforms");
  for (const platform of PLATFORMS) {
    const cases = v.sense.filter((c) => c.variant === platform);
    for (const round of [1, 2, 3]) assert.ok(cases.some((c) => c.state.round === round), `${platform}, round ${round}`);
    assert.ok(cases.some((c) => c.state.stopped && c.seconds > senseLength(sense, platform)), `${platform}, at rest`);
    assert.ok(cases.some((c) => c.state.ring !== null), `${platform}, a ring`);
  }
});

// Where something ends (a tap, a ring, the last round), an implementation may
// say "nothing" or "a ring that is all gone": the same picture, and which one
// it says there depends on how it rounds. So no answer is that near an end.
test("no answer is at the moment something ends", () => {
  const v = vectors();
  const hang = hangTimeline();
  const sense = senseTimeline();
  const NEAR = 0.001;
  const tap = hang.tap;
  const hangEnds = hang.events.flatMap((e) => (e.do === "tap" ? [e.at + (e.hold ?? 0) + Math.max((e.hold ?? 0) > 0 ? tap.holdOut : tap.ring, tap.pressHold + tap.pressOut)] : []));
  for (const c of v.hang) for (const end of hangEnds) assert.ok(Math.abs(c.seconds - end) > NEAR, `hang, ${c.name}: ${c.seconds} s is where a tap ends`);
  for (const [platform, timeline] of Object.entries(sense.variants)) {
    const ends = [senseLength(sense, platform)];
    for (let round = 0; round < sense.rounds; round++) {
      if (round > 0) ends.push(round * timeline.duration);
      for (const e of timeline.events) if (e.do === "ring") ends.push(round * timeline.duration + e.at + e.dur);
    }
    for (const c of v.sense.filter((x) => x.variant === platform)) {
      // The start of a round is exact (a whole number of rounds), and the answers hold it on purpose.
      const exact = c.seconds % timeline.duration === 0;
      for (const end of ends) assert.ok(exact || Math.abs(c.seconds - end) > NEAR, `sense, ${c.name}: ${c.seconds} s is where something ends`);
    }
  }
});

test("a state depends on the timeline and the seconds, and on nothing asked before", () => {
  const hang = hangTimeline();
  const sense = senseTimeline();
  const moments = [0, 1.7, 11.9, 16.65, 20.7];
  const forward = moments.map((s) => hangStateAt(hang, "ios", s));
  const backward = [...moments].reverse().map((s) => hangStateAt(hang, "ios", s)).reverse();
  assert.deepEqual(backward, forward);
  assert.deepEqual(senseStateAt(sense, "android", 7.25), (senseStateAt(sense, "android", 25.6), senseStateAt(sense, "android", 7.25)));
  // The timelines are read, never written.
  assert.deepEqual(hang, hangTimeline());
  assert.deepEqual(sense, senseTimeline());
  assert.throws(() => hangStateAt(hang, "windows", 0), /no variant/);
  assert.throws(() => senseStateAt(sense, "windows", 0), /no variant/);
});

test("the file the site's player will carry imports nothing and touches no clock or page", () => {
  const source = readFileSync(join(WORKER_DIR, "src", "teaching-animation.ts"), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\b(Date|performance|setTimeout|setInterval|requestAnimationFrame|document|window)\b/);
});
