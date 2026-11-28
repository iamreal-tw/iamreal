import Foundation

/// What one screen of the card proof shows, top to bottom: every word on
/// it and every button. CardProofModel makes it; CardProofView draws it
/// and nothing else, so what a test reads here is what the screen says.
struct Screen: Equatable {
    /// 1 to 8: which of the app's eight steps (design/copy/card-proof.md);
    /// 0 for a screen in the place of step 1 that is none of them: this
    /// version can no longer do a card proof, this phone cannot read a card.
    var step: Int
    /// Says which of the eight steps it is, above it; not the whole of
    /// step 6 shown from step 4 on a day with 3 records, which is none of them.
    var inSteps = true
    var blocks: [Block]
    /// The buttons under the blocks, in their order; the last is the way
    /// on (on step 8, sharing), and the main button of the screen unless
    /// `mainButton` is false.
    /// Two side by side, the way on on the right; one under the other where
    /// either's words do not fit on one line in half the width, or where
    /// there are more than two, the way on on top (design/DESIGN.md, the
    /// components: buttons).
    var buttons: [Button] = []
    /// The screen's main button alone above `buttons`, as wide as the
    /// screen: step 8's sharing, with 上一步 and 完成 side by side under
    /// it (design/DESIGN.md, the components: buttons).
    var top: Button?
    /// Beside `top`, a small square button drawn as the system's share
    /// symbol; its label is only spoken (step 8's share sheet).
    var beside: Button?
    /// Under the buttons: what is not to read before the way on (step 2's
    /// list, all still to do, before the card is read).
    var under: [Block] = []
    /// The last of `buttons` is the screen's main button (design/DESIGN.md,
    /// the components: one main button on a screen).
    var mainButton = true
    /// Under the buttons, as links, in their order: what else can be done
    /// on step 7.
    var links: [Button] = []
    /// The way out at the very bottom: drops the PIN and goes back to step 1.
    var cancel: Button?
    /// Above everything, in their order: that this version stops being
    /// able to do a card proof on a day, that the card proof went back to
    /// its start after five minutes.
    var warnings: [Notice] = []
    /// Above the step, under the warnings: the note of a reminder the app was opened from.
    var notice: Notice?
    /// On the right of the header: the settings (steps 1 and 8).
    var settings: Button?

    /// Which of a step's pages under the same title it is: step 4's
    /// changing an account and changing the list; empty for the others.
    var part = ""

    /// Which page it is: the step, its title and `part`. Another page is
    /// drawn anew, from its top (ScreenView), as the Android app keys each
    /// step; a change on the same page (typing, the progress, 已複製, the
    /// reminder set from step 7) is not.
    var page: String {
        var title = ""
        for case .title(let text) in blocks { title = text; break }
        return "\(step) \(inSteps) \(part) \(title)"
    }

    /// Every sentence on the screen, in its order: for tests. The
    /// header's are not among them: they are not card-proof.md's.
    var texts: [String] {
        warnings.flatMap(\.texts) + (notice?.texts ?? []) + blocks.flatMap(\.texts) + (top.map { [$0.label] } ?? []) + (beside.map { [$0.label] } ?? []) + buttons.map(\.label) + under.flatMap(\.texts) + links.map(\.label) + (cancel.map { [$0.label] } ?? [])
    }
}

/// A box above the step: a sentence and a button under it, or the sentence alone.
struct Notice: Equatable {
    var text: String
    var button: Button?

    var texts: [String] { [text] + (button.map { [$0.label] } ?? []) }
}

