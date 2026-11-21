import Foundation

/// What one screen of the card proof shows, top to bottom: every word on
/// it and every button. CardProofModel makes it; CardProofView draws it
/// and nothing else, so what a test reads here is what the screen says.
struct Screen: Equatable {
    /// 1 to 6: which of the six steps (design/copy/card-proof.md).
    var step: Int
    var blocks: [Block]
    /// The buttons at the bottom, in their order; the last is the way on.
    var buttons: [Button] = []
    /// The way out under the buttons: drops the PIN and goes back to step 1.
    var cancel: Button?

    /// Every sentence on the screen, in its order: for tests.
    var texts: [String] {
        blocks.flatMap(\.texts) + buttons.map(\.label) + (cancel.map { [$0.label] } ?? [])
    }
}

enum Block: Equatable {
    case title(String)
    case heading(String)
    case text(String)
    /// A paragraph as conspicuous as the title's lead: what may change
    /// whether to go on.
    case strong(String)
    /// A sentence written by hand on the proof.
    case hand(String)
    /// Points, each with a dot before it.
    case points([String])
    /// A question that opens to its answer.
    case question(String, [String])
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
    /// A button among the text.
    case button(Button)
    /// What the app is doing, beside a spinner.
    case busy(String)

    var texts: [String] {
        switch self {
        case .title(let text), .heading(let text), .text(let text), .strong(let text),
             .hand(let text), .message(let text), .link(let text), .busy(let text):
            return [text]
        case .points(let points): return points
        case .question(let question, let answer): return [question] + answer
        case .items(let items): return items.flatMap { [$0.label] + ($0.status.isEmpty ? [] : [$0.status]) + $0.why }
        case .cardName(let label, let name, let note): return [label, name, note]
        case .pinField(let label): return [label]
        case .account(let row): return [row.name] + (row.preview.map { [$0.label] } ?? []) + row.lines + (row.error.map { [$0] } ?? [])
        case .row(let name, let account, let lines): return [name, account] + lines
        case .pair(let label, let value): return [label, value]
        case .button(let button): return [button.label]
        }
    }
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
    /// From step 4 to step 5: what the list would do.
    case toConfirm
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
    /// The platform's app or the browser, at the account declared.
    case openPlatform
    /// The page of the account typed on a platform.
    case preview(String)
    /// A help page of the site, in the browser.
    case help(String)
}
