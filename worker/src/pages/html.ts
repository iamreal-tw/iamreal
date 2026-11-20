// HTML made of pieces: `html` is a template tag that escapes every value
// put into it, so that nothing a visitor typed and nothing the roster holds
// is ever read as markup. The only way around the escaping is a piece that
// is already `Html`, which only this tag makes.

/** A piece of HTML: text that is already escaped where it has to be. */
export class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return this.text;
  }
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };

/** `text` with the five characters that mean something in HTML, in text and in a quoted attribute, written as entities. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

type Value = Html | string | number | readonly Html[];

/**
 * The template with its values: a string or a number is escaped, a piece of
 * `Html` is put in as it is, a list of pieces one after the other. The
 * template's own text is the author's and is not escaped.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0]!;
  for (const [i, v] of values.entries()) {
    out += v instanceof Html ? v.text : typeof v === "string" ? escapeHtml(v) : typeof v === "number" ? String(v) : v.map((piece) => piece.text).join("\n");
    out += strings[i + 1]!;
  }
  return new Html(out);
}

/** A whole number with a comma between groups of three digits. */
export function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