enum Block: Equatable {
    case title(String)
    case heading(String)
    /// A heading of one item among others, smaller than `heading`.
    case subheading(String)
    case text(String)
    /// Sentences written one after another as one paragraph.
    case sentences([String])
    /// The account the card declares now, on its own line (step 4).
    case declared(String)
    /// A paragraph as conspicuous as the title's lead: what may change
    /// whether to go on.
    case strong(String)
    /// An emphasised sentence in the headings' typeface.
    case lead(String)
    /// A note in small words.
    case small(String)
    /// The words above a part of the screen that is not needed.
    case kicker(String)
    /// The small card of the last step: the accounts the card declares now.
    case proofCard(ProofCard)
    /// Steps to follow, numbered from 1.
    case steps([String])
    /// A sentence with a link in it: the words before, the link, the words after.
    case linked(String, Button, String)
    /// Points, each with a dot before it; `bold`: the words among them
    /// written in ink and bold.
    case points([String], bold: String? = nil)
    /// A question that opens to its answer.
    case question(String, [Block])
    /// One of the two progress lists.
    case items([Item])
    /// The name read from the card, with its label and the note under it.
    case cardName(label: String, name: String, note: String)
    /// The field the PIN is typed in.
    case pinField(label: String)
    /// Why a step stopped, or what is wrong with what was typed.
    case message(String)
    /// A row of the card's list the cardholder can change.
    case account(AccountRow)
    /// A row that is only shown: a platform, an account, what happens to it.
    case row(name: String, account: String, lines: [String])
    /// A label and its value.
    case pair(String, String)
    /// The address of the card's page, as the screen writes it.
    case link(String)
    /// A button among the text; `main`: the screen's main button.
    case button(Button, main: Bool)
    /// Buttons side by side, the first the screen's main button; one
    /// under the other where they do not fit side by side.
    case sideBySide([Button])
    /// The demonstration of hanging the link (step 6), and its one button.
    case demo(HangDemo)
    /// A button that looks like a link, on its own line.
    case action(Button)
    /// What the app is doing, beside a spinner.
    case busy(String)
    /// The demonstration of where the card goes on the phone (step 2), and its one button.
    case senseDemo(SenseDemo)

    var texts: [String] {
        switch self {
        case .title(let text), .heading(let text), .subheading(let text), .text(let text), .strong(let text),
             .lead(let text), .small(let text), .kicker(let text), .message(let text), .link(let text), .busy(let text), .declared(let text):
            return [text]
        case .proofCard(let card): return card.texts
        case .steps(let lines), .sentences(let lines): return lines
        case .linked(let before, let link, let after): return [before + link.label + after]
        case .points(let points, _): return points
        case .question(let question, let answer): return [question] + answer.flatMap(\.texts)
        case .items(let items): return items.flatMap { [$0.label] + ($0.status.isEmpty ? [] : [$0.status]) + $0.why }
        case .cardName(let label, let name, let note): return [label, name, note]
        case .pinField(let label): return [label]
        case .account(let row): return [row.name] + (row.preview.map { [$0.label] } ?? []) + row.lines + (row.error.map { [$0] } ?? [])
        case .row(let name, let account, let lines): return [name, account] + lines
        case .pair(let label, let value): return [label, value]
        case .button(let button, _), .action(let button): return [button.label]
        case .sideBySide(let buttons): return buttons.map(\.label)
        case .demo(let demo): return [demo.description, demo.control.label]
        case .senseDemo(let demo): return [demo.description, demo.control.label]
        }
    }
}

/// The demonstration of step 2 (design/copy/card-proof.md, the section on
/// the demonstrations; design/motion/README.md): the phone, which does not
/// move, and the card that goes behind the top of it. What moves and when
/// is the timeline's (TeachingAnimation).
struct SenseDemo: Equatable {
    /// What VoiceOver reads in the place of the whole picture.
    var description: String
    /// The one button beside it: it stops while the demonstration plays, and plays it again otherwise.
    var control: Button
    var playing: Bool
    /// It has played, or is playing, since step 2 came up: not playing, it
    /// is then at rest with the card in place; before, the phone alone.
    var played: Bool
}

/// The small card of the last step (design/DESIGN.md, the components:
/// the proof card): the service's name, the card's accounts, its short ID.
struct ProofCard: Equatable {
    struct Row: Equatable {
        /// The platform's name; none when the screens speak of one platform.
        var name: String?
        var account: String
    }

    var label: String
    var rows: [Row]
    /// The short ID, as the card writes it.
    var shortID: String

    var texts: [String] {
        [label] + rows.flatMap { ($0.name.map { [$0] } ?? []) + [$0.account] } + [shortID]
    }
}

/// The demonstration of step 6 (design/copy/card-proof.md, the section on
/// the demonstrations; design/motion/README.md): five screens side by side,
/// the app's own and four sketches of Threads, and a camera that goes from
/// copying the link to the line on the profile. What moves and when is the
/// timeline's (TeachingAnimation); here is what the picture says.
struct HangDemo: Equatable {
    /// The words on the five screens, each from the copy.
    struct Words: Equatable {
        /// The app's own screen: its title, and the two buttons.
        var title: String
        var copy: String
        var copied: String
        var open: String
        /// The profile on Threads.
        var edit: String
        var found: String
        /// Editing the profile: the rows before the links, the links, the row after.
        var rows: [String]
        var links: String
        var featured: String
        /// The links.
        var add: String
        /// Adding a link.
        var done: String
        var url: String
        var paste: String
        var linkTitle: String

