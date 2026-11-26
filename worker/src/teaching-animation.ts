// The two teaching animations (hanging the link on a profile, where the card
// goes on the phone) at one moment: given a timeline of design/motion/ and a
// number of seconds, what the picture is then. design/motion/README.md says
// what each value means; spec/vectors/teaching-animation.json holds the
// answers this file, the Android app's and the iOS app's are tested against.
//
// Pure: no clock, no page, nothing kept between two calls, so any moment can
// be asked for in any order. The Worker does not run this. It is what the
// site's player carries to the browser, so it imports nothing and uses only
// syntax that is erased with the types.

/** Where a box's point goes in the picture: point `a` (0 to 1) of box `t` at `v` (0 to 1) of the picture. */
export interface Anchor {
  t: string;
  a: number;
  v: number;
}

/** A framing of the camera: the picture is `span` units wide, and one point on each axis is pinned. */
export interface Frame {
  span: number;
  x: Anchor;
  y: Anchor;
}

export type HangEvent =
  | { at: number; do: "camera"; frame: string; dur: number }
  | { at: number; do: "mark"; target: string }
  | { at: number; do: "unmark"; target: string }
  | { at: number; do: "tap"; target: string; hold?: number }
  | { at: number; do: "state"; state: string }
  | { at: number; do: "step"; step: number };

/** design/motion/hang.json. */
export interface HangTimeline {
  version: number;
  duration: number;
  picture: { width: number; height: number };
  screen: number;
  start: string;
  mark: { fade: number };
  tap: { press: number; pressIn: number; pressHold: number; pressOut: number; ring: number; from: number; to: number; holdIn: number; holdAt: number; holdOut: number };
  states: Record<string, number>;
  variants: Record<string, Record<string, string>>;
  boxes: Record<string, string>;
  frames: Record<string, Frame>;
  events: HangEvent[];
}

export interface Ring {
  scale: number;
  opacity: number;
}

export interface HangState {
  /** The camera is `progress` of the way from the framing `from` to the framing `to`. */
  camera: { from: string; to: string; progress: number };
  /** How much the mark of each box shows, 0 to 1; a box that is not here has none. */
  marks: Record<string, number>;
  /** The box being pressed, how far down it is (0 to 1) and its ring; null when nothing is. */
  tap: { target: string; pressed: number; ring: Ring } | null;
  /** How far each change of the screens has gone, 0 to 1. */
  states: Record<string, number>;
  /** Which of the written steps is being shown: 0 the buttons, 1 to 4 the steps, 5 the result. */
  step: number;
}

export type TapEvent =
  | { at: number; do: "enter" | "move"; y: number; dur: number }
  | { at: number; do: "ring" | "leave"; dur: number };

/** design/motion/tap.json. */
export interface TapTimeline {
  version: number;
  rounds: number;
  rest: { card: string; ring: boolean };
  enter: { from: number };
  ring: { from: number; to: number };
  variants: Record<string, { duration: number; events: TapEvent[] }>;
}

export interface TapState {
  /** 1 for the first round. */
  round: number;
  /** True from the moment the last round rests. */
  stopped: boolean;
  /** The card's centre: `y` down the phone (0 top, 1 bottom), `x` phone widths to the side of its place; and how much of it shows. */
  card: { y: number; x: number; opacity: number };
  ring: Ring | null;
}

/** Cubic ease in and out: the camera, and the card moving along the phone. */
export function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

/** Quintic ease out: the rings, the changes of the screens, and the card coming in. */
export function easeOut(p: number): number {
  return 1 - (1 - p) ** 5;
}

/** How far a change that started at `at` and takes `dur` has gone at `t`, 0 to 1; one that takes no time is done at once. */
function gone(t: number, at: number, dur: number): number {
  return dur > 0 ? Math.min(1, (t - at) / dur) : 1;
}

/** `seconds` kept within the timeline: before its start is its start, after its end is its end. */
function within(seconds: number, end: number): number {
  return seconds > 0 ? Math.min(seconds, end) : 0;
}

