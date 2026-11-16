// Every sentence the screen shows comes from design/copy/card-proof.json,
// the form of design/copy/card-proof.md a program can read
// (test/copy.test.ts keeps the two the same). Nothing in src/ui/ writes a
// sentence of its own. Placeholders are written {name}.
import data from "../../../design/copy/card-proof.json" with { type: "json" };

export type Copy = typeof data;
export const COPY: Copy = data;

export type Values = Record<string, string | number>;

/** One piece of a sentence: fixed text, or the value of a placeholder. */
export interface Part {
  text: string;
  placeholder: string | null;
}

/** The sentence cut at its placeholders, each filled with its value. */
export function parts(template: string, values: Values = {}): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{([a-z_]+)\}/g)) {
    if (m.index > last) out.push({ text: template.slice(last, m.index), placeholder: null });
    const v = values[m[1]!];
    if (v === undefined) throw new Error(`no value for {${m[1]}}`);
    out.push({ text: String(v), placeholder: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last), placeholder: null });
  return out;
}

/** The sentence with its placeholders filled. */
export function fill(template: string, values: Values = {}): string {
  return parts(template, values)
    .map((p) => p.text)
    .join("");
}
