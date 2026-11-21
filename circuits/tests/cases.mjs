// Every test case of the circom circuit (wallet-unit-poc/circom/tests/circuits
// of PSE zkID, https://github.com/iamreal-tw/zkID at the commit in
// circuits/zkid-commit; MIT License, Copyright (c) 2026 Ethereum Foundation),
// rebuilt on throwaway keys, plus the cases added here. Each case is one set
// of bytes fed to the circom circuit, to the Noir comparison circuit of the
// same shape, and to the card proof circuit.
//
// The upstream RS2048 / RS4096 / linking / audit tests read fixture files made
// from a real certificate. Here they run on synthetic certificates instead.
import {
  AUTHORITY_KEY_ID, buildTbs, cardHolderRank, CERT_POLICIES, keyUsage, KEY_USAGE_ENCRYPTION,
  KEY_USAGE_SIGNING, makeKey, name, opaqueExtension, SUBJECT_DIR_ATTRS, SUBJECT_KEY_ID,
  spkiOfModulus, subjectDirectoryAttributes, subjectOfLength, truncate,
} from "./lib/cert.mjs";
import { chainCase, sigCase } from "./lib/inputs.mjs";

// 2026-11-14 15:59:59 UTC as YYMMDDHHMMSS.
export const NOW = 261114155959n;
export const SCOPE = Buffer.from("iamreal-test:threads:0_________", "ascii");
// The code tests/lib/declaration-code.mjs (an earlier draft) gives for declare,
// @alice, challenge 1234567890.
export const CODE = Buffer.from("DX8FHVFCJDJXXEVP2Q0W9PJ1EBH5Z8Z", "ascii");

// The first byte of a signed message decides its kind (ADR-0007). `scope`:
// accepted as the scope string; `code`: accepted as the declaration code.
export const FIRST_BYTES = [
  ["a", "scope"], ["i", "scope"], ["z", "scope"], ["S", "scope"],
  ["A", "code"], ["D", "code"], ["R", "code"], ["T", "code"], ["Z", "code"],
  ["`", null], ["{", null], ["@", null], ["[", null], ["0", null], ["9", null], ["_", null],
  ["\x00", null], ["\xe1", null], // 0xe1 is `a` with the top bit set
];

const hex = (s) => Buffer.from(s, "hex");