/** The picture of hanging the link, `seconds` after it starts, for the platform `variant` ("ios" or "android"). */
export function hangStateAt(timeline: HangTimeline, variant: string, seconds: number): HangState {
  const names = timeline.variants[variant];
  if (names === undefined) throw new Error(`no variant ${variant}`);
  // An event may name a box or a framing that differs by platform ("back"); the state names the platform's own.
  const own = (name: string): string => names[name] ?? name;
  const t = within(seconds, timeline.duration);
  const tap = timeline.tap;

  const state: HangState = { camera: { from: timeline.start, to: timeline.start, progress: 1 }, marks: {}, tap: null, states: {}, step: 0 };
  for (const name of Object.keys(timeline.states)) state.states[name] = 0;

  for (const e of timeline.events) {
    if (e.at > t) break;
    const dt = t - e.at;
    switch (e.do) {
      case "camera":
        state.camera = { from: state.camera.to, to: own(e.frame), progress: easeInOut(gone(t, e.at, e.dur)) };
        break;
      case "mark":
        state.marks[own(e.target)] = gone(t, e.at, timeline.mark.fade);
        break;
      case "unmark":
        state.marks[own(e.target)] = 1 - gone(t, e.at, timeline.mark.fade);
        break;
      case "state":
        state.states[e.state] = easeOut(gone(t, e.at, timeline.states[e.state] ?? 0));
        break;
      case "step":
        state.step = e.step;
        break;
      case "tap": {
        const hold = e.hold ?? 0;
        // The ring of a tap goes out at once; the ring of a long press grows, waits for the finger, then goes out.
        const over = hold + Math.max(hold > 0 ? tap.holdOut : tap.ring, tap.pressHold + tap.pressOut);
        if (dt >= over) {
          state.tap = null;
          break;
        }
        const pressed = dt < tap.pressIn ? dt / tap.pressIn : dt < tap.pressHold + hold ? 1 : Math.max(0, 1 - (dt - tap.pressHold - hold) / tap.pressOut);
        let ring: Ring;
        if (hold > 0 && dt < hold) {
          const p = easeOut(gone(dt, 0, tap.holdIn));
          ring = { scale: tap.from + (tap.holdAt - tap.from) * p, opacity: p };
        } else {
          const p = hold > 0 ? easeOut(gone(dt, hold, tap.holdOut)) : easeOut(gone(dt, 0, tap.ring));
          const from = hold > 0 ? tap.holdAt : tap.from;
          ring = { scale: from + (tap.to - from) * p, opacity: 1 - p };
        }
        state.tap = { target: own(e.target), pressed, ring };
        break;
      }
    }
  }
  for (const [box, shows] of Object.entries(state.marks)) if (shows <= 0) delete state.marks[box];
  return state;
}

/** How long the picture of the card's place plays for `variant` before it rests: every round but the last whole, the last up to where it would leave. */
export function tapLength(timeline: TapTimeline, variant: string): number {
  const v = timeline.variants[variant];
  if (v === undefined) throw new Error(`no variant ${variant}`);
  const leave = v.events.find((e) => e.do === "leave");
  return v.duration * (timeline.rounds - 1) + (leave === undefined ? v.duration : leave.at);
}

/** The picture of where the card goes, `seconds` after it starts, for the platform `variant` ("ios" or "android"). */
export function tapStateAt(timeline: TapTimeline, variant: string, seconds: number): TapState {
  const length = tapLength(timeline, variant);
  const v = timeline.variants[variant]!;
  const t = within(seconds, length);
  const round = Math.min(timeline.rounds, Math.floor(t / v.duration) + 1);
  const local = t - (round - 1) * v.duration;

  const card = { y: 0, x: timeline.enter.from, opacity: 0 };
  let ring: Ring | null = null;
  let placed = false;
  for (const e of v.events) {
    // Before the card comes in it waits, unseen, beside where it will come in.
    if (e.do === "enter" && !placed) {
      card.y = e.y;
      placed = true;
    }
    if (e.at > local) continue;
    const dt = local - e.at;
    if (e.do === "enter") {
      const p = easeOut(gone(dt, 0, e.dur));
      card.x = timeline.enter.from * (1 - p);
      card.opacity = p;
    } else if (e.do === "move") {
      card.y += (e.y - card.y) * easeInOut(gone(dt, 0, e.dur));
    } else if (e.do === "ring") {
      if (dt < e.dur) {
        const p = easeOut(dt / e.dur);
        ring = { scale: timeline.ring.from + (timeline.ring.to - timeline.ring.from) * p, opacity: 1 - p };
      }
    } else if (round < timeline.rounds) {
      // The last round does not leave: the card stays where the phone read it.
      card.opacity = 1 - gone(dt, 0, e.dur);
    }
  }
  return { round, stopped: t >= length, card, ring };
}
