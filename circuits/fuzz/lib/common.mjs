// Shared pieces of the randomized differential test: a seeded PRNG, the key
// pool, raw RSA, the circom side's Poseidon over secq256r1, limb helpers.
// Everything here is synthetic; no real certificate or key is involved.
import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FUZZ = join(dirname(fileURLToPath(import.meta.url)), "..");
// circuits/: its compiled circuits (target/), its packages (node_modules/),
// its test cases; and the circom build of build-circom.sh, as the tests use it.
export const NOIR_ROOT = join(FUZZ, "..");
export const CIRCOM_BUILD = process.env.ZKID_CIRCOM_BUILD
  ?? join(NOIR_ROOT, ".zkID", "wallet-unit-poc", "circom", "build");
export const CIRCOM_SRC = process.env.ZKID_CIRCOM_SRC ?? join(CIRCOM_BUILD, "..", "circuits");

// ---------------------------------------------------------------- PRNG
/** sfc32 seeded from sha256 of the parts: every case has its own stream. */
export function rngFor(...parts) {
  const h = createHash("sha256").update(parts.join(":")).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    const t0 = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const t = (t0 + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  const r = {
    float: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
    bytes: (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256))),
    big: (bits) => {
      let x = 0n;
      for (let i = 0; i < bits; i += 16) x = (x << 16n) | BigInt(Math.floor(next() * 65536));
      return x & ((1n << BigInt(bits)) - 1n);
    },
    weighted: (table) => {
      const total = table.reduce((s, [w]) => s + w, 0);
      let x = next() * total;
      for (const [w, v] of table) if ((x -= w) < 0) return v;
      return table[table.length - 1][1];
    },
  };
  return r;
}

// ---------------------------------------------------------------- keys
const POOL_SPEC = {
  user2048: [32, 2048, 65537],
  ca2048: [4, 2048, 65537],
  ca4096: [2, 4096, 65537],
  user2047: [2, 2047, 65537],
  user1024: [2, 1024, 65537],
  user4096: [1, 4096, 65537],
  userE3: [2, 2048, 3],
};

function keyFromPem(pem) {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  const modulus = BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex"));
  const e = BigInt("0x" + Buffer.from(jwk.e, "base64url").toString("hex"));
  const d = BigInt("0x" + Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("hex"));
  return { privateKey, modulus, e, d, bits: modulus.toString(2).length, spki: publicKey.export({ format: "der", type: "spki" }) };
}

/** Loads fuzz/keys/pool.json, generating it once if missing. Fixed afterwards. */
export function loadPool() {
  const file = join(FUZZ, "keys", "pool.json");
  if (!existsSync(file)) {
    const out = {};
    for (const [name, [count, bits, e]] of Object.entries(POOL_SPEC)) {
      out[name] = Array.from({ length: count }, () =>
        generateKeyPairSync("rsa", { modulusLength: bits, publicExponent: e })
          .privateKey.export({ format: "pem", type: "pkcs8" }));
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 1));
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const pool = {};
  for (const [name, pems] of Object.entries(raw)) pool[name] = pems.map(keyFromPem);
  return pool;
}

// ---------------------------------------------------------------- bigint / RSA
export function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
export const bytesToBig = (buf) => (buf.length ? BigInt("0x" + Buffer.from(buf).toString("hex")) : 0n);
export function bigToBytes(x, len) {
  const h = x.toString(16).padStart(len * 2, "0");
  if (h.length > len * 2) throw new Error("does not fit");
  return Buffer.from(h, "hex");
}
export const sha256 = (data) => createHash("sha256").update(data).digest();
export const DIGEST_INFO_SHA256 = Buffer.from("3031300d060960864801650304020105000420", "hex");
export const byteLen = (n) => Math.ceil(n.toString(2).length / 8);

