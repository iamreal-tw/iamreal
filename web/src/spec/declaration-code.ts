// The declaration code (spec/declaration-code.md): the 31 bytes the card
// signs the second time. It states the card's whole list of accounts, one
// account at most on each platform, in ascending order of the platform ID.
import { asciiBytes, sha256 } from "../bytes.ts";
import { encodeBase32 } from "./base32.ts";

/** One account of a record's list (spec/record.md, "The account list"). */
export interface Account {
  readonly platform: string;
  readonly username: string;
}

export function declarationPreimage(scopeString: string, accounts: readonly Account[], challenge: string): Uint8Array {
  for (const part of [scopeString, challenge, ...accounts.flatMap((a) => [a.platform, a.username])]) {
    if (part.includes("\n")) throw new Error("a line of the preimage contains LF");
  }
  for (const [i, a] of accounts.entries()) {
    if (a.platform.includes(":")) throw new Error("a platform ID contains ':'");
    if (i > 0 && !(accounts[i - 1]!.platform < a.platform)) throw new Error("the list is not in ascending order of platform");
  }
  const text = ["iamreal-declaration-v1", scopeString, ...accounts.map((a) => `${a.platform}:${a.username}`), challenge].join("\n");
  return new TextEncoder().encode(text);
}

/** "D" followed by the first 30 base32 characters of SHA-256(preimage): 31 ASCII bytes. */
export async function declarationCode(scopeString: string, accounts: readonly Account[], challenge: string): Promise<Uint8Array> {
  const digest = await sha256(declarationPreimage(scopeString, accounts, challenge));
  return asciiBytes("D" + encodeBase32(digest).slice(0, 30));
}
