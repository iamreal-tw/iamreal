// Writes spec/vectors/teaching-animation.json: the two teaching animations
// (design/motion/) at a few moments each. Run in worker/:
//   node --experimental-strip-types test/generate/teaching-animation.ts
// Every answer is written here by hand, worked out from the timelines and
// design/motion/README.md and not with src/teaching-animation.ts. Before
// writing, each moment is asked of src/teaching-animation.ts; if one differs,
// nothing is written.
import { writeFileSync } from "node:fs";
import { type HangState, type Ring, type SenseState, hangStateAt, senseStateAt } from "../../src/teaching-animation.ts";
import { TOLERANCE, VECTORS_FILE, type Vectors, difference, hangTimeline, senseTimeline } from "../teaching-animation.ts";

// The two easings at half their time: cubic in and out is 0.5, quintic out is 1 - 0.5^5.
const HALF_OUT = 0.96875;

const NO_CHANGE = { copied: 0, pasteMenu: 0, pasted: 0, linkListed: 0, linkOnProfile: 0, resultLabel: 0 };
const START: HangState = { camera: { from: "s0", to: "s0", progress: 1 }, marks: {}, tap: null, states: NO_CHANGE, step: 0 };
/** A state that differs from the start in what is given. */
const hangState = (camera: [string, string, number], step: number, rest: Partial<Pick<HangState, "marks" | "tap">> & { states?: Partial<typeof NO_CHANGE> } = {}): HangState => ({
  camera: { from: camera[0], to: camera[1], progress: camera[2] },
  marks: rest.marks ?? {},
  tap: rest.tap ?? null,
  states: { ...NO_CHANGE, ...rest.states },
  step,
});
const ring = (scale: number, opacity: number): Ring => ({ scale, opacity });
/** A ring that has just come out: the smallest, and all there. */
const TAP_STARTS = ring(0.35, 1);
/** A tap's ring at half its time: 0.35 + (1.9 - 0.35) × 0.96875. */
const TAP_HALF = ring(1.8515625, 0.03125);
const PASTED = { copied: 1, pasteMenu: 1, pasted: 1 };
const LISTED = { ...PASTED, linkListed: 1 };
/** The last frame: the camera on the line of the link, every change done. */
const LAST = hangState(["s1", "linkrow", 1], 5, { states: { ...LISTED, linkOnProfile: 1, resultLabel: 1 } });

const hang: Vectors["hang"] = [];
const h = (name: string, seconds: number, state: HangState, variant = "ios") => hang.push({ name, variant, seconds, state });
/** The same moment on both platforms, where what they go back with differs. */
const both = (name: string, seconds: number, state: (back: string) => HangState) => {
  h(`${name}, on iOS`, seconds, state("done3"), "ios");
  h(`${name}, on Android`, seconds, state("x3"), "android");
};

