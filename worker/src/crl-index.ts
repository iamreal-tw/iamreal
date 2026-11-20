// The index of the CRL archive (spec/revocation-tree.md, "Archive index"):
// one line per file, in one spelling and one order, and what the roster's
// object is told of it. The Go crl/ (index.go) writes the same bytes from
// the same files.
import type { IssuerName } from "./issuers.ts";

/** One line of the index. Every field is the text of the line; `-` stands for a missing value. */
export interface IndexLine {
  readonly issuer: IssuerName | "-";
  readonly crlNumber: string;
  readonly thisUpdate: string;
  readonly nextUpdate: string;
  readonly crlDate: string;
  readonly sha256: string;
  /** The root, 64 hex digits; for a file that is not usable, `-` and the reason code. */
  readonly root: string;
}

/** Whether the line is of a usable CRL: its root is a root. */
export const usable = (line: IndexLine): boolean => !line.root.startsWith("-");

function formatLine(l: IndexLine): string {
  return `{"issuer":"${l.issuer}","crl_number":"${l.crlNumber}","this_update":"${l.thisUpdate}","next_update":"${l.nextUpdate}","crl_date":"${l.crlDate}","sha256":"${l.sha256}","root":"${l.root}"}\n`;
}

/** Compares decimal numbers without leading zeros, `-` before every number. */
function compareNumbers(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "-") return -1;
  if (b === "-") return 1;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : 1;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lines as an index file: sorted by issuer, then CRL number as a number, then SHA-256. */
export function formatIndex(lines: readonly IndexLine[]): string {
  return [...lines]
    .sort((a, b) => compareText(a.issuer, b.issuer) || compareNumbers(a.crlNumber, b.crlNumber) || compareText(a.sha256, b.sha256))
    .map(formatLine)
    .join("");
}

const TIME = String.raw`-|-?\d{4,}-\d\d-\d\dT\d\d:\d\d:\d\dZ`;
const LINE = new RegExp(
  String.raw`^\{"issuer":"(G2|G3|-)","crl_number":"(-|0|[1-9]\d*)","this_update":"(${TIME})","next_update":"(${TIME})","crl_date":"(-|-?\d{4,}-\d\d-\d\d)","sha256":"([0-9a-f]{64})","root":"([0-9a-f]{64}|-[a-z0-9_]+)"\}$`,
);

/**
 * The lines of an index file that are written as the spec writes them, one
 * per SHA-256. A line that is not, a second line of the same file, and
 * anything after the last LF are left out: the mirror reads the file again
 * and writes its line anew.
 */
export function readIndex(text: string): IndexLine[] {
  const lines = new Map<string, IndexLine>();
  for (const raw of text.split("\n").slice(0, -1)) {
    const m = LINE.exec(raw);
    if (m === null || lines.has(m[6]!)) continue;
    const line: IndexLine = { issuer: m[1] as IndexLine["issuer"], crlNumber: m[2]!, thisUpdate: m[3]!, nextUpdate: m[4]!, crlDate: m[5]!, sha256: m[6]!, root: m[7]! };
    // A root comes with the key that signed it and the CRL's number and date.
    if (usable(line) && (line.issuer === "-" || line.crlNumber === "-" || line.crlDate === "-")) continue;
    lines.set(line.sha256, line);
  }
  return [...lines.values()];
}

/** A usable CRL as the roster's object keeps it. */
export interface KnownCrl {
  /** The root of its tree: 64 lowercase hex digits, as a record's `smt_root`. */
  readonly root: string;
  /** `cRLNumber`, in decimal. */
  readonly crlNumber: string;
  /** The CRL date: `thisUpdate` as a date in Taiwan, `YYYY-MM-DD`. */
  readonly crlDate: string;
}

/**
 * For each issuer key, its newest usable CRLs in the archive: at most two,
 * the newest first. "Newest" is by CRL number, as devices choose their CRL
 * (spec/revocation-tree.md, "Who checks what"); of two files with the same
 * number, the one later in the index is the newer.
 */
export type NewestCrls = Readonly<Record<IssuerName, readonly KnownCrl[]>>;

/** The newest two usable CRLs of each issuer key among the lines. */
export function newestCrls(lines: readonly IndexLine[]): NewestCrls {
  const of = (issuer: IssuerName): KnownCrl[] =>
    lines
      .filter((l) => l.issuer === issuer && usable(l))
      .sort((a, b) => compareNumbers(b.crlNumber, a.crlNumber) || compareText(b.sha256, a.sha256))
      .slice(0, 2)
      .map((l) => ({ root: l.root, crlNumber: l.crlNumber, crlDate: l.crlDate }));
  return { G2: of("G2"), G3: of("G3") };
}
