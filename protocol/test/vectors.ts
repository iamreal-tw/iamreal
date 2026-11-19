// Reads the specification's test vectors (spec/vectors/) and other files of
// the repository. Tests never copy them.
import { readFileSync } from "node:fs";

export const repoFile = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../${path}`, import.meta.url)));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const vectors = (name: string): any => JSON.parse(readFileSync(new URL(`../../spec/vectors/${name}`, import.meta.url), "utf8"));
