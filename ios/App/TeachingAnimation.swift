import Foundation

/// The demonstration of hanging the link on a profile at one moment: given
/// the timeline of design/motion/hang.json, the platform and a number of
/// seconds, what the picture is then. design/motion/README.md says what
/// each value means; spec/vectors/teaching-animation.json holds the answers
/// this file, the Android app's and the site's are tested against.
///
/// Pure: no clock, no screen, nothing kept between two calls, so any moment
/// can be asked for in any order. The timeline is the app's copy of the
/// file of design/motion/, as it is in the repository (BundledFile).
struct HangTimeline: Decodable, Equatable {
    /// Where a box's point goes in the picture: point `a` (0 to 1) of box
    /// `t` at `v` (0 to 1) of the picture.
    struct Anchor: Decodable, Equatable {
        let t: String
        let a: Double
        let v: Double
    }

    /// A framing of the camera: the picture is `span` units wide, and one
    /// point on each axis is pinned.
    struct Frame: Decodable, Equatable {
        let span: Double
        let x: Anchor
        let y: Anchor
    }

    struct Picture: Decodable, Equatable {
        let width: Double
        let height: Double
    }

    struct Mark: Decodable, Equatable {
        let fade: Double
    }

    struct Tap: Decodable, Equatable {
        let press: Double
        let pressIn: Double
        let pressHold: Double
        let pressOut: Double
        let ring: Double
        let from: Double
        let to: Double
        let holdIn: Double
        let holdAt: Double
        let holdOut: Double
    }

    /// One event; which of the other fields it has goes by `do`.
    struct Event: Decodable, Equatable {
        let at: Double
        let `do`: String
        let frame: String?
        let dur: Double?
        let target: String?
        let hold: Double?
        let state: String?
        let step: Int?
    }

    let duration: Double
    let picture: Picture
    /// How many units wide one of the five screens is.
    let screen: Double
    let start: String
    let mark: Mark
    let tap: Tap
    /// How long each change of the screens takes, by its name.
    let states: [String: Double]
    /// The names that differ by platform: `back`.
    let variants: [String: [String: String]]
    let frames: [String: Frame]
    let events: [Event]

    /// A box or a framing as this platform has it: `back` is its own.
    func own(_ name: String, for variant: String) -> String {
        variants[variant]?[name] ?? name
    }
}

struct HangState: Equatable {
    struct Camera: Equatable {
        var from: String
        var to: String
        var progress: Double
    }

    struct Ring: Equatable {
        var scale: Double
        var opacity: Double
    }

    struct Tap: Equatable {
        var target: String
        /// How far down it is, 0 to 1.
        var pressed: Double
        var ring: Ring
    }

    /// The camera is `progress` of the way from the framing `from` to the framing `to`.
    var camera: Camera
    /// How much the mark of each box shows, above 0 to 1; a box that is not here has none.
    var marks: [String: Double] = [:]
    /// The box being pressed; nil when nothing is.
    var tap: Tap?
    /// How far each change of the screens has gone, 0 to 1.
    var states: [String: Double] = [:]
    /// Which of the written steps is being shown: 0 the buttons, 1 to 4 the steps, 5 the result.
    var step = 0
}

enum TeachingAnimation {
    struct NoVariant: Error {}

    /// Cubic ease in and out: the camera.
    static func easeInOut(_ p: Double) -> Double {
        p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2
    }

    /// Quintic ease out: the rings, and the changes of the screens.
    static func easeOut(_ p: Double) -> Double {
        1 - pow(1 - p, 5)
    }

    /// How far a change that started at `at` and takes `dur` has gone at
    /// `t`, 0 to 1; one that takes no time is done at once.
    private static func gone(_ t: Double, _ at: Double, _ dur: Double) -> Double {
        dur > 0 ? min(1, (t - at) / dur) : 1
    }

    /// The picture of hanging the link, `seconds` after it starts, for the
    /// platform `variant` ("ios" or "android"). Before the start is the
    /// start; after the end is the end.
    static func hangState(_ timeline: HangTimeline, variant: String, at seconds: Double) throws -> HangState {
        guard timeline.variants[variant] != nil else { throw NoVariant() }
        let t = seconds > 0 ? min(seconds, timeline.duration) : 0
        let tap = timeline.tap
        var state = HangState(camera: HangState.Camera(from: timeline.start, to: timeline.start, progress: 1))
        for name in timeline.states.keys { state.states[name] = 0 }

        for event in timeline.events {
            if event.at > t { break }
            let dt = t - event.at
            switch event.do {
            case "camera":
                guard let frame = event.frame else { continue }
                state.camera = HangState.Camera(from: state.camera.to, to: timeline.own(frame, for: variant), progress: easeInOut(gone(t, event.at, event.dur ?? 0)))
            case "mark":
                guard let target = event.target else { continue }
                state.marks[timeline.own(target, for: variant)] = gone(t, event.at, timeline.mark.fade)
            case "unmark":
                guard let target = event.target else { continue }
                state.marks[timeline.own(target, for: variant)] = 1 - gone(t, event.at, timeline.mark.fade)
            case "state":
                guard let name = event.state else { continue }
                state.states[name] = easeOut(gone(t, event.at, timeline.states[name] ?? 0))
            case "step":
                state.step = event.step ?? state.step
            case "tap":
                guard let target = event.target else { continue }
                let hold = event.hold ?? 0
                // The ring of a tap goes out at once; the ring of a long press grows, waits for the finger, then goes out.
                let over = hold + max(hold > 0 ? tap.holdOut : tap.ring, tap.pressHold + tap.pressOut)
                if dt >= over {
                    state.tap = nil
                    continue
                }
                let pressed = dt < tap.pressIn ? dt / tap.pressIn : dt < tap.pressHold + hold ? 1 : max(0, 1 - (dt - tap.pressHold - hold) / tap.pressOut)
                let ring: HangState.Ring
                if hold > 0, dt < hold {
                    let p = easeOut(gone(dt, 0, tap.holdIn))
                    ring = HangState.Ring(scale: tap.from + (tap.holdAt - tap.from) * p, opacity: p)
                } else {
                    let p = hold > 0 ? easeOut(gone(dt, hold, tap.holdOut)) : easeOut(gone(dt, 0, tap.ring))
                    let from = hold > 0 ? tap.holdAt : tap.from
                    ring = HangState.Ring(scale: from + (tap.to - from) * p, opacity: 1 - p)
                }
                state.tap = HangState.Tap(target: timeline.own(target, for: variant), pressed: pressed, ring: ring)
            default:
                continue
            }
        }
        state.marks = state.marks.filter { $0.value > 0 }
        return state
    }
}
