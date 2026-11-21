// Random case generation. Every case comes from rngFor(seed, index) alone
// (plus the fixed key pool), so `--case N` reproduces it.
import { bigToBytes, byteLen, emsa, rngFor, sha256, signRaw, signStd, DIGEST_INFO_SHA256, bytesToBig } from "./common.mjs";
import {
  AKI_HEAD, CERT_POLICIES, EXPONENT, KEY_USAGE, SDA_HEAD, SIG_ALG, SKI_HEAD, SPKI_HEAD, VERSION, walk, MAX_SIGNED_LEN,
} from "./oracle.mjs";

const hx = (s) => Buffer.from(s.replace(/ /g, ""), "hex");

export function tlv(tag, content) {
  const n = content.length;
  const head = n < 0x80 ? [tag, n] : n < 0x100 ? [tag, 0x81, n] : [tag, 0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from(head), content]);
}
/** Always the 82 HH LL form, as the circuits expect for the outer and extension headers. */
export const tlv82 = (tag, content) =>
  Buffer.concat([Buffer.from([tag, 0x82, (content.length >> 8) & 0xff, content.length & 0xff]), content]);

// ---------------------------------------------------------------- field generators
function digitsTime(r) {
  const two = (lo, hi) => String(r.int(lo, hi)).padStart(2, "0");
  if (r.bool(0.1)) return Array.from({ length: 12 }, () => r.int(0, 9)).join("").replace(/^./, String(r.int(0, 4)));
  return two(0, 49) + two(1, 12) + two(1, 31) + two(0, 23) + two(0, 59) + two(0, 59);
}

function nameContent(r, len) {
  // Either raw bytes (the circuits never parse a Name's content) or RDN-ish.
  if (r.bool(0.5)) return r.bytes(len);
  const parts = [];
  let left = len;
  while (left > 0) {
    if (left < 12) { parts.push(r.bytes(left)); break; }
    const v = Math.min(left - 11, r.int(1, 60));
    const rdn = tlv(0x31, tlv(0x30, Buffer.concat([tlv(0x06, hx("550403")), tlv(0x0c, r.bytes(v))])));
    parts.push(rdn);
    left -= rdn.length;
  }
  const out = Buffer.concat(parts);
  return out.length === len ? out : r.bytes(len);
}

function serialBytes(r) {
  const n = r.weighted([[5, 16], [3, () => r.int(1, 20)], [1, 1], [1, 20]]);
  const len = typeof n === "function" ? n() : n;
  const b = r.bytes(len);
  if (r.bool(0.3)) b[0] &= 0x7f;
  return b;
}

export function manualSpki(modulusBytes, exponent = EXPONENT) {
  return Buffer.concat([SPKI_HEAD, modulusBytes, exponent]);
}

function holderExt(r) {
  return Buffer.concat([CERT_POLICIES, SDA_HEAD, r.bytes(4)]);
}

function opaqueExt(r, contentLen) {
  return tlv(0x30, Buffer.concat([hx("06092b06010401868d1f01"), tlv(0x04, r.bytes(contentLen))]));
}

/** The pieces of a TBS; `assemble` joins them. Mutations work on these or on bytes. */
function baseSegments(r, pool, opts = {}) {
  const issuerLen = opts.issuerLen ?? r.weighted([[6, () => r.int(20, 127)], [1, () => 127], [1, () => r.int(0, 19)]])();
  const subjectLen = opts.subjectLen ?? r.weighted([[5, () => r.int(30, 127)], [3, () => r.int(128, 255)], [1, () => r.pick([0, 127, 128, 255])]])();
  let nb = digitsTime(r), na = digitsTime(r);
  if (nb > na && r.bool(0.9)) [nb, na] = [na, nb];
  const keyIdx = r.int(0, pool.user2048.length - 1);
  const ext = [
    Buffer.concat([AKI_HEAD, r.bytes(20)]),
    Buffer.concat([SKI_HEAD, r.bytes(20)]),
    KEY_USAGE,
    holderExt(r),
  ];
  const trailing = [];
  const nTrail = r.int(0, 3);
  for (let i = 0; i < nTrail; i++) trailing.push(opaqueExt(r, r.int(0, 300)));
  return {
    version: VERSION,
    serial: tlv(0x02, serialBytes(r)),
    sigAlg: SIG_ALG,
    issuer: tlv(0x30, nameContent(r, issuerLen)),
    validity: tlv(0x30, Buffer.concat([tlv(0x17, Buffer.from(nb + "Z")), tlv(0x17, Buffer.from(na + "Z"))])),
    subject: tlv(0x30, nameContent(r, subjectLen)),
    spki: pool.user2048[keyIdx].spki,
    ext,
    trailing,
    times: { nb: BigInt(nb), na: BigInt(na) },
    subjectKey: { group: "user2048", idx: keyIdx },
  };
}

