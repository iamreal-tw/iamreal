// Reading a request's JSON (docs/api/card-proof.md, "Reading the request").
// `JSON.parse` alone is not strict enough: of two members with the same key
// it keeps the last and says nothing, so a request could carry a value the
// back end never looks at (ADR-0014). This reader refuses a key that appears
// twice, in any object of the text, and otherwise reads what RFC 8259 allows:
// each string and number is handed to `JSON.parse`, so their spelling is
// judged by it.

/** A JSON value as this reader gives it: an object is a Map, in the order of its members. */
export type Json = null | boolean | number | string | Json[] | Map<string, Json>;

/** Thrown inside the reader; never leaves parseJson. */
class NotJson extends Error {}

/**
 * How deep arrays and objects may nest. A request of this API nests 3 deep
 * (an account in the list in the body); the bound keeps a body of nothing but
 * `[` from using the stack up.
 */
const MAX_DEPTH = 16;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * The value `text` is, or undefined if `text` is not one JSON value with
 * nothing but whitespace around it, or an object in it has a key twice, or
 * it nests deeper than MAX_DEPTH. (`undefined`, because `null` is a value.)
 */
export function parseJson(text: string): Json | undefined {
  let at = 0;
  const skip = (): void => {
    while (at < text.length && WHITESPACE.has(text[at]!)) at++;
  };
  const string = (): string => {
    const start = at;
    at++; // the opening quote
    for (;;) {
      if (at >= text.length) throw new NotJson();
      const c = text[at]!;
      if (c === "\\") at += 2;
      else if (c === '"') break;
      else at++;
    }
    at++;
    try {
      const value: unknown = JSON.parse(text.slice(start, at));
      if (typeof value === "string") return value;
    } catch {
      // not a string in JSON's spelling
    }
    throw new NotJson();
  };
  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) throw new NotJson();
    skip();
    const c = text[at];
    if (c === '"') return string();
    if (c === "{") {
      at++;
      const members = new Map<string, Json>();
      skip();
      if (text[at] === "}") {
        at++;
        return members;
      }
      for (;;) {
        skip();
        if (text[at] !== '"') throw new NotJson();
        const key = string();
        if (members.has(key)) throw new NotJson();
        skip();
        if (text[at] !== ":") throw new NotJson();
        at++;
        members.set(key, value(depth + 1));
        skip();
        if (text[at] === ",") at++;
        else if (text[at] === "}") break;
        else throw new NotJson();
      }
      at++;
      return members;
    }
    if (c === "[") {
      at++;
      const elements: Json[] = [];
      skip();
      if (text[at] === "]") {
        at++;
        return elements;
      }
      for (;;) {
        elements.push(value(depth + 1));
        skip();
        if (text[at] === ",") at++;
        else if (text[at] === "]") break;
        else throw new NotJson();
      }
      at++;
      return elements;
    }
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = at;
    const m = NUMBER.exec(text);
    if (m === null) throw new NotJson();
    at += m[0].length;
    return Number(m[0]);
  };
  try {
    const v = value(0);
    skip();
    return at === text.length ? v : undefined;
  } catch (e) {
    if (e instanceof NotJson) return undefined;
    throw e;
  }
}

/**
 * The members of `text` by key, if `text` is one JSON object whose members
 * are exactly `keys`, each once, spelled as given, each a string. Null for
 * anything else: not JSON, not an object, a key missing, another key, a key
 * twice, a key in another case, a value that is not a string, something
 * after the object.
 */
export function readStrings<K extends string>(text: string, keys: readonly K[]): Record<K, string> | null {
  const v = parseJson(text);
  if (!(v instanceof Map) || v.size !== keys.length) return null;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const member = v.get(key);
    if (typeof member !== "string") return null;
    out[key] = member;
  }
  return out;
}