        /// Every one of them, for tests.
        var all: [String] {
            [title, copy, copied, open, edit, found] + rows + [links, featured, add, done, url, paste, linkTitle]
        }
    }

    /// What VoiceOver reads in the place of the whole picture.
    var description: String
    /// The one button beside it: it stops while the demonstration plays, and plays it again otherwise.
    var control: Button
    var playing: Bool
    /// It has played, or is playing, in this card proof: not playing, it
    /// is then at its last frame; before, at its first.
    var played: Bool
    /// The card's account on Threads, as the screens write it, and its
    /// page's address: as the link is shown, and whole as it is pasted.
    var account: String
    var link: String
    var address: String
    var words: Words
}

/// One item of a progress list.
struct Item: Equatable {
    enum State: Equatable { case pending, working, done, halted }
    var label: String
    var state: State
    /// The words after it: in progress, done, stopped here; none before its turn.
    var status: String
    /// Under a halted item: why, and the request ID to report.
    var why: [String] = []
}

struct AccountRow: Equatable {
    var platform: String
    var name: String
    /// What stands before the field: `@`.
    var prefix: String
    /// What the field holds.
    var text: String
    var preview: Button?
    /// The lines under the row: its counts, and whether it can be changed.
    var lines: [String]
    /// What is wrong with what was typed.
    var error: String?
}

struct Button: Equatable {
    var label: String
    var action: Action
    var enabled = true
    /// What VoiceOver reads in the place of the label, where the label is
    /// a short form of it.
    var spoken: String?
}

/// What a button does. CardProofModel.perform does it.
enum Action: Equatable {
    /// From step 1 to step 2.
    case start
    /// Back one screen.
    case back
    /// Tap 1.
    case readCard
    /// From step 2 to step 3.
    case toPIN
    /// Tap 2.
    case confirmCard
    /// The card's state asked again, after the server turned it away as too many: nothing signed again.
    case retryCardState
    /// From step 4 to step 5: what the list typed would do.
    case toConfirm
    /// "更新島民證明" of step 4: the card's list as it is, to step 5.
    case refresh
    /// "收回對 @alice 的宣告" of step 4: the list without its accounts, to step 5.
    case withdraw
    /// "改成別的帳號" of step 4: a field for another account.
    case toSwitch
    /// "修改帳號清單" of step 4: a row for each platform.
    case editList
    /// 上一步 of the screens opened from step 4: back to what the card declares.
    case backToDeclared
    /// The app's page in the store, to update it.
    case openStore
    /// The phone's map, searching for household registration offices (step 1).
    case findOffice
    /// MOICA's page on applying, in the browser (step 1).
    case howToApply
    /// Tap 3, the proof and the submission.
    case declare
    /// Tap 3 again, with the PIN in memory.
    case signAgain
    /// The same record to the server again.
    case submitAgain
    /// Drops everything: back to step 1.
    case restart
    /// Drops everything: back to step 2, to read the card again.
    case readAgain
    case copyLink
    /// The card's page, in the browser.
    case openProof
    /// The site of this build, in the browser: a phone that cannot read a card.
    case openSite
    /// The platform's app or the browser, at the account the card declares there.
    case openProfile(String)
    /// The platform's composer, the sentence and the card's page filled in.
    case shareOn(String)
    /// The system's share sheet, with the sentence and the card's page.
    case share
    /// The page of the account typed on a platform.
    case preview(String)
    case openSettings
    /// "重新掛上連結": the whole of step 6 in the place of the short one.
    case rehang
    /// "重新掛上連結" of step 4 on a day with 3 records: the whole of step 6
    /// for the accounts the card declares now.
    case hangFromLimit
    /// From step 6 to step 7.
    case toRemind
    /// From step 7 to step 8.
    case toFinish
    /// The picture of step 6's demonstration has come onto the screen: it
    /// plays, the first time in a card proof.
    case showDemo
    /// The demonstration of the step (2 or 6) from its start: its button.
    case playDemo
    /// The demonstration at its last frame: its button, or its end.
    case stopDemo
    /// The screen to choose the reminder's interval and time.
    case adjustReminder
    /// "一週後再提醒我", on step 1 opened from the notification.
    case snoozeReminder
}