h("before the start is the start", -1, START);
h("the start: the first screen whole, nothing marked, no step past the buttons", 0, START);
h("a camera move, halfway", 0.825, hangState(["s0", "copy", 0.5], 0));
h("a mark, halfway in; the camera has arrived", 1.275, hangState(["s0", "copy", 1], 0, { marks: { copy: 0.5 } }));
h("a tap, as it starts: nothing pressed yet, the ring out", 1.4, hangState(["s0", "copy", 1], 0, { marks: { copy: 1 }, tap: { target: "copy", pressed: 0, ring: TAP_STARTS } }));
h(
  "a tap, halfway through its ring: the press coming up, the mark going, the button's text changing",
  1.7,
  // The press: 1 - (0.3 - 0.12) / 0.3. The mark: 1 - 0.15 / 0.25. The change: 9/14 of its time gone, 1 - (5/14)^5.
  hangState(["s0", "copy", 1], 0, { marks: { copy: 0.4 }, tap: { target: "copy", pressed: 0.4, ring: TAP_HALF }, states: { copied: 0.99419 } }),
);
h("a tap, a mark and a change, all over", 2.05, hangState(["s0", "copy", 1], 0, { states: { copied: 1 } }));
h(
  "a step changes as the camera leaves for the next screen",
  3.1,
  hangState(["open", "s1", 0], 1, { marks: { open: 0.4 }, tap: { target: "open", pressed: 0.4, ring: TAP_HALF }, states: { copied: 1 } }),
);
h("the second step: the screen of editing the profile, whole", 6.2, hangState(["edit", "s2", 1], 2, { states: { copied: 1 } }));
h("the third step: the screen of the links, whole", 8.4, hangState(["links", "s3", 1], 3, { states: { copied: 1 } }));
h(
  "a long press, its ring growing",
  11.775,
  // Half of the 0.25 s it grows in: 0.35 + (0.9 - 0.35) × 0.96875.
  hangState(["s4", "urlfield", 1], 4, { marks: { urlfield: 1 }, tap: { target: "urlfield", pressed: 1, ring: ring(0.8828125, HALF_OUT) }, states: { copied: 1 } }),
);
h(
  "a long press, halfway: held down, the ring waiting",
  11.9,
  hangState(["s4", "urlfield", 1], 4, { marks: { urlfield: 1 }, tap: { target: "urlfield", pressed: 1, ring: ring(0.9, 1) }, states: { copied: 1 } }),
);
h(
  "a long press, let go: the ring going out, the paste bubble halfway in",
  12.3,
  // The ring: 0.15 of its 0.5 s gone, 1 - 0.7^5 = 0.83193, from 0.9 to 1.9. The press: 1 - (0.65 - 0.62) / 0.3.
  hangState(["s4", "urlfield", 1], 4, { marks: { urlfield: 1 }, tap: { target: "urlfield", pressed: 0.9, ring: ring(1.73193, 0.16807) }, states: { copied: 1, pasteMenu: HALF_OUT } }),
);
h(
  "the tap on the paste bubble",
  12.75,
  // A sixth of the ring's time: 1 - (5/6)^5 = 0.598122, from 0.35 to 1.9.
  hangState(["s4", "urlfield", 1], 4, { marks: { urlfield: 1 }, tap: { target: "paste", pressed: 1, ring: ring(1.27709, 0.401878) }, states: { copied: 1, pasteMenu: 1 } }),
);
h("the address is in the field", 13.3, hangState(["s4", "urlfield", 1], 4, { marks: { urlfield: 1 }, states: PASTED }));
h(
  "a change that takes no time: the list has the link while the camera is still moving",
  15,
  // 7/15 of the camera's time: 4 × (7/15)^3.
  hangState(["done4", "s3", 0.406519], 4, { states: LISTED }),
);
both("the camera halfway to what goes back", 16.075, (back) => hangState(["s3", back, 0.5], 4, { states: LISTED }));
both("the tap that goes back, as it starts", 16.65, (back) => hangState(["s3", back, 1], 4, { marks: { [back]: 1 }, tap: { target: back, pressed: 0, ring: TAP_STARTS }, states: LISTED }));
both("the camera halfway back to the profile, the link already on it", 17.45, (back) => hangState([back, "s1", 0.5], 5, { states: { ...LISTED, linkOnProfile: 1 } }));
h("the label of the result, halfway in", 19.375, hangState(["s1", "linkrow", 1], 5, { states: { ...LISTED, linkOnProfile: 1, resultLabel: HALF_OUT } }));
h("the last frame, on iOS", 20.7, LAST);
h("the last frame, on Android", 20.7, LAST, "android");
h("past the end is the last frame", 25, LAST);

const sense: Vectors["sense"] = [];
const t = (name: string, variant: string, seconds: number, round: number, card: [number, number, number], ringNow: Ring | null = null, stopped = false) => {
  const state: SenseState = { round, stopped, card: { y: card[0], x: card[1], opacity: card[2] }, ring: ringNow };
  sense.push({ name, variant, seconds, state });
};
// The card halfway in: 1.39 × (1 - 0.96875) phone widths still to go.
const COMING_X = 0.043438;
// A ring at half its time: 0.3 + (1.7 - 0.3) × 0.96875.
const RING_HALF = ring(1.65625, 0.03125);