export function assemble(seg) {
  const extBody = Buffer.concat([...seg.ext, ...seg.trailing]);
  const extensions = seg.rawExtensions ?? tlv82(0xa3, tlv82(0x30, extBody));
  const order = seg.order ?? ["version", "serial", "sigAlg", "issuer", "validity", "subject", "spki", "extensions"];
  const all = { ...seg, extensions };
  return tlv82(0x30, Buffer.concat(order.map((k) => all[k])));
}

/** Pads with one trailing extension so the TBS is exactly `target` bytes, if it can. */
function padTo(r, seg, target) {
  for (let tries = 0; tries < 6; tries++) {
    const len = assemble(seg).length;
    const need = target - len;
    if (need === 0) return true;
    if (need < 0) {
      if (!seg.trailing.length) return false;
      seg.trailing.pop();
      continue;
    }
    // opaqueExt(n) costs n + overhead; overhead depends on n's length form.
    let n = need - 15;
    for (; n >= 0; n--) if (opaqueExt(r, n).length <= need) break;
    if (n < 0) return false;
    const e = opaqueExt(r, n);
    seg.trailing.push(e);
    // extensions headers are fixed 82-form, so lengths add up exactly
  }
  return assemble(seg).length === target;
}

const fixOuter = (tbs) => {
  const b = Buffer.from(tbs);
  if (b.length >= 4) { b[1] = 0x82; b.writeUInt16BE((b.length - 4) & 0xffff, 2); }
  return b;
};

function chooseNow(r, nb, na) {
  return r.weighted([
    [20, () => nb + BigInt(Math.floor(r.float() * Number(na - nb + 1n)))],
    [2, () => nb],
    [2, () => na],
    [0.5, () => nb - 1n],
    [0.5, () => na + 1n],
    [0.5, () => BigInt(r.int(0, 999999)) * 1000000n + BigInt(r.int(0, 999999))],
  ])();
}

// ---------------------------------------------------------------- signature forgeries
/** Encodings a signer could produce that are not the one valid EM. */
export function badEm(r, message, k) {
  const good = emsa(message, k);
  const H = sha256(message);
  const kind = r.pick(["bt02", "ps-nonff", "no-sep", "short-ps-trailing", "di-noparams", "di-flip", "hash-flip",
    "hash-other", "random", "good", "lead01", "di-sha1", "ps-zero-run", "hash-shifted"]);
  let em = Buffer.from(good);
  switch (kind) {
    case "good": break;
    case "bt02": em[1] = 0x02; break;
    case "lead01": em[0] = 0x01; break;
    case "ps-nonff": em[r.int(2, k - 53)] = r.int(0, 0xfe); break;
    case "no-sep": em[k - 52] = 0xff; break;
    case "short-ps-trailing": {
      const s = r.int(1, 8);
      em = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - 54 - s, 0xff), Buffer.from([0]), DIGEST_INFO_SHA256, H, r.bytes(s)]);
      break;
    }
    case "hash-shifted": {
      const s = r.int(1, 4);
      em = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - 54 - s, 0xff), Buffer.from([0]), DIGEST_INFO_SHA256, H, Buffer.alloc(s)]);
      break;
    }
    case "di-noparams": {
      const di = hx("302f300b0609608648016503040201 0420");
      em = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - 3 - di.length - 32, 0xff), Buffer.from([0]), di, H]);
      break;
    }
    case "di-sha1": {
      const di = hx("3021300906052b0e03021a05000414");
      em = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - 3 - di.length - 20, 0xff), Buffer.from([0]), di, H.subarray(0, 20)]);
      break;
    }
    case "di-flip": em[k - 51 + r.int(0, 18)] ^= 1 << r.int(0, 7); break;
    case "hash-flip": em[k - 32 + r.int(0, 31)] ^= 1 << r.int(0, 7); break;
    case "hash-other": em = emsa(Buffer.concat([message, Buffer.from([1])]), k); break;
    case "random": em = r.bytes(k); em[0] = 0; break;
    case "ps-zero-run": em.fill(0, 2, 2 + r.int(1, 8)); break;
  }
  return { kind, em, valid: em.equals(good) };
}

