import XCTest
@testable import IamrealApp

/// The two demonstrations at given moments (App/TeachingAnimation.swift),
/// against the answers of spec/vectors/teaching-animation.json, which the
/// site's and the Android app's implementations are tested against too:
/// with the timelines of design/motion/, the state at each case's seconds
/// is the case's, numbers within the file's tolerance and everything else
/// the same.
final class TeachingAnimationTests: XCTestCase {
    private func timeline() throws -> HangTimeline {
        try JSONDecoder().decode(HangTimeline.self, from: Repository.data("design/motion/hang.json"))
    }

    func testTheStateAtEveryMomentOfTheVectorsIsTheirs() throws {
        let vectors = try Repository.vectors("teaching-animation.json")
        XCTAssertEqual((vectors["timelines"] as? [String: String])?["hang"], "design/motion/hang.json")
        let tolerance = try XCTUnwrap(vectors["tolerance"] as? Double)
        let cases = try XCTUnwrap(vectors["hang"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 26)
        let timeline = try timeline()
        var variants: Set<String> = []
        for item in cases {
            let name = try XCTUnwrap(item["name"] as? String)
            let variant = try XCTUnwrap(item["variant"] as? String)
            let seconds = try XCTUnwrap(item["seconds"] as? Double)
            let expected = try XCTUnwrap(item["state"] as? [String: Any])
            variants.insert(variant)
            let state = try TeachingAnimation.hangState(timeline, variant: variant, at: seconds)

            let camera = try XCTUnwrap(expected["camera"] as? [String: Any])
            XCTAssertEqual(state.camera.from, camera["from"] as? String, name)
            XCTAssertEqual(state.camera.to, camera["to"] as? String, name)
            XCTAssertEqual(state.camera.progress, try XCTUnwrap(camera["progress"] as? Double), accuracy: tolerance, name)

            // The same boxes marked, each as much.
            let marks = try XCTUnwrap(expected["marks"] as? [String: Double])
            XCTAssertEqual(Set(state.marks.keys), Set(marks.keys), name)
            for (box, shows) in marks { XCTAssertEqual(state.marks[box] ?? -1, shows, accuracy: tolerance, "\(name): \(box)") }

            if let tap = expected["tap"] as? [String: Any] {
                let pressed = try XCTUnwrap(state.tap, name)
                let ring = try XCTUnwrap(tap["ring"] as? [String: Double])
                XCTAssertEqual(pressed.target, tap["target"] as? String, name)
                XCTAssertEqual(pressed.pressed, try XCTUnwrap(tap["pressed"] as? Double), accuracy: tolerance, name)
                XCTAssertEqual(pressed.ring.scale, try XCTUnwrap(ring["scale"]), accuracy: tolerance, name)
                XCTAssertEqual(pressed.ring.opacity, try XCTUnwrap(ring["opacity"]), accuracy: tolerance, name)
            } else {
                XCTAssertTrue(expected["tap"] is NSNull, name)
                XCTAssertNil(state.tap, name)
            }

            let states = try XCTUnwrap(expected["states"] as? [String: Double])
            XCTAssertEqual(Set(state.states.keys), Set(states.keys), name)
            for (change, gone) in states { XCTAssertEqual(state.states[change] ?? -1, gone, accuracy: tolerance, "\(name): \(change)") }
            XCTAssertEqual(state.step, expected["step"] as? Int, name)
        }
        XCTAssertEqual(variants, ["ios", "android"], "the cases cover both platforms")
    }

    /// Every box the timeline presses, frames or aims at on an iPhone is one the picture draws
    /// (HangDemoView.Name), and the picture draws no box the timeline does not use: a name that
    /// changed in one and not the other would leave the camera with nowhere to aim.
    func testThePictureDrawsEveryBoxTheTimelineUsesOnAnIPhone() throws {
        let timeline = try timeline()
        let variant = HangDemoView.variant
        var used: Set<String> = []
        var framings: Set<String> = [timeline.start]
        for event in timeline.events {
            if let target = event.target { used.insert(timeline.own(target, for: variant)) }
            if let frame = event.frame { framings.insert(timeline.own(frame, for: variant)) }
        }
        for name in framings {
            let frame = try XCTUnwrap(timeline.frames[name], "no framing \(name)")
            used.formUnion([frame.x.t, frame.y.t])
        }
        let drawn = Set(HangDemoView.Name.allCases.map(\.rawValue))
        XCTAssertEqual(used.subtracting(drawn), [], "the timeline uses boxes the picture does not draw")
        // The five screens are drawn whether or not a framing names them.
        XCTAssertEqual(drawn.subtracting(used).subtracting(["s0", "s1", "s2", "s3", "s4"]), [], "the picture draws boxes the timeline does not use")
    }

    // Where the card goes ----------------------------------------------------------------------

    private func senseTimeline() throws -> SenseTimeline {
        try JSONDecoder().decode(SenseTimeline.self, from: Repository.data("design/motion/sense.json"))
    }

    /// The picture of where the card goes at every moment of the vectors:
    /// the round, whether it rests, the card's place and how much of it
    /// shows, the ring; for an iPhone and for an Android.
    func testTheCardsPlaceAtEveryMomentOfTheVectorsIsTheirs() throws {
        let vectors = try Repository.vectors("teaching-animation.json")
        XCTAssertEqual((vectors["timelines"] as? [String: String])?["sense"], "design/motion/sense.json")
        let tolerance = try XCTUnwrap(vectors["tolerance"] as? Double)
        let cases = try XCTUnwrap(vectors["sense"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 24)
        let timeline = try senseTimeline()
        var variants: Set<String> = []
        for item in cases {
            let name = try XCTUnwrap(item["name"] as? String)
            let variant = try XCTUnwrap(item["variant"] as? String)
            let seconds = try XCTUnwrap(item["seconds"] as? Double)
            let expected = try XCTUnwrap(item["state"] as? [String: Any])
            variants.insert(variant)
            let state = try TeachingAnimation.senseState(timeline, variant: variant, at: seconds)
            XCTAssertEqual(state.round, expected["round"] as? Int, name)
            XCTAssertEqual(state.stopped, expected["stopped"] as? Bool, name)
            let card = try XCTUnwrap(expected["card"] as? [String: Double])
            XCTAssertEqual(state.card.y, try XCTUnwrap(card["y"]), accuracy: tolerance, name)
            XCTAssertEqual(state.card.x, try XCTUnwrap(card["x"]), accuracy: tolerance, name)
            XCTAssertEqual(state.card.opacity, try XCTUnwrap(card["opacity"]), accuracy: tolerance, name)
            if let ring = expected["ring"] as? [String: Double] {
                let shown = try XCTUnwrap(state.ring, name)
                XCTAssertEqual(shown.scale, try XCTUnwrap(ring["scale"]), accuracy: tolerance, name)
                XCTAssertEqual(shown.opacity, try XCTUnwrap(ring["opacity"]), accuracy: tolerance, name)
            } else {
                XCTAssertTrue(expected["ring"] is NSNull, name)
                XCTAssertNil(state.ring, name)
            }
        }
        XCTAssertEqual(variants, ["ios", "android"], "the cases cover both platforms")
    }

    /// An iPhone's plays three rounds and rests with the card where the phone reads it: at the top of its back.
    func testAnIPhonesRestsAfterThreeRoundsWithTheCardInPlace() throws {
        let timeline = try senseTimeline()
        XCTAssertEqual(timeline.rounds, 3)
        // The one way of resting the algorithm is written for.
        XCTAssertEqual(timeline.rest, SenseTimeline.Rest(card: "stays", ring: false))
        let length = try TeachingAnimation.senseLength(timeline, variant: "ios")
        XCTAssertEqual(length, 10.55, accuracy: 0.000001)
        let rest = try TeachingAnimation.senseState(timeline, variant: "ios", at: length)
        XCTAssertEqual(rest, SenseState(round: 3, stopped: true, card: SenseState.Card(y: 0.213, x: 0, opacity: 1), ring: nil))
        XCTAssertEqual(try TeachingAnimation.senseState(timeline, variant: "ios", at: 600), rest)
        XCTAssertFalse(try TeachingAnimation.senseState(timeline, variant: "ios", at: length - 0.01).stopped)
        XCTAssertThrowsError(try TeachingAnimation.senseState(timeline, variant: "desktop", at: 1))
    }

    func testAPlatformTheTimelineDoesNotHaveIsRefused() throws {
        XCTAssertThrowsError(try TeachingAnimation.hangState(try timeline(), variant: "desktop", at: 1))
    }

    /// Any moment in any order: asking for one does not change another.
    func testAMomentDoesNotDependOnTheOneAskedBefore() throws {
        let timeline = try timeline()
        let late = try TeachingAnimation.hangState(timeline, variant: "ios", at: 19)
        let early = try TeachingAnimation.hangState(timeline, variant: "ios", at: 1.7)
        XCTAssertEqual(try TeachingAnimation.hangState(timeline, variant: "ios", at: 19), late)
        XCTAssertEqual(try TeachingAnimation.hangState(timeline, variant: "ios", at: 1.7), early)
        // After the end is the end: the line on the profile, and its label.
        let end = try TeachingAnimation.hangState(timeline, variant: "ios", at: timeline.duration)
        XCTAssertEqual(try TeachingAnimation.hangState(timeline, variant: "ios", at: 99), end)
        XCTAssertEqual(end.states["linkOnProfile"], 1)
        XCTAssertEqual(end.states["resultLabel"], 1)
        XCTAssertEqual(end.step, 5)
    }
}
