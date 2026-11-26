// Written by scripts/site-files.ts from src/teaching-animation.ts and demo/player.js: change those, not this file.
"use strict";
(() => {
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

/** A framing of the camera: the picture is `span` units wide, and one point on each axis is pinned. */

/** design/motion/hang.json. */

/** design/motion/sense.json. */

/** Cubic ease in and out: the camera, and the card moving along the phone. */
function easeInOut(p        )         {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

/** Quintic ease out: the rings, the changes of the screens, and the card coming in. */
function easeOut(p        )         {
  return 1 - (1 - p) ** 5;
}

/** How far a change that started at `at` and takes `dur` has gone at `t`, 0 to 1; one that takes no time is done at once. */
function gone(t        , at        , dur        )         {
  return dur > 0 ? Math.min(1, (t - at) / dur) : 1;
}

/** `seconds` kept within the timeline: before its start is its start, after its end is its end. */
function within(seconds        , end        )         {
  return seconds > 0 ? Math.min(seconds, end) : 0;
}

/** The picture of hanging the link, `seconds` after it starts, for the platform `variant` ("ios" or "android"). */
function hangStateAt(timeline              , variant        , seconds        )            {
  const names = timeline.variants[variant];
  if (names === undefined) throw new Error(`no variant ${variant}`);
  // An event may name a box or a framing that differs by platform ("back"); the state names the platform's own.
  const own = (name        )         => names[name] ?? name;
  const t = within(seconds, timeline.duration);
  const tap = timeline.tap;

  const state            = { camera: { from: timeline.start, to: timeline.start, progress: 1 }, marks: {}, tap: null, states: {}, step: 0 };
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
        let ring      ;
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
function senseLength(timeline               , variant        )         {
  const v = timeline.variants[variant];
  if (v === undefined) throw new Error(`no variant ${variant}`);
  const leave = v.events.find((e) => e.do === "leave");
  return v.duration * (timeline.rounds - 1) + (leave === undefined ? v.duration : leave.at);
}

/** The picture of where the card goes, `seconds` after it starts, for the platform `variant` ("ios" or "android"). */
function senseStateAt(timeline               , variant        , seconds        )             {
  const length = senseLength(timeline, variant);
  const v = timeline.variants[variant] ;
  const t = within(seconds, length);
  const round = Math.min(timeline.rounds, Math.floor(t / v.duration) + 1);
  const local = t - (round - 1) * v.duration;

  const card = { y: 0, x: timeline.enter.from, opacity: 0 };
  let ring              = null;
  let placed = false;
  for (const e of v.events) {
    // Before the card comes in it waits, unseen, to the right of where it will come in.
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

// The player of the demonstration on the page of hanging a proof
// (design/copy/hang.md, its section on the demonstration; design/motion/README.md). It is the second half
// of site/demo.js: scripts/site-files.ts writes that file from
// src/teaching-animation.ts, with its types taken off, and this one, so the
// functions used here (`hangStateAt`) are the ones the answers of
// spec/vectors/teaching-animation.json are for.
//
// The page is whole without this script: the four pictures of the steps and
// the picture of the result. The demonstration is in the page hidden, and its
// timeline is in the page as data. Shown here, in place of those pictures,
// only where the browser can play it. No library, nothing sent anywhere.
//
// What moves is asked of `hangStateAt` sixty times a second of the timeline,
// once, before anything plays, and given to the browser as keyframes
// (Element.animate): the browser keeps the time, and this script writes no
// style of its own on any element.
const demo = document.querySelector("[data-demo]");
const data = demo === null ? null : document.getElementById(demo.dataset.demo);
if (demo !== null && data !== null && typeof demo.animate === "function") {
  const timeline = JSON.parse(data.textContent);
  const variant = demo.dataset.variant;
  const picture = demo.querySelector(".demo-picture");
  const row = demo.querySelector(".demo-row");
  const button = demo.querySelector("[data-demo-button]");
  const page = demo.closest(".hang");
  const steps = [...page.querySelectorAll("[data-step]")];
  const length = timeline.duration * 1000;
  const names = timeline.variants[variant];
  const box = (name) => row.querySelector(`[data-box="${names[name] ?? name}"]`);

  // In place of the still pictures. From here on the boxes have the places the camera is aimed by.
  demo.hidden = false;
  page.classList.add("playing");

  /** Where an element is in the row, as laid out: the row's own transform and the parts that shift do not count. */
  const placeOf = (element) => {
    const place = { left: 0, top: 0, width: element.offsetWidth, height: element.offsetHeight };
    for (let e = element; e !== null && e !== row; e = e.offsetParent) {
      place.left += e.offsetLeft;
      place.top += e.offsetTop;
    }
    return place;
  };

  /** A framing as the row's place and scale (design/motion/README.md, on framings). */
  const poseOf = (name) => {
    const frame = timeline.frames[names[name] ?? name];
    const scale = picture.clientWidth / ((frame.span * box("s0").offsetWidth) / timeline.screen);
    const x = placeOf(box(frame.x.t));
    const y = placeOf(box(frame.y.t));
    return { scale, x: picture.clientWidth * frame.x.v - scale * (x.left + x.width * frame.x.a), y: picture.clientHeight * frame.y.v - scale * (y.top + y.height * frame.y.a) };
  };

  const fixed = (n) => String(Math.round(n * 1000) / 1000);
  const shown = (n) => ({ opacity: fixed(n) });

  /** Every element that changes, with what it is at a state. */
  const tracksOf = () => {
    // Only the framings this platform's events use: the other platform's box is not in the page.
    const poses = new Map();
    const pose = (name) => poses.get(name) ?? poses.set(name, poseOf(name)).get(name);
    const tracks = [
      [
        row,
        (state) => {
          const from = pose(state.camera.from);
          const to = pose(state.camera.to);
          const at = (key) => from[key] + (to[key] - from[key]) * state.camera.progress;
          return { transform: `translate(${fixed(at("x"))}px, ${fixed(at("y"))}px) scale(${fixed(at("scale"))})` };
        },
      ],
    ];
    for (const element of row.querySelectorAll("[data-box]")) {
      const name = element.dataset.box;
      for (const mark of element.querySelectorAll(":scope > .mark, :scope > .mark-tag")) tracks.push([mark, (state) => shown(state.marks[name] ?? 0)]);
      const pressed = element.querySelector(":scope > .pressed");
      if (pressed !== null) tracks.push([pressed, (state) => shown(state.tap !== null && state.tap.target === name ? state.tap.pressed * timeline.tap.press : 0)]);
      const ring = element.querySelector(":scope > .ring");
      if (ring !== null) {
        tracks.push([
          ring,
          (state) => (state.tap !== null && state.tap.target === name ? { opacity: fixed(state.tap.ring.opacity), transform: `scale(${fixed(state.tap.ring.scale)})` } : { opacity: "0", transform: `scale(${fixed(timeline.tap.from)})` }),
        ]);
      }
    }
    // A part that is there once a change has happened (data-on), until another has (data-off).
    for (const element of row.querySelectorAll("[data-on], [data-off]")) {
      const { on, off } = element.dataset;
      tracks.push([element, (state) => shown((on === undefined ? 1 : state.states[on]) * (off === undefined ? 1 : 1 - state.states[off]))]);
    }
    // A part that moves down to make room for one that came: "change:pixels", one or more.
    for (const element of row.querySelectorAll("[data-shift]")) {
      const shifts = element.dataset.shift.split(" ").map((s) => s.split(":"));
      tracks.push([element, (state) => ({ transform: `translateY(${fixed(shifts.reduce((sum, [change, by]) => sum + state.states[change] * Number(by), 0))}px)` })]);
    }
    return tracks;
  };

  /** The moments asked: sixty a second, and the last one. */
  const moments = [];
  for (let ms = 0; ms < length; ms += 1000 / 60) moments.push(ms);
  moments.push(length);

  let animations = [];
  const build = () => {
    const at = animations.length === 0 ? 0 : animations[0].currentTime;
    const running = animations.length > 0 && animations[0].playState === "running";
    for (const a of animations) a.cancel();
    const tracks = tracksOf();
    const frames = tracks.map(() => []);
    for (const ms of moments) {
      const state = hangStateAt(timeline, variant, ms / 1000);
      for (const [i, [, draw]] of tracks.entries()) frames[i].push({ offset: ms / length, ...draw(state) });
    }
    animations = tracks.map(([element], i) => {
      // A moment that is the same as the one before it and the one after it says nothing.
      const same = (a, b) => a.opacity === b.opacity && a.transform === b.transform;
      const kept = frames[i].filter((frame, k, all) => k === 0 || k === all.length - 1 || !same(frame, all[k - 1]) || !same(frame, all[k + 1]));
      const animation = element.animate(kept, { duration: length, fill: "both" });
      animation.pause();
      animation.currentTime = at;
      return animation;
    });
    animations[0].onfinish = () => showPlaying(false);
    if (running) for (const a of animations) a.play();
    showStep();
  };

  /** The written step being shown is marked; the buttons above them (0) and the result (5) are no step. */
  const showStep = () => {
    const now = hangStateAt(timeline, variant, (animations[0].currentTime ?? 0) / 1000).step;
    for (const step of steps) step.classList.toggle("now", Number(step.dataset.step) === now);
  };
  const follow = () => {
    showStep();
    if (animations[0].playState === "running") requestAnimationFrame(follow);
  };

  /** The one button says what it does: it stops while the demonstration plays, and plays it again otherwise. */
  const showPlaying = (playing) => {
    demo.dataset.playing = String(playing);
    button.textContent = playing ? button.dataset.stop : button.dataset.replay;
    showStep();
  };
  const play = () => {
    for (const a of animations) {
      a.currentTime = 0;
      a.play();
    }
    showPlaying(true);
    requestAnimationFrame(follow);
  };
  // Stopping goes to the last frame: the picture then shows where the link ends up.
  const stop = () => {
    for (const a of animations) a.finish();
    showPlaying(false);
  };

  build();
  showPlaying(false);
  button.addEventListener("click", () => (demo.dataset.playing === "true" ? stop() : play()));

  // Once, when most of the picture is on the screen.
  if (typeof IntersectionObserver === "function") {
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        seen.disconnect();
        play();
      },
      { threshold: 0.6 },
    );
    seen.observe(picture);
  } else play();

  // Another width, or the headings' typeface arriving, is other places for the boxes: the same moment, aimed again.
  let width = picture.clientWidth;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (picture.clientWidth === width || picture.clientWidth === 0) return;
      width = picture.clientWidth;
      build();
    }).observe(picture);
  }
  if (document.fonts !== undefined) document.fonts.ready.then(build, () => {});
}
})();