/** Non-canonical limb encoding of the same integer: limb i gets m * 2^bits, limb i+1 loses m. */
export function nonCanonical(limbArr, bits, i, m) {
  const out = [...limbArr];
  if (out[i + 1] < m) return null;
  out[i] += m << BigInt(bits);
  out[i + 1] -= m;
  return out;
}

// ---------------------------------------------------------------- chain cases
const CHAIN_MUTATIONS = [
  [14, "none"],
  [10, "flip-byte-read"],
  [6, "flip-byte-any"],
  [6, "flip-bit-read"],
  [4, "flip-byte-nosign"],
  [5, "special-byte"],
  [5, "len-field"],
  [3, "truncate"],
  [3, "extend"],
  [3, "insert"],
  [3, "delete"],
  [3, "swap-segments"],
  [3, "swap-ext"],
  [5, "sig"],
  [3, "issuer-key"],
  [5, "time"],
  [6, "smt"],
  [4, "key"],
  [3, "serial"],
  [3, "names"],
  [3, "total-length"],
  [2, "decoy"],
  [2, "keyusage"],
  [2, "holder"],
  [2, "stack"],
];

/**
 * A certificate case. Returns { family: "chain", bits, caRef, tbs, signature,
 * sigNote, issuerModulus, now, smtPlan, subjectKey, mutation, garbage, pkBlind }.
 */
