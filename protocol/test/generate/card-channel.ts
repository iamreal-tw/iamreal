// Writes spec/vectors/card-channel.json (spec/card-channel.md). Run in protocol/:
//   node --experimental-strip-types test/generate/card-channel.ts
// AES comes from node:crypto; AES-CMAC (RFC 4493) is built on it here and
// checked against the RFC's own examples before anything is written. All key
// material, card identifiers and challenges below are made up for the
// vectors. Nothing in protocol/src uses this: no TypeScript program talks
// to a card.
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const hex = (b: Buffer) => b.toString("hex");
const unhex = (s: string) => Buffer.from(s, "hex");

function aesEcb(encrypt: boolean, key: Buffer, block: Buffer): Buffer {
  const c = encrypt ? createCipheriv("aes-128-ecb", key, null) : createDecipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function aesCbc(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const c = createCipheriv("aes-128-cbc", key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

// RFC 4493.
function cmac(key: Buffer, msg: Buffer): Buffer {
  const dbl = (b: Buffer) => {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) out[i] = ((b[i]! << 1) | (i < 15 ? b[i + 1]! >> 7 : 0)) & 0xff;
    if (b[0]! & 0x80) out[15]! ^= 0x87;
    return out;
  };
  const k1 = dbl(aesEcb(true, key, Buffer.alloc(16)));
  const k2 = dbl(k1);
  const n = Math.max(1, Math.ceil(msg.length / 16));
  const complete = msg.length > 0 && msg.length % 16 === 0;
  const last = Buffer.alloc(16);
  if (complete) msg.copy(last, 0, (n - 1) * 16);
  else {
    msg.copy(last, 0, (n - 1) * 16);
    last[msg.length - (n - 1) * 16] = 0x80;
  }
  const sub = complete ? k1 : k2;
  for (let i = 0; i < 16; i++) last[i]! ^= sub[i]!;
  let x: Buffer = Buffer.alloc(16);
  for (let j = 0; j < n - 1; j++) {
    const y = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) y[i] = x[i]! ^ msg[j * 16 + i]!;
    x = aesEcb(true, key, y);
  }
  for (let i = 0; i < 16; i++) last[i]! ^= x[i]!;
  return aesEcb(true, key, last);
}

// RFC 4493, section 4: the examples, before anything else.
{
  const key = unhex("2b7e151628aed2a6abf7158809cf4f3c");
  const m = unhex(
    "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
  );
  const examples: [number, string][] = [
    [0, "bb1d6929e95937287fa37d129b756746"],
    [16, "070a16b46b4d4144f79bdd9dd04a287c"],
    [40, "dfa66747de9ae63030ca32611497c827"],
    [64, "51f0bebf7e3b9d92fc49741779363cfe"],
  ];
  for (const [len, want] of examples) {
    const got = hex(cmac(key, m.subarray(0, len)));
    if (got !== want) throw new Error(`AES-CMAC differs from RFC 4493 for ${len} bytes: ${got}`);
  }
}

// The security domain's application identifier: its last five bytes go
// into the derivation.
const ISD_CM_AID = unhex("a000000283ff088692535389c00014");

// The card's static keys from the key material and the card identifier.
function diversify(kek: Buffer, masterEnc: Buffer, cardId: Buffer) {
  if (cardId.length !== 10) throw new Error("card id is 10 bytes");
  const master = aesEcb(false, kek, masterEnc);
  const derive = (constant: number, index: number) => {
    const s = Buffer.alloc(32);
    s[0x0b] = constant;
    s[0x0e] = 0x80;
    s[0x0f] = 0x01;
    s[0x10] = index;
    cardId.copy(s, 0x11);
    ISD_CM_AID.copy(s, 0x1b, 10, 15);
    return { input: s, key: cmac(master, s) };
  };
  const enc = derive(0x04, 1);
  const mac = derive(0x06, 2);
  return { master, k_enc_input: enc.input, k_enc: enc.key, k_mac_input: mac.input, k_mac: mac.key };
}

// The key derivation of GlobalPlatform SCP03 (NIST SP 800-108, counter
// mode, AES-CMAC as the PRF).
function kdf(key: Buffer, constant: number, context: Buffer, bits: number): Buffer {
  const len = bits / 8;
  const parts: Buffer[] = [];
  for (let counter = 1; Buffer.concat(parts).length < len; counter++) {
    parts.push(cmac(key, Buffer.concat([Buffer.alloc(11), Buffer.from([constant, 0, bits >> 8, bits & 0xff, counter]), context])));
  }
  return Buffer.concat(parts).subarray(0, len);
}

type Session = { s_enc: Buffer; s_mac: Buffer; mcv: Buffer; counter: number };

function establish(kEnc: Buffer, kMac: Buffer, host: Buffer, cardChallenge: Buffer, cardCryptogram: Buffer) {
  const context = Buffer.concat([host, cardChallenge]);
  const s_mac = kdf(kMac, 0x06, context, 128);
  const s_enc = kdf(kEnc, 0x04, context, 128);
  const expected = kdf(s_mac, 0x00, context, 64);
  if (!expected.equals(cardCryptogram)) return { accepted: false as const, s_enc, s_mac, expected_card_cryptogram: expected };
  const host_cryptogram = kdf(s_mac, 0x01, context, 64);
  const header = Buffer.from([0x84, 0x82, 0x03, 0x00, 0x10]);
  const mac = cmac(s_mac, Buffer.concat([Buffer.alloc(16), header, host_cryptogram]));
  return {
    accepted: true as const,
    s_enc,
    s_mac,
    expected_card_cryptogram: expected,
    host_cryptogram,
    external_authenticate: { header, body: Buffer.concat([host_cryptogram, mac.subarray(0, 8)]) },
    session: { s_enc, s_mac, mcv: mac, counter: 1 } satisfies Session,
  };
}

function pad80(d: Buffer): Buffer {
  const out = Buffer.alloc((Math.floor(d.length / 16) + 1) * 16);
  d.copy(out);
  out[d.length] = 0x80;
  return out;
}

// One command into the channel. The counter goes up by one for every
// command, with or without data (spec/card-channel.md, "Commands").
function wrap(s: Session, cla: number, ins: number, p1: number, p2: number, data: Buffer, encrypt: boolean) {
  const counter = s.counter;
  let iv: Buffer | null = null;
  let cipher: Buffer = Buffer.alloc(0);
  if (encrypt && data.length > 0) {
    const block = Buffer.alloc(16);
    block.writeUInt32BE(counter, 12);
    iv = aesEcb(true, s.s_enc, block);
    cipher = aesCbc(s.s_enc, iv, pad80(data));
  }
  s.counter += 1;
  const header = Buffer.from([cla | 0x04, ins, p1, p2, cipher.length + 8]);
  const mac = cmac(s.s_mac, Buffer.concat([s.mcv, header, cipher]));
  s.mcv = mac;
  return { counter, iv, header, body: Buffer.concat([cipher, mac.subarray(0, 8)]), mcv: mac };
}

function pinBlock(pin: string): Buffer | null {
  if (pin.length < 6 || pin.length > 10 || [...pin].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e)) return null;
  const b = Buffer.alloc(10, 0xff);
  Buffer.from(pin, "ascii").copy(b);
  return b;
}

