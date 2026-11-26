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
  // Which platform's way back from the links to show (design/motion/README.md, on the box that differs): Android's
  // on a browser that says it is Android, the iPhone's on every other. Chosen here, in the browser: the page is the
  // same for every device, and the server reads nothing of the device.
  const variant = /Android/.test(navigator.userAgent) ? "android" : "ios";
  const picture = demo.querySelector(".demo-picture");
  const row = demo.querySelector(".demo-row");
  const button = demo.querySelector("[data-demo-button]");
  const page = demo.closest(".hang");
  const steps = [...page.querySelectorAll("[data-step]")];
  const length = timeline.duration * 1000;
  const names = timeline.variants[variant];
  const box = (name) => row.querySelector(`[data-box="${names[name] ?? name}"]`);

  let animations = [];
  /** The demonstration in place of the still pictures, or the pictures again; the column is wider for the demonstration beside the steps. */
  const show = (on) => {
    // The style sheet draws the links' top for the platform said here.
    demo.dataset.variant = variant;
    demo.hidden = !on;
    page.classList.toggle("playing", on);
    page.parentElement.classList.toggle("with-demo", on);
  };
  // From here on the boxes have the places the camera is aimed by. Whatever goes wrong after this, the page is its pictures again.
  show(true);
  try {

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
    /** Watches for the picture coming onto the screen, until the demonstration has played once. */
    let seen = null;
    const play = () => {
      if (seen !== null) seen.disconnect();
      seen = null;
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

    // Once, when most of the picture is on the screen; on a screen lower than the picture, when the picture fills most of the screen.
    if (typeof IntersectionObserver === "function") {
      const most = 0.6;
      seen = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.intersectionRatio >= most || (entry.rootBounds !== null && entry.intersectionRect.height >= most * entry.rootBounds.height))) return;
          play();
        },
        { threshold: [0.1, 0.2, 0.3, 0.4, 0.5, most] },
      );
      seen.observe(picture);
    } else play();

    // Another width, or the headings' typeface arriving, is other places for the boxes: the same moment, aimed again.
    let width = picture.clientWidth;
    if (typeof ResizeObserver === "function") {
      let settled = 0;
      new ResizeObserver(() => {
        if (picture.clientWidth === width || picture.clientWidth === 0) return;
        width = picture.clientWidth;
        // Not at every width a window passes through while it is dragged: when it has stayed one for a moment.
        clearTimeout(settled);
        settled = setTimeout(build, 150);
      }).observe(picture);
    }
    if (document.fonts !== undefined) document.fonts.ready.then(build, () => {});
  } catch (error) {
    for (const a of animations) a.cancel();
    show(false);
    throw error;
  }
}