export function genChain(r, pool, mutation = r.weighted(CHAIN_MUTATIONS), override = {}) {
  const bits = r.bool(0.8) ? 2048 : 4096;
  const caGroup = bits === 2048 ? "ca2048" : "ca4096";
  const caIdx = r.int(0, pool[caGroup].length - 1);
  const ca = pool[caGroup][caIdx];
  const seg = baseSegments(r, pool);
  if (override.spki) { seg.spki = override.spki; seg.subjectKey = override.subjectKey; }
  let subjectKey = seg.subjectKey;
  if (r.bool(0.15)) padTo(r, seg, r.int(assemble(seg).length, MAX_SIGNED_LEN));
  let tbs = assemble(seg);
  let resign = true;
  let preFlip = null;
  let now = chooseNow(r, seg.times.nb, seg.times.na);
  let sigOverride = null;
  let issuerModulus = ca.modulus;
  let sigNote = "standard";
  const smtPlan = { revoked: [], mut: "none", aux: {} };
  const notes = [];

  const readPos = () => {
    const w = walk(tbs, now);
    const reads = w.reads.filter((p) => p < tbs.length);
    return reads.length ? r.pick(reads) : r.int(0, tbs.length - 1);
  };

  const apply = (m) => {
    notes.push(m);
    switch (m) {
      case "none": break;
      case "flip-byte-read": case "flip-byte-any": case "flip-byte-nosign": {
        const pos = m === "flip-byte-any" ? r.int(0, tbs.length - 1) : readPos();
        if (m === "flip-byte-nosign") { resign = false; preFlip = Buffer.from(tbs); }
        tbs = Buffer.from(tbs);
        tbs[pos] ^= r.int(1, 255);
        notes.push(`@${pos}`);
        break;
      }
      case "flip-bit-read": {
        const pos = readPos();
        tbs = Buffer.from(tbs);
        tbs[pos] ^= 1 << r.int(0, 7);
        notes.push(`@${pos}`);
        break;
      }
      case "special-byte": {
        const pos = readPos();
        tbs = Buffer.from(tbs);
        tbs[pos] = r.pick([0x00, 0x01, 0x02, 0x2f, 0x30, 0x34, 0x35, 0x39, 0x3a, 0x5a, 0x7f, 0x80, 0x81, 0x82, 0x83, 0xff, (tbs[pos] + 1) & 0xff, (tbs[pos] - 1) & 0xff]);
        notes.push(`@${pos}=${tbs[pos]}`);
        break;
      }
      case "len-field": {
        const w = walk(tbs, now);
        const cands = [2, 3, 10];
        if (w.at.issuer !== undefined) cands.push(w.at.issuer + 1);
        if (w.at.subject !== undefined) cands.push(w.at.subject + 1, w.at.subject + 2);
        if (w.at.spki !== undefined) cands.push(w.at.spki + 2, w.at.spki + 3, w.at.spki + 31, w.at.spki + 32);
        if (w.at.extensions !== undefined) cands.push(w.at.extensions + 2, w.at.extensions + 3, w.at.extensions + 6, w.at.extensions + 7);
        const pos = r.pick(cands);
        tbs = Buffer.from(tbs);
        tbs[pos] = (tbs[pos] + r.pick([-2, -1, 1, 2, r.int(0, 255)])) & 0xff;
        notes.push(`@${pos}`);
        break;
      }
      case "truncate": tbs = fixOuter(tbs.subarray(0, r.int(4, tbs.length - 1))); break;
      case "extend": tbs = fixOuter(Buffer.concat([tbs, r.bytes(r.int(1, 64))])); break;
      case "insert": {
        const pos = r.int(4, tbs.length);
        tbs = fixOuter(Buffer.concat([tbs.subarray(0, pos), r.bytes(r.int(1, 4)), tbs.subarray(pos)]));
        notes.push(`@${pos}`);
        break;
      }
      case "delete": {
        const pos = r.int(4, tbs.length - 1);
        tbs = fixOuter(Buffer.concat([tbs.subarray(0, pos), tbs.subarray(pos + r.int(1, 4))]));
        notes.push(`@${pos}`);
        break;
      }
      case "swap-segments": {
        const order = ["version", "serial", "sigAlg", "issuer", "validity", "subject", "spki", "extensions"];
        const i = r.int(0, 7), j = r.int(0, 7);
        [order[i], order[j]] = [order[j], order[i]];
        seg.order = order;
        tbs = assemble(seg);
        notes.push(`${order[j]}<->${order[i]}`);
        break;
      }
      case "swap-ext": {
        const i = r.int(0, seg.ext.length - 1), j = r.int(0, seg.ext.length - 1);
        [seg.ext[i], seg.ext[j]] = [seg.ext[j], seg.ext[i]];
        if (r.bool(0.3)) seg.ext.splice(r.int(0, seg.ext.length), 0, opaqueExt(r, r.int(0, 8)));
        tbs = assemble(seg);
        break;
      }
      case "sig": {
        const k = r.pick(["plus-n", "flip", "random", "zero", "one", "n-1", "other-ca", "em", "prefix", "noncanon", "plus-2n"]);
        notes.push(k);
        sigNote = k;
        if (k === "em") {
          const b = badEm(r, tbs, byteLen(ca.modulus));
          notes.push(b.kind);
          sigOverride = { kind: "raw", em: b.em };
        } else sigOverride = { kind: k, aux: r.big(bits) };
        break;
      }
      case "issuer-key": {
        // Public key given to the circuit is not the one that signed.
        const other = pool[caGroup][(caIdx + 1) % pool[caGroup].length];
        issuerModulus = r.bool(0.5) ? other.modulus : ca.modulus ^ (1n << BigInt(r.int(0, bits - 2)));
        break;
      }
      case "time": {
        const k = r.pick(["expired", "future", "eq-nb", "eq-na", "over40", "yy50", "generalized", "nondigit", "inverted"]);
        notes.push(k);
        if (k === "expired") now = seg.times.na + BigInt(r.int(1, 1000000));
        if (k === "future") now = seg.times.nb - BigInt(r.int(1, 1000000));
        if (k === "eq-nb") now = seg.times.nb;
        if (k === "eq-na") now = seg.times.na;
        if (k === "over40") now = (1n << 40n) + BigInt(r.int(0, 1000)) * (r.bool() ? 1n : 1000000000n);
        if (k === "yy50" || k === "generalized" || k === "nondigit" || k === "inverted") {
          let nb = seg.validity.subarray(4, 16).toString(), na = seg.validity.subarray(19, 31).toString();
          let nbT = 0x17, naT = 0x17;
          if (k === "yy50") { if (r.bool()) na = String(r.int(50, 99)) + na.slice(2); else nb = String(r.int(50, 99)) + nb.slice(2); }
          if (k === "generalized") { if (r.bool()) { na = "20" + na; naT = 0x18; } else { nb = "20" + nb; nbT = 0x18; } }
          if (k === "nondigit") {
            const which = r.bool() ? "nb" : "na";
            const s = (which === "nb" ? nb : na).split("");
            s[r.int(0, 11)] = String.fromCharCode(r.pick([0x2f, 0x3a, 0x20, 0x41, 0x5a, 0x00]));
            if (which === "nb") nb = s.join(""); else na = s.join("");
          }
          if (k === "inverted") [nb, na] = [na, nb];
          seg.validity = tlv(0x30, Buffer.concat([tlv(nbT, Buffer.from(nb + "Z", "latin1")), tlv(naT, Buffer.from(na + "Z", "latin1"))]));
          tbs = assemble(seg);
        }
        break;
      }
      case "smt": {
        const k = r.pick(["listed", "listed", "neighbours", "neighbours", "proof-mut", "proof-mut", "proof-mut"]);
        notes.push(k);
        smtPlan.kind = k;
        smtPlan.listedSerial = k === "listed";
        smtPlan.mut = k === "listed" ? r.pick(["revoked-self", "revoked-without", "revoked-empty", "oldKey-self"])
          : k === "proof-mut" ? r.pick(["sibling-random", "sibling-extra", "sibling-last", "drop-last", "isOld0-flip", "oldKey-other", "oldValue-other", "oldKey-self", "root-other"])
          : "none";
        smtPlan.aux = { i: r.int(0, 200), value: r.big(250) | 1n, key: r.big(128) | 1n };
        notes.push(smtPlan.mut);
        break;
      }
      case "key": {
        const k = r.pick(["user4096", "user1024", "userE3", "user2047", "fake-top-set", "fake-top-clear", "fake-small"]);
        notes.push(k);
        if (k === "user4096" || k === "user1024" || k === "userE3") {
          const key = pool[k][r.int(0, pool[k].length - 1)];
          seg.spki = key.spki;
          subjectKey = { group: k, idx: pool[k].indexOf(key) };
        } else if (k === "user2047") {
          const idx = r.int(0, pool.user2047.length - 1);
          seg.spki = manualSpki(bigToBytes(pool.user2047[idx].modulus, 256));
          subjectKey = { group: "user2047", idx };
        } else {
          const m = r.bytes(256);
          if (k === "fake-top-set") m[0] |= 0x80;
          if (k === "fake-top-clear") m[0] &= 0x7f;
          if (k === "fake-small") m.fill(0, 0, r.int(1, 128));
          seg.spki = manualSpki(m);
          subjectKey = null;
        }
        tbs = assemble(seg);
        break;
      }
      case "serial": {
        const k = r.pick(["len0", "len21", "len20", "len1", "zero", "lead00", "neg", "long-tag"]);
        notes.push(k);
        const v = { len0: Buffer.alloc(0), len21: r.bytes(21), len20: r.bytes(20), len1: r.bytes(1), zero: Buffer.from([0]),
          lead00: Buffer.concat([Buffer.alloc(r.int(1, 3)), r.bytes(r.int(1, 14))]), neg: Buffer.concat([Buffer.from([0x80 | r.int(0, 127)]), r.bytes(r.int(0, 15))]),
          "long-tag": r.bytes(r.int(1, 20)) }[k];
        seg.serial = k === "long-tag" ? Buffer.concat([Buffer.from([0x02, 0x81, v.length]), v]) : Buffer.concat([Buffer.from([0x02, v.length]), v]);
        tbs = assemble(seg);
        break;
      }
      case "names": {
        const k = r.pick(["issuer127", "issuer128", "issuer-81-short", "subject127", "subject128", "subject255", "subject256", "subject-80", "subject-81-short", "subject-82-short", "subject0", "issuer0"]);
        notes.push(k);
        const raw = (n) => r.bytes(n);
        if (k === "issuer127") seg.issuer = tlv(0x30, raw(127));
        if (k === "issuer128") seg.issuer = tlv(0x30, raw(128));
        if (k === "issuer0") seg.issuer = tlv(0x30, raw(0));
        if (k === "issuer-81-short") { const n = r.int(0, 127); seg.issuer = Buffer.concat([Buffer.from([0x30, 0x81, n]), raw(n)]); }
        if (k === "subject127") seg.subject = tlv(0x30, raw(127));
        if (k === "subject128") seg.subject = tlv(0x30, raw(128));
        if (k === "subject255") seg.subject = tlv(0x30, raw(255));
        if (k === "subject256") seg.subject = tlv(0x30, raw(256));
        if (k === "subject0") seg.subject = tlv(0x30, raw(0));
        if (k === "subject-80") { const n = r.int(0, 127); seg.subject = Buffer.concat([Buffer.from([0x30, 0x80]), raw(n)]); }
        if (k === "subject-81-short") { const n = r.int(0, 127); seg.subject = Buffer.concat([Buffer.from([0x30, 0x81, n]), raw(n)]); }
        if (k === "subject-82-short") { const n = r.int(0, 255); seg.subject = Buffer.concat([Buffer.from([0x30, 0x82, 0, n]), raw(n)]); }
        tbs = assemble(seg);
        break;
      }
      case "total-length": {
        const target = r.pick([MAX_SIGNED_LEN - 1, MAX_SIGNED_LEN, MAX_SIGNED_LEN + 1, MAX_SIGNED_LEN + 2, 1535, 1536, r.int(1400, 1536)]);
        padTo(r, seg, target);
        tbs = assemble(seg);
        notes.push(`len=${tbs.length}`);
        break;
      }
      case "decoy": {
        const other = pool.user2048[r.int(0, pool.user2048.length - 1)];
        const decoy = r.bool() ? other.spki : Buffer.concat([hx("0282010100"), bigToBytes(other.modulus, 256), EXPONENT]);
        seg.trailing.splice(r.int(0, seg.trailing.length), 0, tlv(0x30, Buffer.concat([tlv(0x06, hx("2b0601040182")), tlv(0x04, decoy)])));
        if (r.bool(0.3)) seg.issuer = tlv(0x30, Buffer.concat([hx("0282010100"), r.bytes(r.int(0, 100))]).subarray(0, 127));
        tbs = assemble(seg);
        break;
      }
      case "keyusage": {
        const k = r.pick(["0780", "0480", "0430", "06c0", "0700", "0380", "0280", "078000", "0781"]);
        notes.push(k);
        const v = hx(k);
        seg.ext[2] = tlv(0x30, Buffer.concat([hx("0603551d0f"), r.bool(0.8) ? hx("0101ff") : Buffer.alloc(0), tlv(0x04, tlv(0x03, v))]));
        tbs = assemble(seg);
        break;
      }
      case "holder": {
        const k = r.pick(["alien", "type02", "rank-mobile", "rank-secondary", "policy-other", "attrs-swapped", "tail5", "tail3", "no-sda", "two-policies"]);
        notes.push(k);
        const h3 = Buffer.from(seg.ext[3]);
        if (k === "alien") h3[55] = 0x09;
        if (k === "type02") h3[55] = 0x02;
        if (k === "policy-other") h3[21] = r.pick([1, 2, 4, 0x83]);
        let ext3 = h3;
        const tail = h3.subarray(71);
        const sdaWith = (attrs) => tlv(0x30, Buffer.concat([hx("0603551d09"), tlv(0x04, tlv(0x30, Buffer.concat(attrs)))]));
        const subjType = hx("3015060760867601640201310a06086086760164030101");
        const tailAttr = (t) => tlv(0x30, Buffer.concat([hx("060760867601640233"), tlv(0x31, tlv(0x0c, t))]));
        const rank = (s) => tlv(0x30, Buffer.concat([hx("060760867601640202"), tlv(0x31, tlv(0x13, Buffer.from(s)))]));
        if (k === "rank-mobile") ext3 = Buffer.concat([CERT_POLICIES, sdaWith([subjType, tailAttr(tail), rank("mobile")])]);
        if (k === "rank-secondary") ext3 = Buffer.concat([CERT_POLICIES, sdaWith([subjType, tailAttr(tail), rank("secondary")])]);
        if (k === "attrs-swapped") ext3 = Buffer.concat([CERT_POLICIES, sdaWith([tailAttr(tail), subjType])]);
        if (k === "tail5") ext3 = Buffer.concat([CERT_POLICIES, sdaWith([subjType, tailAttr(r.bytes(5))])]);
        if (k === "tail3") ext3 = Buffer.concat([CERT_POLICIES, sdaWith([subjType, tailAttr(r.bytes(3))])]);
        if (k === "no-sda") ext3 = CERT_POLICIES;
        if (k === "two-policies") {
          const pol = (last) => tlv(0x30, tlv(0x06, Buffer.concat([hx("608676650003"), Buffer.from([last])])));
          const cp = tlv(0x30, Buffer.concat([hx("0603551d20"), tlv(0x04, tlv(0x30, Buffer.concat([pol(3), pol(r.int(0, 9))])))]));
          ext3 = Buffer.concat([cp, sdaWith([subjType, tailAttr(tail)])]);
        }
        seg.ext[3] = ext3;
        tbs = assemble(seg);
        break;
      }
      case "stack": {
        const n = r.int(2, 3);
        for (let i = 0; i < n; i++) {
          const m2 = r.weighted(CHAIN_MUTATIONS.filter(([, x]) => x !== "stack" && x !== "none"));
          apply(m2);
        }
        break;
      }
      default: throw new Error(m);
    }
  };
  apply(mutation);

  // Signature over the final bytes by the CA (or the override).
  let signature;
  const stdSig = signStd(ca, tbs);
  let sigLimbsMut = null;
  signature = resign ? stdSig : signStd(ca, preFlip);
  if (sigOverride) {
    const n = ca.modulus;
    switch (sigOverride.kind) {
      case "plus-n": signature = stdSig + n; break;
      case "plus-2n": signature = stdSig + 2n * n; break;
      case "flip": signature = stdSig ^ (1n << BigInt(r.int(0, bits - 1))); break;
      case "random": signature = sigOverride.aux % n; break;
      case "zero": signature = 0n; break;
      case "one": signature = 1n; break;
      case "n-1": signature = n - 1n; break;
      case "other-ca": signature = signStd(pool[caGroup][(caIdx + 1) % pool[caGroup].length], tbs); break;
      case "prefix": signature = signStd(ca, tbs.subarray(0, tbs.length - 1)); break;
      case "raw": signature = signRaw(ca, sigOverride.em) ?? stdSig ^ 1n; break;
      case "noncanon": sigLimbsMut = { i: r.int(0, (bits === 2048 ? 17 : 34) - 1), m: BigInt(r.pick([1, 1, 2, 255])) }; break;
    }
  }
  const garbage = r.bool(0.3);
  return {
    family: "chain", bits, caRef: { group: caGroup, idx: caIdx }, tbs, signature, sigLimbsMut, sigNote, issuerModulus, now,
    smtPlan, subjectKey, mutation: notes.join(" "), garbage, garbageSeed: r.int(0, 2 ** 31), pkBlind: r.big(240) + 1n,
  };
}


