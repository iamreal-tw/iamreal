// The declaration code as an earlier draft of spec/declaration-code.md
// defined it, before the preimage took its current form; it is not the
// algorithm of spec/declaration-code.md now. The tests use it only to make
// the code of another challenge. The card proof circuit does not compute the
// declaration code: it checks the card's signature over the 31 bytes and
// their first byte, and the verifier recomputes the code from the challenge
// as spec/declaration-code.md says.
import { createHash } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/** The 31 bytes a card signs for this declaration (or withdrawal). */
export function declarationCode({ action, scopeString, username, challenge }) {
  const preimage = ["iamreal-declaration-v1", action, scopeString, username, challenge].join("\n");
  const digest = createHash("sha256").update(preimage, "utf8").digest();
  return Buffer.from("D" + base32(digest).slice(0, 30), "ascii");
}
