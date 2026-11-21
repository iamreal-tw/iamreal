// The declaration code as spec/declaration-code.md of the public repository
// defines it (draft, iamreal-declaration-v1). The tests use it to make the
// code of another challenge; the card proof circuit does not compute it.
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