// ---------------------------------------------------------------- signature cases
const SIG_MUTATIONS = [
  [16, "none"],
  [4, "msg-flip-after"],
  [4, "sig-flip"],
  [3, "sig-plus-n"],
  [3, "wrong-key"],
  [3, "modulus-flip"],
  [8, "em"],
  [4, "noncanon"],
  [2, "other-message"],
  [2, "length"],
  [3, "key-size"],
  [2, "e3"],
  [2, "sig-special"],
];

export function genMessage(r, kind) {
  const m = Buffer.from(Array.from({ length: 31 }, () => r.weighted([[3, () => r.int(0x20, 0x7e)], [1, () => r.int(0, 255)]])()));
  const first = kind === "scope" ? r.pick([...Array.from({ length: 26 }, (_, i) => 0x61 + i), 0x53])
    : kind === "code" ? r.pick(Array.from({ length: 26 }, (_, i) => 0x41 + i).filter((x) => x !== 0x53))
      : r.int(0, 255);
  m[0] = first;
  return m;
}

/**
 * A signature case: `position` (scope / code) decides which Noir part runs and
 * where the card proof puts it. Returns { family: "sig", position, keyRef,
 * modulus, message, signature, sigLimbsMut, mutation, pkBlind, challenge }.
 */
export function genSig(r, pool, mutation = r.weighted(SIG_MUTATIONS)) {
  const position = r.bool() ? "scope" : "code";
  const msgKind = r.weighted([[8, position], [1, position === "scope" ? "code" : "scope"], [1, "any"]]);
  let keyRef = { group: "user2048", idx: r.int(0, pool.user2048.length - 1) };
  let key = pool[keyRef.group][keyRef.idx];
  let message = genMessage(r, msgKind);
  let modulus = key.modulus;
  let signature = signStd(key, message);
  let sigLimbsMut = null;
  const notes = [mutation];
  switch (mutation) {
    case "none": break;
    case "msg-flip-after": { const i = r.int(0, 30); message = Buffer.from(message); message[i] ^= r.int(1, 255); notes.push(`@${i}`); break; }
    case "sig-flip": signature ^= 1n << BigInt(r.int(0, 2047)); break;
    case "sig-plus-n": signature += modulus * BigInt(r.int(1, 3)); break;
    case "wrong-key": signature = signStd(pool.user2048[(keyRef.idx + 1) % pool.user2048.length], message); break;
    case "modulus-flip": modulus ^= 1n << BigInt(r.int(0, 2046)); break;
    case "em": {
      const b = badEm(r, message, 256);
      notes.push(b.kind);
      signature = signRaw(key, b.em) ?? signature ^ 1n;
      break;
    }
    case "noncanon": sigLimbsMut = { i: r.int(0, 16), m: BigInt(r.pick([1, 1, 2, 255])) }; break;
    case "other-message": signature = signStd(key, genMessage(r, msgKind)); break;
    case "length": {
      const n = r.pick([0, 1, 30, 32, 33, 55, 56, 64, 100]);
      message = Buffer.concat([message, r.bytes(Math.max(0, n - 31))]).subarray(0, n);
      signature = signStd(key, message);
      notes.push(`len=${n}`);
      break;
    }
    case "key-size": {
      const g = r.pick(["user2047", "user1024"]);
      keyRef = { group: g, idx: r.int(0, pool[g].length - 1) };
      key = pool[g][keyRef.idx];
      modulus = key.modulus;
      signature = signStd(key, message);
      notes.push(g);
      break;
    }
    case "e3": {
      keyRef = { group: "userE3", idx: r.int(0, pool.userE3.length - 1) };
      key = pool.userE3[keyRef.idx];
      modulus = key.modulus;
      signature = signStd(key, message);
      break;
    }
    case "sig-special": signature = r.pick([0n, 1n, modulus - 1n, modulus]); break;
  }
  return { family: "sig", position, msgKind, keyRef, modulus, message, signature, sigLimbsMut, mutation: notes.join(" "),
    pkBlind: r.big(240) + 1n, challenge: r.big(200), chainSeed: r.int(0, 2 ** 31) };
}