t("Android, before the start is the start", "android", -1, 1, [0.735, 1.39, 0]);
t("Android, the start: the card waits unseen, to the right of where it comes in", "android", 0, 1, [0.735, 1.39, 0]);
t("Android, the card halfway in", "android", 1, 1, [0.735, COMING_X, HALF_OUT]);
// Halfway from 0.735 to 0.19.
t("Android, the first move up, halfway", "android", 2.35, 1, [0.4625, 0, 1]);
t("Android, where the phone reads it, before the ring", "android", 6.75, 1, [0.375, 0, 1]);
t("Android, the ring as it starts", "android", 6.85, 1, [0.375, 0, 1], ring(0.3, 1));
t("Android, the ring halfway", "android", 7.25, 1, [0.375, 0, 1], RING_HALF);
t("Android, the first round leaving, halfway", "android", 8.25, 1, [0.375, 0, 0.5]);
t("Android, the first round gone", "android", 8.6, 1, [0.375, 0, 0]);
t("Android, the second round starts as the first did", "android", 8.75, 2, [0.735, 1.39, 0]);
t("Android, the second round, the card halfway in", "android", 9.75, 2, [0.735, COMING_X, HALF_OUT]);
t("Android, the second round, the first move up, halfway", "android", 11.1, 2, [0.4625, 0, 1]);
t("Android, the third round, the ring halfway", "android", 24.75, 3, [0.375, 0, 1], RING_HALF);
t("Android, the third round, the ring gone, not yet at rest", "android", 25.5, 3, [0.375, 0, 1]);
t("Android, at rest: the third round does not leave", "android", 25.6, 3, [0.375, 0, 1], null, true);
t("Android, long after: still at rest", "android", 60, 3, [0.375, 0, 1], null, true);
t("iPhone, the start", "ios", 0, 1, [0.213, 1.39, 0]);
t("iPhone, the card halfway in", "ios", 1, 1, [0.213, COMING_X, HALF_OUT]);
t("iPhone, the ring halfway", "ios", 2.25, 1, [0.213, 0, 1], RING_HALF);
t("iPhone, the first round leaving, halfway", "ios", 3.25, 1, [0.213, 0, 0.5]);
t("iPhone, the second round, the card halfway in", "ios", 4.75, 2, [0.213, COMING_X, HALF_OUT]);
t("iPhone, the third round, the ring halfway", "ios", 9.75, 3, [0.213, 0, 1], RING_HALF);
t("iPhone, at rest", "ios", 10.6, 3, [0.213, 0, 1], null, true);
t("iPhone, long after: still at rest", "ios", 60, 3, [0.213, 0, 1], null, true);

const hangTl = hangTimeline();
const senseTl = senseTimeline();
const wrong: string[] = [];
for (const c of hang) {
  const d = difference(hangStateAt(hangTl, c.variant, c.seconds), c.state, TOLERANCE);
  if (d !== null) wrong.push(`hang, ${c.name} (${c.seconds} s): ${d}`);
}
for (const c of sense) {
  const d = difference(senseStateAt(senseTl, c.variant, c.seconds), c.state, TOLERANCE);
  if (d !== null) wrong.push(`sense, ${c.name} (${c.seconds} s): ${d}`);
}
if (wrong.length > 0) {
  console.error(wrong.join("\n"));
  console.error("src/teaching-animation.ts does not give these answers. Nothing written.");
  process.exit(1);
}

const out: Vectors = {
  description:
    "The teaching animations at given moments (design/motion/README.md). Each case: with the timeline of `timelines` and the platform `variant`, the state `seconds` after the start. A number of an implementation's state is right when it is within `tolerance` of the number here; everything else is the same or it is wrong.",
  timelines: { hang: "design/motion/hang.json", sense: "design/motion/sense.json" },
  tolerance: TOLERANCE,
  hang,
  sense,
};
writeFileSync(VECTORS_FILE, JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${hang.length} moments of hanging the link and ${sense.length} of the card's place to ${VECTORS_FILE}.`);
