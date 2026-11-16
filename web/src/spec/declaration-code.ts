// The declaration code (spec/declaration-code.md): the 31 bytes the card
// signs the second time.
import { asciiBytes, sha256 } from "../bytes.ts";
import { encodeBase32 } from "./base32.ts";

export type Action = "declare" | "withdraw";

export function declarationPreimage(action: Action, scopeString: string, username: string, challenge: string): Uint8Array {
  for (const part of [scopeString, username, challenge]) {
    if (part.includes("\n")) throw new Error("a line of the preimage contains LF");
  }
  const text = ["iamreal-declaration-v1", action, scopeString, username, challenge].join("\n");
  return new TextEncoder().encode(text);
}

/** "D" followed by the first 30 base32 characters of SHA-256(preimage): 31 ASCII bytes. */
export async function declarationCode(action: Action, scopeString: string, username: string, challenge: string): Promise<Uint8Array> {
  const digest = await sha256(declarationPreimage(action, scopeString, username, challenge));
  return asciiBytes("D" + encodeBase32(digest).slice(0, 30));
}