/** EMSA-PKCS1-v1_5 encoding with SHA-256 for a modulus of `k` bytes. */
export function emsa(message, k) {
  const t = Buffer.concat([DIGEST_INFO_SHA256, sha256(message)]);
  return Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(k - t.length - 3, 0xff), Buffer.from([0]), t]);
}

/** Standard signature (node's own PKCS#1 v1.5), as an integer. */
export function signStd(key, message) {
  if (key.e !== 65537n && key.e !== 3n) throw new Error("e");
  const s = sign("sha256", message, { key: key.privateKey, padding: constants.RSA_PKCS1_PADDING });
  return bytesToBig(s);
}

/** Raw RSA: EM^d mod n for an arbitrary encoded message (an integer < n). */
export function signRaw(key, em) {
  const k = byteLen(key.modulus);
  const x = typeof em === "bigint" ? em : bytesToBig(em);
  if (x >= key.modulus) return null;
  try {
    return bytesToBig(privateEncrypt({ key: key.privateKey, padding: constants.RSA_NO_PADDING }, bigToBytes(x, k)));
  } catch {
    return modpow(x, key.d, key.modulus);
  }
}

/** Reference verification, exactly RSASSA-PKCS1-v1_5 / SHA-256 / e = 65537. */
export function rsaVerify(modulus, signature, message) {
  if (signature < 0n || signature >= modulus) return false;
  const k = byteLen(modulus);
  return modpow(signature, 65537n, modulus) === bytesToBig(emsa(message, k));
}

export function limbs(value, bits, count) {
  const mask = (1n << BigInt(bits)) - 1n;
  return Array.from({ length: count }, (_, i) => (value >> BigInt(bits * i)) & mask);
}

// ---------------------------------------------------------------- PoseidonP256 (circom side)
let P256 = null;
/** The circom circuit's Poseidon, parsed from its constants file, over `prime`. */
export function loadPoseidonP256(prime) {
  if (P256) return P256;
  const src = readFileSync(join(CIRCOM_SRC, "components", "poseidonP256Constants.circom"), "utf8");
  const grab = (fn) => {
    const body = src.slice(src.indexOf(`function ${fn}()`));
    const end = body.indexOf("\n}");
    return body.slice(0, end);
  };
  const vec = (fn) => {
    const out = [];
    for (const m of grab(fn).matchAll(/C\[(\d+)\] = (\d+);/g)) out[+m[1]] = BigInt(m[2]);
    return out;
  };
  const mat = (fn) => {
    const out = [];
    for (const m of grab(fn).matchAll(/M\[(\d+)\]\[(\d+)\] = (\d+);/g)) (out[+m[1]] ??= [])[+m[2]] = BigInt(m[3]);
    return out;
  };
  const params = { 3: { C: vec("POSEIDON_P256_C_3"), M: mat("POSEIDON_P256_M_3"), RP: 57 }, 4: { C: vec("POSEIDON_P256_C_4"), M: mat("POSEIDON_P256_M_4"), RP: 56 } };
  const p = prime;
  const pow5 = (x) => { const x2 = (x * x) % p; return (((x2 * x2) % p) * x) % p; };
  const hash = (inputs) => {
    const t = inputs.length + 1;
    const { C, M, RP } = params[t];
    let state = [0n, ...inputs.map((x) => ((x % p) + p) % p)];
    const total = 8 + RP;
    for (let r = 0; r < total; r++) {
      const full = r < 4 || r >= 4 + RP;
      const s = state.map((x, j) => {
        const y = (x + C[r * t + j]) % p;
        return full || j === 0 ? pow5(y) : y;
      });
      state = M.map((row) => row.reduce((acc, m, j) => (acc + m * s[j]) % p, 0n));
    }
    return state[0];
  };
  P256 = { hash2: (a, b) => hash([a, b]), hash3: (a, b, c) => hash([a, b, c]), prime };
  return P256;
}

export const chunked = (h, inputs) => inputs.reduce((s, x) => h.hash2(s, x), 0n);