export function buildCases() {
  const ca = makeKey(2048);
  const ca4096 = makeKey(4096);
  const user = makeKey(2048);
  const spki = user.spki;

  const cases = [];
  /**
   * kind: "chain2048" | "chain4096" (the certificate, under a 2048- or
   * 4096-bit issuer key) | "scope" (the signature over the scope string) |
   * "code" (the signature over the declaration code) | "link". expect: true =
   * accept. circomExpect: what the circom circuit does where it differs on
   * purpose (it has one signature circuit, with no check of the message kind).
   */
  const add = (source, title, kind, expect, body, extra = {}) =>
    cases.push({ source, title, kind, expect, ...extra, ...body });

  const chain = (opts = {}, currentTime = NOW) =>
    chainCase({ ca, tbs: buildTbs({ spki, ...opts }), currentTime });
  const cut = (marker, back) => {
    const full = buildTbs({ spki });
    return chainCase({ ca, tbs: truncate(full, full.indexOf(marker) + marker.length - back), currentTime: NOW });
  };

  // --- certChainValidity.test.ts
  let src = "certChainValidity";
  add(src, "a certificate inside its validity period", "chain2048", true, chain());
  add(src, "currentTime equal to notAfter", "chain2048", true, chain({ notAfter: "261114155959Z" }));
  add(src, "currentTime equal to notBefore", "chain2048", true, chain({ notBefore: "261114155959Z" }));
  add(src, "a 1-byte serial number", "chain2048", true, chain({ serial: Buffer.from([0x05]) }));
  add(src, "a 20-byte serial number", "chain2048", true, chain({ serial: Buffer.alloc(20, 0x11) }));
  add(src, "an issuer name of 127 content bytes", "chain2048", true, chain({ issuer: name("Test CA", [60, 14]) }));
  add(src, "a certificate that expired one second ago", "chain2048", false, chain({ notAfter: "261114155958Z" }));
  add(src, "a certificate that becomes valid one second from now", "chain2048", false, chain({ notBefore: "261114160000Z" }));
  add(src, "a GeneralizedTime notAfter (2050 or later)", "chain2048", false, chain({ notAfter: "20510101000000Z" }));
  add(src, "a GeneralizedTime notBefore", "chain2048", false, chain({ notBefore: "20260101000000Z" }));
  add(src, "a notAfter in 19YY (UTCTime year 50..99)", "chain2048", false, chain({ notAfter: "991231235959Z" }));
  add(src, "an issuer name of 128 or more content bytes", "chain2048", false, chain({ issuer: name("Test CA", [60, 60, 60]) }));
  add(src, "a TBS without the v3 version block", "chain2048", false, chain({ version: false }));
  add(src, "a currentTime that does not fit in 40 bits", "chain2048", false, chain({}, NOW + (1n << 40n)));

  // --- certChainModulusOffset.test.ts
  src = "certChainModulusOffset";
  for (const length of [127, 128, 255]) {
    add(src, `a subject Name of ${length} content bytes`, "chain2048", true, chain({ subject: subjectOfLength(length) }));
  }
  add(src, "a subject Name of 256 content bytes", "chain2048", false, chain({ subject: subjectOfLength(256) }));
  add(src, "a 4096-bit RSA subject key", "chain2048", false, chain({ spki: makeKey(4096).spki }));
  // An extension that starts like a 2048-bit modulus INTEGER. The extracted
  // key must be the real one: same pk_commit as the plain certificate.
  const decoy = Buffer.concat([hex("0282010100"), Buffer.alloc(256, 0xab)]);
  add(src, "a decoy modulus prefix elsewhere in the TBS (same pk_commit as without it)", "chain2048", true,
    chain({ extraExtensions: [opaqueExtension(decoy)] }), { sameCommitAs: 0 });

  // --- certChainKeyUsage.test.ts
  src = "certChainKeyUsage";
  add(src, "a signing certificate (digitalSignature)", "chain2048", true, chain());
  add(src, "an encryption certificate (keyEncipherment + dataEncipherment)", "chain2048", false,
    chain({ leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION] }));
  add(src, "digitalSignature combined with another usage", "chain2048", false,
    chain({ leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, keyUsage("06c0")] }));
  add(src, "a certificate with no keyUsage extension", "chain2048", false,
    chain({ leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID] }));
  add(src, "keyUsage in a different position", "chain2048", false,
    chain({ leadingExtensions: [KEY_USAGE_SIGNING, AUTHORITY_KEY_ID, SUBJECT_KEY_ID] }));
  add(src, "a TBS truncated inside keyUsage, just before its last byte (0x80)", "chain2048", false,
    cut(hex("300e0603551d0f0101ff040403020780"), 1));
  add(src, "a signing keyUsage placed after an encryption keyUsage", "chain2048", false,
    chain({ leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION], extraExtensions: [KEY_USAGE_SIGNING] }));

  // --- certChainPrimaryCard.test.ts
  src = "certChainPrimaryCard";
  const holder = (...extensions) => chain({ holderExtensions: extensions });
  add(src, "a primary-card certificate", "chain2048", true, chain());
  add(src, "any tailOfPersonalID value", "chain2048", true, holder(CERT_POLICIES, subjectDirectoryAttributes("9870")));
  add(src, "an alien-resident primary-card certificate", "chain2048", false,
    holder(CERT_POLICIES, subjectDirectoryAttributes("5678", [], false, 0x09)));
  add(src, "another subjectType", "chain2048", false,
    holder(CERT_POLICIES, subjectDirectoryAttributes("1234", [], false, 0x02)));
  add(src, "an alien-resident certificate with cardHolderRank = mobile", "chain2048", false,
    holder(CERT_POLICIES, subjectDirectoryAttributes("5678", [cardHolderRank("mobile")], false, 0x09)));
  for (const rank of ["mobile", "secondary"]) {
    add(src, `a certificate with cardHolderRank = ${rank}`, "chain2048", false,
      holder(CERT_POLICIES, subjectDirectoryAttributes("1234", [cardHolderRank(rank)])));
  }
  {
    const rank = cardHolderRank("mobile");
    const sda = subjectDirectoryAttributes("1234", [rank]);
    const body = sda.subarray(11);
    const reordered = Buffer.concat([sda.subarray(0, 11), rank, body.subarray(0, body.length - rank.length)]);
    add(src, "cardHolderRank placed before the other attributes", "chain2048", false, holder(CERT_POLICIES, reordered));
  }
  add(src, "the two attributes in the other order", "chain2048", false,
    holder(CERT_POLICIES, subjectDirectoryAttributes("1234", [], true)));
  {
    const other = Buffer.from(CERT_POLICIES);
    other[other.length - 1] = 0x02;
    add(src, "a different certificate policy", "chain2048", false, holder(other, SUBJECT_DIR_ATTRS));
  }
  add(src, "no subjectDirectoryAttributes", "chain2048", false, holder(CERT_POLICIES));
  add(src, "subjectDirectoryAttributes before certificatePolicies", "chain2048", false, holder(SUBJECT_DIR_ATTRS, CERT_POLICIES));
  add(src, "an unrelated extension between keyUsage and certificatePolicies", "chain2048", false,
    holder(opaqueExtension(Buffer.alloc(4, 0xdd)), CERT_POLICIES, SUBJECT_DIR_ATTRS));
  add(src, "a TBS truncated inside subjectDirectoryAttributes", "chain2048", false, cut(SUBJECT_DIR_ATTRS, 2));

  // --- certChainRS2048.test.ts / certChainRS4096.test.ts (fixture replaced)
  for (const [kind, key, label] of [["chain2048", ca, "RS2048"], ["chain4096", ca4096, "RS4096"]]) {
    src = `certChain${label}`;
    const at = (currentTime) => chainCase({ ca: key, tbs: buildTbs({ spki }), currentTime });
    add(src, "valid cert chain inputs", kind, true, at(NOW));
    add(src, "a currentTime later than any UTCTime notAfter", kind, false, at(491231235959n));
    add(src, "a currentTime earlier than notBefore", kind, false, at(200101000000n));
    add(src, "a currentTime that does not fit in 40 bits", kind, false, at(NOW + (1n << 40n)));
  }

  // --- auditV2Regression.test.ts
  src = "auditV2Regression";
  add(src, "baseline: the honest witness", "chain2048", true, chain());
  // The circom circuit takes the serial number as an input and checks it
  // against the TBS; these point it at other INTEGERs in the TBS. The Noir
  // circuits read the serial themselves and have no such input.
  for (const [forged, what] of [[2n, "version INTEGER"], [65537n, "RSA exponent INTEGER"]]) {
    add(src, `forged serialNumber = ${forged} (${what})`, "chain2048", false,
      { ...chain(), serialNumber: forged }, { noirNotApplicable: "no serial-number input" });
  }
  add(src, "baseline: canonical 31-byte payload", "scope", true, sigCase({ key: user, message: SCOPE }));
  add(src, "a 32-byte payload (appended tail)", "scope", false,
    sigCase({ key: user, message: Buffer.concat([SCOPE, Buffer.from([0x42])]) }),
    { noirNotApplicable: "the signed message is a fixed 31-byte input" });

  // --- userSigRS2048.test.ts
  src = "userSigRS2048";
  add(src, "valid user signature inputs", "scope", true, sigCase({ key: user, message: SCOPE }));
  add(src, "any value for the per-session challenge", "scope", true, sigCase({ key: user, message: SCOPE, challenge: 12345n }),
    { note: "challenge given to circom only: the Noir circuits have no challenge input" });

  // --- pk_commit_linking.test.ts
  src = "pk_commit_linking";
  add(src, "the certificate part and both signature parts give the same pk_commit", "link", true,
    { chain: chain(), sig: sigCase({ key: user, message: SCOPE }), code: sigCase({ key: user, message: CODE }) });

  // --- cases added here
  src = "(new)";
  {
    const c = chain();
    add(src, "a TBS with one byte changed after signing", "chain2048", false,
      { ...c, tbs: Buffer.concat([c.tbs.subarray(0, 60), Buffer.from([c.tbs[60] ^ 1]), c.tbs.subarray(61)]) });
  }
  {
    // The circom circuit holds the padded TBS in 1536 bytes: 1527 raw bytes
    // is the longest it can take.
    const ofLength = (length) => {
      const base = buildTbs({ spki, extraExtensions: [opaqueExtension(Buffer.alloc(300))] }).length;
      const tbs = buildTbs({ spki, extraExtensions: [opaqueExtension(Buffer.alloc(300 + length - base))] });
      if (tbs.length !== length) throw new Error(`built ${tbs.length} bytes, wanted ${length}`);
      return chainCase({ ca, tbs, currentTime: NOW });
    };
    add(src, "a TBS of 1527 bytes, the longest that fits with SHA-256 padding", "chain2048", true, ofLength(1527));
    add(src, "a TBS of 1528 bytes", "chain2048", false, ofLength(1528));
  }
  add(src, "a signature by a key other than the committed one", "scope", false,
    { ...sigCase({ key: makeKey(2048), message: SCOPE }), key: user });
  {
    // s and s + n are the same residue. Only the canonical s may pass, or one
    // card would have two nullifiers. Needs s + n < 2^2048, so retry keys.
    let key, s;
    do {
      key = makeKey(2048);
      s = sigCase({ key, message: SCOPE });
    } while (s.signature + key.modulus >= 1n << 2048n);
    add(src, "a non-canonical signature (s + n)", "scope", false, { ...s, signature: s.signature + key.modulus });
  }
  // The same signature, as an integer, in another limb encoding: one limb
  // holds 2^120 more (2^121 in circom) and the next one 1 less. The nullifier
  // hashes the limbs, so only one encoding may pass.
  add(src, "the scope string signature in a non-canonical limb encoding (same integer)", "scope", false,
    sigCase({ key: user, message: SCOPE, shiftLimb: true }));
  add(src, "the declaration code signature in a non-canonical limb encoding (same integer)", "code", false,
    sigCase({ key: user, message: CODE, shiftLimb: true }));
  add(src, "the issuer signature in a non-canonical limb encoding (same integer), 2048-bit issuer key", "chain2048", false,
    chainCase({ ca, tbs: buildTbs({ spki }), currentTime: NOW, shiftLimb: true }));
  add(src, "the issuer signature in a non-canonical limb encoding (same integer), 4096-bit issuer key", "chain4096", false,
    chainCase({ ca: ca4096, tbs: buildTbs({ spki }), currentTime: NOW, shiftLimb: true }));
  {
    // A card key shorter than 2048 bits, written into the 256 modulus bytes
    // with leading zero bits: the pinned INTEGER header fits it. The
    // certificate part must reject it (ADR-0009).
    const short = makeKey(2047);
    if (short.modulus.toString(2).length !== 2047) throw new Error("not a 2047-bit key");
    add(src, "a 2047-bit subject key written into 256 modulus bytes", "chain2048", false,
      chain({ spki: spkiOfModulus(short.modulus) }));
    add(src, "a 1024-bit subject key written into 256 modulus bytes", "chain2048", false,
      chain({ spki: spkiOfModulus(makeKey(1024).modulus) }));
    const top = Buffer.from(spki.subarray(33, 33 + 256));
    const withFirstByte = (b) => spkiOfModulus(BigInt("0x" + Buffer.concat([Buffer.from([b]), top.subarray(1)]).toString("hex")));
    add(src, "a subject key whose first modulus byte is 0x80", "chain2048", true, chain({ spki: withFirstByte(0x80) }),
      { note: "no card proof: nobody holds the private key of this modulus", noCardProof: true });
    add(src, "a subject key whose first modulus byte is 0x7f", "chain2048", false, chain({ spki: withFirstByte(0x7f) }));
    // The signature part on its own. circom's UserSigRSA256 does not look at
    // the key length; its certificate part does (the two cases above), and
    // the key commitment ties the two. The Noir part rejects by itself.
    add(src, "a signature by a 2047-bit key", "scope", false, sigCase({ key: short, message: SCOPE }),
      { circomExpect: true, partLevel: "circom checks the key length in its certificate part only; rejected there (the 2047-bit case above)" });
  }

  // --- message kinds: the first signed byte (no counterpart in circom)
  src = "(kind)";
  const KIND_NOTE = { intended: "circom has no kind check" };
  add(src, "as the scope string: a signature over a declaration code", "scope", false,
    sigCase({ key: user, message: CODE }), { circomExpect: true, ...KIND_NOTE });
  add(src, "as the declaration code: a signature over a declaration code", "code", true, sigCase({ key: user, message: CODE }));
  add(src, "as the declaration code: a signature over a scope string", "code", false,
    sigCase({ key: user, message: SCOPE }), { circomExpect: true, ...KIND_NOTE });
  for (const [first, kind] of FIRST_BYTES) {
    const message = Buffer.concat([Buffer.from(first, "latin1"), SCOPE.subarray(1)]);
    const shown = /^[A-Za-z0-9_{@[]$/.test(first) ? `\`${first}\`` : `0x${message[0].toString(16).padStart(2, "0")}`;
    for (const [position, label] of [["scope", "the scope string"], ["code", "the declaration code"]]) {
      const expect = kind === position;
      add(src, `as ${label}: a message starting with ${shown}`, position, expect,
        sigCase({ key: user, message }), expect ? {} : { circomExpect: true, ...KIND_NOTE });
    }
  }

  return { cases, ca, user };
}