// EMSA-PKCS1-v1_5 with SHA-256, for a 2048-bit key: the block the card is
// given to sign, in two halves.
function signBlock(message: Buffer): Buffer {
  const t = Buffer.concat([unhex("3031300d060960864801650304020105000420"), createHash("sha256").update(message).digest()]);
  const b = Buffer.alloc(256, 0xff);
  b[0] = 0x00;
  b[1] = 0x01;
  b[256 - t.length - 1] = 0x00;
  t.copy(b, 256 - t.length);
  return b;
}

// ---- The cases. Every value below is made up. ----

const KEK = unhex("00112233445566778899aabbccddeeff");
const MASTER_ENC = unhex("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
const CARD_IDS = ["01020304050607080900", "ffeeddccbbaa99887766"];

const diversifyCases = [
  { name: "a card", kek: KEK, master_enc: MASTER_ENC, card_id: unhex(CARD_IDS[0]!) },
  { name: "another card, same key material", kek: KEK, master_enc: MASTER_ENC, card_id: unhex(CARD_IDS[1]!) },
  { name: "other key material, same card", kek: unhex("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5"), master_enc: unhex("5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"), card_id: unhex(CARD_IDS[0]!) },
].map((c) => {
  const d = diversify(c.kek, c.master_enc, c.card_id);
  return {
    name: c.name,
    kek: hex(c.kek),
    master_enc: hex(c.master_enc),
    card_id: hex(c.card_id),
    master: hex(d.master),
    k_enc_input: hex(d.k_enc_input),
    k_enc: hex(d.k_enc),
    k_mac_input: hex(d.k_mac_input),
    k_mac: hex(d.k_mac),
  };
});

// GET DATA, tag 45, from the security domain: the response data.
const cardIdCases = [
  { name: "tag 45, length 10", response: "450a" + CARD_IDS[0], card_id: CARD_IDS[0] },
  { name: "bytes after the identifier are ignored", response: "450a" + CARD_IDS[1] + "9f7f00", card_id: CARD_IDS[1] },
  { name: "too short", response: "450a0102030405060708", card_id: null },
  { name: "another tag", response: "460a" + CARD_IDS[0], card_id: null },
  { name: "another length", response: "4508" + CARD_IDS[0], card_id: null },
  { name: "empty", response: "", card_id: null },
];
for (const c of cardIdCases) {
  const r = unhex(c.response);
  const got = r.length >= 12 && r[0] === 0x45 && r[1] === 0x0a ? hex(r.subarray(2, 12)) : null;
  if (got !== c.card_id) throw new Error(`card id case "${c.name}": ${got}`);
}

// The data of INITIALIZE UPDATE's response.
const keyDiversification = "00000000000000000000";
const keyInfo = "300370";
const iuCases = [
  { name: "SCP03", response: keyDiversification + keyInfo + "1122334455667788" + "8877665544332211" + "000001", accepted: true },
  { name: "exactly 29 bytes", response: keyDiversification + "300370" + "1122334455667788" + "8877665544332211", accepted: true },
  { name: "SCP02 in the key information", response: keyDiversification + "300270" + "1122334455667788" + "8877665544332211", accepted: false },
  { name: "28 bytes", response: keyDiversification + keyInfo + "1122334455667788" + "88776655443322", accepted: false },
].map((c) => {
  const r = unhex(c.response);
  const accepted = r.length >= 29 && r[11] === 0x03;
  if (accepted !== c.accepted) throw new Error(`INITIALIZE UPDATE case "${c.name}"`);
  return accepted
    ? { ...c, card_challenge: hex(r.subarray(13, 21)), card_cryptogram: hex(r.subarray(21, 29)) }
    : c;
});

const card0 = diversify(KEK, MASTER_ENC, unhex(CARD_IDS[0]!));
const card1 = diversify(KEK, MASTER_ENC, unhex(CARD_IDS[1]!));
const sessionInputs = [
  { name: "a session", k: card0, host: unhex("d1d2d3d4d5d6d7d8"), challenge: unhex("c1c2c3c4c5c6c7c8"), cryptogram: "right" },
  { name: "another host challenge", k: card0, host: unhex("0102030405060708"), challenge: unhex("c1c2c3c4c5c6c7c8"), cryptogram: "right" },
  { name: "another card", k: card1, host: unhex("d1d2d3d4d5d6d7d8"), challenge: unhex("c1c2c3c4c5c6c7c8"), cryptogram: "right" },
  { name: "the card's cryptogram is wrong in the last bit", k: card0, host: unhex("d1d2d3d4d5d6d7d8"), challenge: unhex("c1c2c3c4c5c6c7c8"), cryptogram: "last bit" },
  { name: "the cryptogram of another card", k: card0, host: unhex("d1d2d3d4d5d6d7d8"), challenge: unhex("c1c2c3c4c5c6c7c8"), cryptogram: "card1" },
] as const;
const sessionCases = sessionInputs.map((c) => {
  const context = Buffer.concat([c.host, c.challenge]);
  const right = kdf(kdf(c.k.k_mac, 0x06, context, 128), 0x00, context, 64);
  let given: Buffer = right;
  if (c.cryptogram === "last bit") {
    given = Buffer.from(right);
    given[7]! ^= 0x01;
  } else if (c.cryptogram === "card1") given = kdf(kdf(card1.k_mac, 0x06, context, 128), 0x00, context, 64);
  const e = establish(c.k.k_enc, c.k.k_mac, c.host, c.challenge, given);
  const base = {
    name: c.name,
    k_enc: hex(c.k.k_enc),
    k_mac: hex(c.k.k_mac),
    host_challenge: hex(c.host),
    card_challenge: hex(c.challenge),
    card_cryptogram: hex(given),
    s_enc: hex(e.s_enc),
    s_mac: hex(e.s_mac),
    expected_card_cryptogram: hex(e.expected_card_cryptogram),
    accepted: e.accepted,
  };
  if (c.cryptogram === "right" && !e.accepted) throw new Error(`session case "${c.name}" should be accepted`);
  if (c.cryptogram !== "right" && e.accepted) throw new Error(`session case "${c.name}" should be refused`);
  if (!e.accepted) return base;
  return {
    ...base,
    host_cryptogram: hex(e.host_cryptogram),
    external_authenticate: { header: hex(e.external_authenticate.header), body: hex(e.external_authenticate.body) },
    mcv: hex(e.session.mcv),
  };
});

// The commands of one signing, in the order a card proof sends them, in one
// session. PIN and message are made up.
const PIN = "123456";
const MESSAGE = Buffer.from("iamreal-test:vectors:card-channel", "ascii");
const KEY_REF = 0x81;
const block = signBlock(MESSAGE);
const sequenceSteps: { name: string; cla: number; ins: number; p1: number; p2: number; data: Buffer; encrypt: boolean }[] = [
  { name: "VERIFY, the PIN block", cla: 0x00, ins: 0x20, p1: 0x00, p2: 0x01, data: pinBlock(PIN)!, encrypt: true },
  { name: "SELECT 5030", cla: 0x00, ins: 0xa4, p1: 0x00, p2: 0x04, data: unhex("5030"), encrypt: true },
  { name: "SELECT 0810", cla: 0x00, ins: 0xa4, p1: 0x00, p2: 0x04, data: unhex("0810"), encrypt: true },
  { name: "sign, first half of the block", cla: 0x80, ins: 0xea, p1: 0x82, p2: KEY_REF, data: block.subarray(0, 128), encrypt: true },
  { name: "sign, second half of the block", cla: 0x80, ins: 0xea, p1: 0x02, p2: KEY_REF, data: block.subarray(128), encrypt: true },
  { name: "read the rest of the signature, no data", cla: 0x80, ins: 0xc1, p1: 0x00, p2: 0x80, data: Buffer.alloc(0), encrypt: false },
  { name: "read the rest again, no data", cla: 0x80, ins: 0xc1, p1: 0x00, p2: 0x80, data: Buffer.alloc(0), encrypt: false },
  { name: "VERIFY after commands without data (a second signing in the same session)", cla: 0x00, ins: 0x20, p1: 0x00, p2: 0x01, data: pinBlock(PIN)!, encrypt: true },
  { name: "SELECT 5030 again", cla: 0x00, ins: 0xa4, p1: 0x00, p2: 0x04, data: unhex("5030"), encrypt: true },
];
const first = establish(card0.k_enc, card0.k_mac, unhex("d1d2d3d4d5d6d7d8"), unhex("c1c2c3c4c5c6c7c8"),
  kdf(kdf(card0.k_mac, 0x06, unhex("d1d2d3d4d5d6d7d8c1c2c3c4c5c6c7c8"), 128), 0x00, unhex("d1d2d3d4d5d6d7d8c1c2c3c4c5c6c7c8"), 64));
if (!first.accepted) throw new Error("the sequence's session");
const s = first.session;
const sequence = {
  name: "one session: a PIN, two selects, a signing, two commands without data, then a second PIN",
  s_enc: hex(s.s_enc),
  s_mac: hex(s.s_mac),
  mcv: hex(s.mcv),
  steps: sequenceSteps.map((st) => {
    const w = wrap(s, st.cla, st.ins, st.p1, st.p2, st.data, st.encrypt);
    return {
      name: st.name,
      cla: st.cla,
      ins: st.ins,
      p1: st.p1,
      p2: st.p2,
      data: hex(st.data),
      encrypt: st.encrypt,
      counter: w.counter,
      iv: w.iv === null ? null : hex(w.iv),
      header: hex(w.header),
      body: hex(w.body),
      mcv: hex(w.mcv),
    };
  }),
};
if (sequence.steps.map((x) => x.counter).join() !== "1,2,3,4,5,6,7,8,9") throw new Error("counter");

const pinCases = ["123456", "1234567890", "00000000", "12345", "12345678901", "12345é"].map((pin) => {
  const b = pinBlock(pin);
  return { pin, block: b === null ? null : hex(b) };
});
const expectedPinBlocks: Record<string, string | null> = {
  "123456": "313233343536ffffffff",
  "1234567890": "31323334353637383930",
  "00000000": "3030303030303030ffff",
  "12345": null,
  "12345678901": null,
  "12345é": null,
};
for (const c of pinCases) if (c.block !== expectedPinBlocks[c.pin]) throw new Error(`PIN block "${c.pin}"`);

const signBlockCase = { message: hex(MESSAGE), block: hex(block) };
if (!hex(block).startsWith("0001ffff") || !hex(block).includes("003031300d060960864801650304020105000420")) throw new Error("sign block");

const out = {
  spec: "card-channel",
  status: "draft",
  note: "Every key, identifier, challenge and PIN here is made up; none is the key material of a real card. Bytes are lowercase hex.",
  generated_by: "protocol/test/generate/card-channel.ts",
  diversify: diversifyCases,
  card_id: cardIdCases,
  initialize_update: iuCases,
  session: sessionCases,
  pin_block: pinCases,
  sign_block: signBlockCase,
  sequence,
};
writeFileSync(new URL("../../../spec/vectors/card-channel.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