// ---------------------------------------------------------------- whole card proofs (Noir only)
const CARD_MUTATIONS = [
  [6, "none"], [3, "swap-sigs"], [2, "same-message"], [3, "scope-noncanon"], [3, "other-key-sigs"],
  [3, "garbage-after-len"], [3, "card-redc"], [2, "issuer-redc"], [2, "scope-plus-n"], [2, "code-other-challenge"],
  [2, "kind-swap"], [2, "tbs-len-short"], [2, "tbs-len-long"], [4, "truncate-keep-tail"],
];

/**
 * `extra` is a second random stream of the same case. The mutation
 * `scope-uppercase` was added after the first campaign (its report found whole
 * card proofs with a scope string of the wrong kind thinly covered: only
 * `kind-swap`, which swaps both messages). It is drawn from `extra` and takes
 * half of the cases that had no mutation, so every other case of a seed is
 * still the case it was.
 *
 * scope-uppercase: the scope string starts with an uppercase letter and the
 * card signed it; the declaration code is as usual. Only `S` is a scope
 * string.
 */
export function genCard(r, pool, mutation = r.weighted(CARD_MUTATIONS), extra = null) {
  const chain = genChain(r, pool, "none");
  if (mutation === "none" && extra?.bool(0.5)) mutation = "scope-uppercase";
  return { family: "card", chain, mutation, scope: genMessage(r, "scope"), code: genMessage(r, "code"), aux: r.big(2048), auxInt: r.int(0, 2 ** 31) };
}

export function genCase(seed, index, pool, only, mutation) {
  const r = rngFor(seed, index);
  const family = only ?? r.weighted([[60, "chain"], [30, "sig"], [10, "card"]]);
  const c = family === "chain" ? genChain(r, pool, mutation) : family === "sig" ? genSig(r, pool, mutation)
    : genCard(r, pool, mutation, mutation === undefined ? rngFor(seed, index, "scope-uppercase") : null);
  c.index = index;
  c.seed = seed;
  return c;
}
